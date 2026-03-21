import * as vscode from "vscode";
import { Logger, LogLevel } from "../infrastructure/logger/logger";

/** Priority levels for queued operations. Higher value = higher priority. */
export enum QueuePriority {
  BACKGROUND = 0,
  SCHEDULED = 1,
  USER = 2,
}

/** Status of a queued item. */
export enum QueueItemStatus {
  WAITING = "waiting",
  RUNNING = "running",
  CANCELLED = "cancelled",
}

/** A queued operation waiting for a concurrency slot. */
export interface QueueItem<T = unknown> {
  readonly id: string;
  readonly label: string;
  readonly priority: QueuePriority;
  readonly enqueuedAt: number;
  status: QueueItemStatus;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/** Snapshot exposed for UI / status bar. */
export interface QueueSnapshot {
  running: number;
  waiting: number;
  maxConcurrent: number;
}

/** Time (ms) after which a waiting item gets its priority boosted by 1 level. */
const STARVATION_BOOST_MS = 60_000;

/** How often we check for starvation (ms). */
const STARVATION_CHECK_INTERVAL_MS = 15_000;

/** Hard cap on waiting queue depth to prevent unbounded memory growth. */
const MAX_QUEUE_DEPTH = 50;

/**
 * ConcurrencyQueueService
 *
 * Controls the maximum number of concurrent agent operations (streams).
 * Requests that exceed the limit are queued in priority-aware FIFO order.
 * Supports cancellation, starvation prevention, and status bar feedback.
 */
export class ConcurrencyQueueService implements vscode.Disposable {
  private static instance: ConcurrencyQueueService | null = null;

  private readonly logger: Logger;

  /** Items actively consuming a concurrency slot. */
  private readonly running = new Map<string, QueueItem>();

  /** Items waiting for a slot, kept sorted by effective priority. */
  private readonly waiting: QueueItem[] = [];

  /** Status bar item showing queue state. */
  private statusBarItem: vscode.StatusBarItem | null = null;

  /** Timer for starvation prevention. */
  private starvationTimer: ReturnType<typeof setInterval> | null = null;

  /** Config change listener. */
  private configDisposable: vscode.Disposable | null = null;

  /** Event emitter for queue state changes. */
  private readonly _onDidChange = new vscode.EventEmitter<QueueSnapshot>();
  readonly onDidChange: vscode.Event<QueueSnapshot> = this._onDidChange.event;

  private _maxConcurrent: number;
  private disposed = false;

  private constructor() {
    this.logger = Logger.initialize("ConcurrencyQueueService", {
      minLevel: LogLevel.DEBUG,
      enableConsole: true,
      enableFile: true,
      enableTelemetry: true,
    });

    this._maxConcurrent = this.readMaxConcurrent();

    // React to setting changes
    this.configDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codebuddy.agent.maxConcurrentStreams")) {
        const prev = this._maxConcurrent;
        this._maxConcurrent = this.readMaxConcurrent();
        this.logger.info(
          `maxConcurrentStreams changed: ${prev} → ${this._maxConcurrent}`,
        );
        // If limit increased, drain waiting items
        this.drain();
      }
    });

    // Starvation prevention timer
    this.starvationTimer = setInterval(
      () => this.boostStarvedItems(),
      STARVATION_CHECK_INTERVAL_MS,
    );

    this.logger.info(
      `ConcurrencyQueueService initialized (max=${this._maxConcurrent})`,
    );
  }

  static getInstance(): ConcurrencyQueueService {
    return (ConcurrencyQueueService.instance ??= new ConcurrencyQueueService());
  }

  /** Reset singleton — for tests only. */
  static resetInstance(): void {
    if (ConcurrencyQueueService.instance) {
      ConcurrencyQueueService.instance.dispose();
      ConcurrencyQueueService.instance = null;
    }
  }

  get maxConcurrent(): number {
    return this._maxConcurrent;
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Acquire a concurrency slot. Resolves immediately if a slot is available,
   * otherwise the caller awaits until a slot opens (or the item is cancelled).
   *
   * @param options.signal - AbortSignal for cooperative cancellation.
   * @param options.timeoutMs - Hard deadline (ms) for waiting in the queue.
   * @returns A release function that MUST be called when the operation finishes.
   */
  async acquire(
    id: string,
    label: string,
    priority: QueuePriority = QueuePriority.USER,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<() => void> {
    if (this.disposed) {
      throw new Error("ConcurrencyQueueService is disposed");
    }

    // Prevent duplicate IDs — callers must use unique identifiers
    if (this.running.has(id) || this.waiting.some((w) => w.id === id)) {
      throw new Error(
        `ConcurrencyQueue: duplicate id "${id}". ` +
          `Use a unique id per acquire call.`,
      );
    }

    // Fast path: slot available
    if (this.running.size < this._maxConcurrent) {
      const item: QueueItem = {
        id,
        label,
        priority,
        enqueuedAt: Date.now(),
        status: QueueItemStatus.RUNNING,
        resolve: () => {},
        reject: () => {},
      };
      this.running.set(id, item);
      this.logger.debug(
        `Slot acquired immediately: "${label}" (${this.running.size}/${this._maxConcurrent})`,
      );
      this.fireChange();
      return this.createReleaser(id);
    }

    // Back-pressure: reject if queue is full
    if (this.waiting.length >= MAX_QUEUE_DEPTH) {
      throw new ConcurrencyQueueFullError(
        `Queue is full (${MAX_QUEUE_DEPTH} items waiting). ` +
          `Try again later or cancel pending requests.`,
      );
    }

    // Slow path: queue and wait
    this.logger.info(
      `Queueing "${label}" (priority=${QueuePriority[priority]}, waiting=${this.waiting.length})`,
    );

    // Build a unified abort signal from caller signal + timeout
    const signals: AbortSignal[] = [];
    if (options?.signal) signals.push(options.signal);
    if (options?.timeoutMs != null) {
      signals.push(AbortSignal.timeout(options.timeoutMs));
    }
    const signal =
      signals.length > 1
        ? AbortSignal.any(signals)
        : signals.length === 1
          ? signals[0]
          : undefined;

    return new Promise<() => void>((resolve, reject) => {
      const item: QueueItem = {
        id,
        label,
        priority,
        enqueuedAt: Date.now(),
        status: QueueItemStatus.WAITING,
        resolve: () => resolve(this.createReleaser(id)),
        reject,
      };

      this.insertSorted(item);
      this.fireChange();

      // Wire up abort/timeout if provided
      if (signal) {
        const onAbort = () => {
          if (this.cancel(id)) return; // cancel() already rejects
          // If cancel() returns false, the item was already drained (running)
          // — nothing to do, the slot was granted.
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
    });
  }

  /**
   * Cancel a queued (waiting) operation by id. Returns true if found and cancelled.
   * Running operations are NOT cancelled here — use the agent's cancelStream instead.
   */
  cancel(id: string): boolean {
    const idx = this.waiting.findIndex((item) => item.id === id);
    if (idx === -1) return false;

    const [item] = this.waiting.splice(idx, 1);
    item.status = QueueItemStatus.CANCELLED;
    item.reject(new ConcurrencyQueueCancelledError(id));
    this.logger.info(`Cancelled queued item: "${item.label}"`);
    this.fireChange();
    return true;
  }

  /**
   * Cancel all waiting items.
   */
  cancelAllWaiting(): number {
    const count = this.waiting.length;
    for (const item of this.waiting.splice(0)) {
      item.status = QueueItemStatus.CANCELLED;
      item.reject(new ConcurrencyQueueCancelledError(item.id));
    }
    if (count > 0) {
      this.logger.info(`Cancelled ${count} queued items`);
      this.fireChange();
    }
    return count;
  }

  /** Current snapshot of running / waiting counts. */
  getSnapshot(): QueueSnapshot {
    return {
      running: this.running.size,
      waiting: this.waiting.length,
      maxConcurrent: this._maxConcurrent,
    };
  }

  /** List of ids currently waiting. */
  getWaitingIds(): ReadonlyArray<{ id: string; label: string }> {
    return this.waiting.map((w) => ({ id: w.id, label: w.label }));
  }

  // ── Status bar ──────────────────────────────────────────────

  /**
   * Create and attach the status bar item. Call once during extension activation.
   */
  initStatusBar(context: vscode.ExtensionContext): void {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      -100, // low absolute priority — placed after higher-priority left-aligned items
    );
    this.statusBarItem.command = "codebuddy.concurrencyQueue.showStatus";
    context.subscriptions.push(this.statusBarItem);
    this.updateStatusBar();
  }

  // ── Internals ───────────────────────────────────────────────

  private readMaxConcurrent(): number {
    const raw = vscode.workspace
      .getConfiguration("codebuddy.agent")
      .get<number>("maxConcurrentStreams", 3);
    // Clamp to [1, 10]
    return Math.max(1, Math.min(10, Math.floor(raw)));
  }

  /** Insert into the waiting list, maintaining descending-priority + FIFO order. */
  private insertSorted(item: QueueItem): void {
    // Find the first item with strictly lower priority
    let i = 0;
    while (
      i < this.waiting.length &&
      this.waiting[i].priority >= item.priority
    ) {
      i++;
    }
    this.waiting.splice(i, 0, item);
  }

  /** Create a release callback that removes the item from running and drains. */
  private createReleaser(id: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running.delete(id);
      this.logger.debug(
        `Slot released: ${id} (${this.running.size}/${this._maxConcurrent})`,
      );
      this.drain();
      this.fireChange();
    };
  }

  /** Move waiting items into running slots. */
  private drain(): void {
    while (this.waiting.length > 0 && this.running.size < this._maxConcurrent) {
      const item = this.waiting.shift()!;

      // Skip cancelled items that are still in the array
      if (item.status === QueueItemStatus.CANCELLED) continue;

      item.status = QueueItemStatus.RUNNING;
      this.running.set(item.id, item);
      this.logger.info(
        `Slot granted to queued item: "${item.label}" (${this.running.size}/${this._maxConcurrent})`,
      );
      item.resolve(undefined);
    }
    this.fireChange();
  }

  /** Boost priority of items that have waited too long. */
  private boostStarvedItems(): void {
    const now = Date.now();
    let reordered = false;
    for (const item of this.waiting) {
      if (item.status !== QueueItemStatus.WAITING) continue;
      const waited = now - item.enqueuedAt;
      if (waited >= STARVATION_BOOST_MS && item.priority < QueuePriority.USER) {
        // Boost priority by 1 level (mutate the readonly via cast — internal only)
        (item as { priority: QueuePriority }).priority = Math.min(
          item.priority + 1,
          QueuePriority.USER,
        ) as QueuePriority;
        reordered = true;
        this.logger.info(
          `Starvation boost: "${item.label}" → priority=${QueuePriority[item.priority]}`,
        );
      }
    }
    if (reordered) {
      // Stable sort: priority descending, then FIFO by enqueuedAt
      this.waiting.sort((a, b) =>
        b.priority !== a.priority
          ? b.priority - a.priority
          : a.enqueuedAt - b.enqueuedAt,
      );
    }
  }

  private fireChange(): void {
    this.updateStatusBar();
    this._onDidChange.fire(this.getSnapshot());
  }

  private updateStatusBar(): void {
    if (!this.statusBarItem) return;

    const snap = this.getSnapshot();
    if (snap.running === 0 && snap.waiting === 0) {
      this.statusBarItem.hide();
      return;
    }

    if (snap.waiting > 0) {
      this.statusBarItem.text = `$(loading~spin) ${snap.running} running, ${snap.waiting} queued`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
    } else {
      this.statusBarItem.text = `$(sync~spin) ${snap.running} running`;
      this.statusBarItem.backgroundColor = undefined;
    }
    this.statusBarItem.tooltip = `CodeBuddy Agent Queue\n${snap.running}/${snap.maxConcurrent} slots in use\n${snap.waiting} waiting\n\nClick for details`;
    this.statusBarItem.show();
  }

  // ── Dispose ─────────────────────────────────────────────────

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.starvationTimer) {
      clearInterval(this.starvationTimer);
      this.starvationTimer = null;
    }

    this.configDisposable?.dispose();
    this.configDisposable = null;

    // Reject all waiting items
    this.cancelAllWaiting();

    // Clear running (don't reject — they're already running)
    this.running.clear();

    this.statusBarItem?.dispose();
    this._onDidChange.dispose();

    this.logger.info("ConcurrencyQueueService disposed");
  }
}

/**
 * Error thrown when a queued operation is cancelled before it starts.
 */
export class ConcurrencyQueueCancelledError extends Error {
  readonly itemId: string;
  constructor(itemId: string) {
    super(`Queued operation "${itemId}" was cancelled`);
    this.name = "ConcurrencyQueueCancelledError";
    this.itemId = itemId;
  }
}

/**
 * Error thrown when the queue is full and cannot accept more items.
 */
export class ConcurrencyQueueFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyQueueFullError";
  }
}
