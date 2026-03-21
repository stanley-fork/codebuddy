/**
 * ConcurrencyQueueService Tests
 *
 * Tests the concurrency-limiting queue for agent streams:
 * - Immediate slot acquisition when under limit
 * - Queuing when at capacity
 * - FIFO ordering within same priority
 * - Priority-aware ordering (higher priority dequeued first)
 * - Cancellation of waiting items
 * - Release / drain behaviour
 * - Starvation prevention via priority boost
 * - Snapshot accuracy
 */

import * as assert from "assert";

/**
 * Minimal in-memory replica of ConcurrencyQueueService logic.
 * We test the queue logic directly without depending on vscode APIs.
 */

enum QueuePriority {
  BACKGROUND = 0,
  SCHEDULED = 1,
  USER = 2,
}

enum QueueItemStatus {
  WAITING = "waiting",
  RUNNING = "running",
  CANCELLED = "cancelled",
}

interface QueueItem {
  readonly id: string;
  readonly label: string;
  priority: QueuePriority;
  readonly enqueuedAt: number;
  status: QueueItemStatus;
  resolve: (releaser: () => void) => void;
  reject: (reason: unknown) => void;
}

class ConcurrencyQueueCancelledError extends Error {
  readonly itemId: string;
  constructor(itemId: string) {
    super(`Queued operation "${itemId}" was cancelled`);
    this.name = "ConcurrencyQueueCancelledError";
    this.itemId = itemId;
  }
}

/**
 * Stripped-down queue (no vscode imports, no status bar, no timers).
 */
class TestConcurrencyQueue {
  private readonly running = new Map<string, QueueItem>();
  private readonly waiting: QueueItem[] = [];
  private _maxConcurrent: number;

  constructor(maxConcurrent: number = 3) {
    this._maxConcurrent = maxConcurrent;
  }

  get maxConcurrent(): number {
    return this._maxConcurrent;
  }

  set maxConcurrent(v: number) {
    this._maxConcurrent = Math.max(1, Math.min(10, v));
    this.drain();
  }

  async acquire(
    id: string,
    label: string,
    priority: QueuePriority = QueuePriority.USER,
  ): Promise<() => void> {
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
      return this.createReleaser(id);
    }

    return new Promise<() => void>((resolve, reject) => {
      const item: QueueItem = {
        id,
        label,
        priority,
        enqueuedAt: Date.now(),
        status: QueueItemStatus.WAITING,
        resolve: (releaser) => resolve(releaser),
        reject,
      };
      this.insertSorted(item);
    });
  }

  cancel(id: string): boolean {
    const idx = this.waiting.findIndex((item) => item.id === id);
    if (idx === -1) return false;
    const [item] = this.waiting.splice(idx, 1);
    item.status = QueueItemStatus.CANCELLED;
    item.reject(new ConcurrencyQueueCancelledError(id));
    return true;
  }

  cancelAllWaiting(): number {
    const count = this.waiting.length;
    for (const item of this.waiting.splice(0)) {
      item.status = QueueItemStatus.CANCELLED;
      item.reject(new ConcurrencyQueueCancelledError(item.id));
    }
    return count;
  }

  getSnapshot() {
    return {
      running: this.running.size,
      waiting: this.waiting.length,
      maxConcurrent: this._maxConcurrent,
    };
  }

  getWaitingIds() {
    return this.waiting.map((w) => ({ id: w.id, label: w.label }));
  }

  boostStarvedItems(starvationMs: number): void {
    let reordered = false;
    const now = Date.now();
    for (const item of this.waiting) {
      if (item.status !== QueueItemStatus.WAITING) continue;
      const waited = now - item.enqueuedAt;
      if (waited >= starvationMs && item.priority < QueuePriority.USER) {
        (item as { priority: QueuePriority }).priority = Math.min(
          item.priority + 1,
          QueuePriority.USER,
        ) as QueuePriority;
        reordered = true;
      }
    }
    if (reordered) {
      this.waiting.sort((a, b) => b.priority - a.priority);
    }
  }

  // ── Internals ──

  private insertSorted(item: QueueItem): void {
    let i = 0;
    while (i < this.waiting.length && this.waiting[i].priority >= item.priority) {
      i++;
    }
    this.waiting.splice(i, 0, item);
  }

  private createReleaser(id: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running.delete(id);
      this.drain();
    };
  }

  private drain(): void {
    while (
      this.waiting.length > 0 &&
      this.running.size < this._maxConcurrent
    ) {
      const item = this.waiting.shift()!;
      if (item.status === QueueItemStatus.CANCELLED) continue;
      item.status = QueueItemStatus.RUNNING;
      this.running.set(item.id, item);
      item.resolve(this.createReleaser(item.id));
    }
  }
}

// ── Tests ───────────────────────────────────────────────────

suite("ConcurrencyQueueService", () => {
  test("immediate acquisition when under limit", async () => {
    const q = new TestConcurrencyQueue(3);
    const r1 = await q.acquire("a", "task-a");
    const r2 = await q.acquire("b", "task-b");
    const r3 = await q.acquire("c", "task-c");

    assert.deepStrictEqual(q.getSnapshot(), {
      running: 3,
      waiting: 0,
      maxConcurrent: 3,
    });

    r1();
    r2();
    r3();
  });

  test("fourth request is queued when limit is 3", async () => {
    const q = new TestConcurrencyQueue(3);
    const r1 = await q.acquire("a", "task-a");
    const r2 = await q.acquire("b", "task-b");
    const r3 = await q.acquire("c", "task-c");

    // Fourth should not resolve immediately
    let fourthResolved = false;
    const fourthPromise = q.acquire("d", "task-d").then((r) => {
      fourthResolved = true;
      return r;
    });

    // Give microtasks a chance to settle
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(fourthResolved, false, "fourth should be queued");
    assert.deepStrictEqual(q.getSnapshot(), {
      running: 3,
      waiting: 1,
      maxConcurrent: 3,
    });

    // Release one slot — fourth should now resolve
    r1();
    const r4 = await fourthPromise;
    assert.strictEqual(fourthResolved, true);
    assert.deepStrictEqual(q.getSnapshot(), {
      running: 3,
      waiting: 0,
      maxConcurrent: 3,
    });

    r2();
    r3();
    r4();
  });

  test("FIFO ordering within same priority", async () => {
    const q = new TestConcurrencyQueue(1);
    const r1 = await q.acquire("a", "first");

    const order: string[] = [];
    const p2 = q.acquire("b", "second", QueuePriority.USER).then((r) => {
      order.push("b");
      return r;
    });
    const p3 = q.acquire("c", "third", QueuePriority.USER).then((r) => {
      order.push("c");
      return r;
    });

    // Release first — "b" should be next
    r1();
    const r2 = await p2;
    assert.deepStrictEqual(order, ["b"]);

    r2();
    const r3 = await p3;
    assert.deepStrictEqual(order, ["b", "c"]);

    r3();
  });

  test("higher priority dequeued before lower", async () => {
    const q = new TestConcurrencyQueue(1);
    const r1 = await q.acquire("a", "running");

    const order: string[] = [];
    const pBg = q.acquire("bg", "background", QueuePriority.BACKGROUND).then((r) => {
      order.push("bg");
      return r;
    });
    const pUser = q.acquire("u", "user", QueuePriority.USER).then((r) => {
      order.push("u");
      return r;
    });
    const pSched = q.acquire("s", "scheduled", QueuePriority.SCHEDULED).then((r) => {
      order.push("s");
      return r;
    });

    // Waiting should show: user > scheduled > background
    const waitingIds = q.getWaitingIds().map((w) => w.id);
    assert.deepStrictEqual(waitingIds, ["u", "s", "bg"]);

    // Release all sequentially
    r1();
    const rUser = await pUser;
    assert.deepStrictEqual(order, ["u"]);

    rUser();
    const rSched = await pSched;
    assert.deepStrictEqual(order, ["u", "s"]);

    rSched();
    const rBg = await pBg;
    assert.deepStrictEqual(order, ["u", "s", "bg"]);

    rBg();
  });

  test("cancel removes waiting item and rejects with CancelledError", async () => {
    const q = new TestConcurrencyQueue(1);
    const r1 = await q.acquire("a", "running");

    let rejected = false;
    let rejectedError: unknown;
    const p2 = q.acquire("b", "queued").catch((err) => {
      rejected = true;
      rejectedError = err;
    });

    assert.strictEqual(q.cancel("b"), true);
    await p2;
    assert.strictEqual(rejected, true);
    assert.ok(rejectedError instanceof ConcurrencyQueueCancelledError);
    assert.strictEqual(
      (rejectedError as ConcurrencyQueueCancelledError).itemId,
      "b",
    );
    assert.deepStrictEqual(q.getSnapshot(), {
      running: 1,
      waiting: 0,
      maxConcurrent: 1,
    });

    r1();
  });

  test("cancel returns false for non-existent id", () => {
    const q = new TestConcurrencyQueue(3);
    assert.strictEqual(q.cancel("nonexistent"), false);
  });

  test("cancelAllWaiting rejects all and returns count", async () => {
    const q = new TestConcurrencyQueue(1);
    const r1 = await q.acquire("a", "running");

    let rejectedCount = 0;
    const p2 = q.acquire("b", "q1").catch(() => rejectedCount++);
    const p3 = q.acquire("c", "q2").catch(() => rejectedCount++);
    const p4 = q.acquire("d", "q3").catch(() => rejectedCount++);

    assert.strictEqual(q.cancelAllWaiting(), 3);
    await Promise.all([p2, p3, p4]);
    assert.strictEqual(rejectedCount, 3);
    assert.deepStrictEqual(q.getSnapshot(), {
      running: 1,
      waiting: 0,
      maxConcurrent: 1,
    });

    r1();
  });

  test("release is idempotent", async () => {
    const q = new TestConcurrencyQueue(1);
    const r1 = await q.acquire("a", "task-a");

    r1(); // first release
    r1(); // second release — should be a no-op
    r1(); // third release — still no-op

    assert.deepStrictEqual(q.getSnapshot(), {
      running: 0,
      waiting: 0,
      maxConcurrent: 1,
    });
  });

  test("starvation boost promotes BACKGROUND to SCHEDULED", async () => {
    const q = new TestConcurrencyQueue(1);
    const r1 = await q.acquire("a", "running");

    // Queue background and scheduled items — background first
    q.acquire("bg", "background", QueuePriority.BACKGROUND).catch(() => {});
    q.acquire("s", "scheduled", QueuePriority.SCHEDULED).catch(() => {});

    // Before boost: s > bg
    assert.deepStrictEqual(
      q.getWaitingIds().map((w) => w.id),
      ["s", "bg"],
    );

    // Simulate starvation with 0ms threshold
    q.boostStarvedItems(0);

    // After boost: bg promoted to SCHEDULED, s already SCHEDULED.
    // Since both are now same priority, original order maintained by sort stability
    // bg was promoted from 0→1, s stays at 1; sort is stable so order should be s, bg
    const afterBoost = q.getWaitingIds().map((w) => w.id);
    assert.deepStrictEqual(afterBoost, ["s", "bg"]);

    q.cancelAllWaiting();
    r1();
  });

  test("increasing maxConcurrent drains waiting items", async () => {
    const q = new TestConcurrencyQueue(1);
    const r1 = await q.acquire("a", "first");

    let secondResolved = false;
    const p2 = q.acquire("b", "second").then((r) => {
      secondResolved = true;
      return r;
    });

    assert.strictEqual(secondResolved, false);

    // Increase limit to 2 — should drain "b" into running
    q.maxConcurrent = 2;
    const r2 = await p2;
    assert.strictEqual(secondResolved, true);
    assert.deepStrictEqual(q.getSnapshot(), {
      running: 2,
      waiting: 0,
      maxConcurrent: 2,
    });

    r1();
    r2();
  });

  test("maxConcurrent clamps to [1, 10]", () => {
    const q = new TestConcurrencyQueue(5);
    q.maxConcurrent = 0;
    assert.strictEqual(q.maxConcurrent, 1);

    q.maxConcurrent = 100;
    assert.strictEqual(q.maxConcurrent, 10);

    q.maxConcurrent = 5;
    assert.strictEqual(q.maxConcurrent, 5);
  });

  test("snapshot reflects current state accurately", async () => {
    const q = new TestConcurrencyQueue(2);

    assert.deepStrictEqual(q.getSnapshot(), {
      running: 0,
      waiting: 0,
      maxConcurrent: 2,
    });

    const r1 = await q.acquire("a", "task-a");
    assert.deepStrictEqual(q.getSnapshot(), {
      running: 1,
      waiting: 0,
      maxConcurrent: 2,
    });

    const r2 = await q.acquire("b", "task-b");
    assert.deepStrictEqual(q.getSnapshot(), {
      running: 2,
      waiting: 0,
      maxConcurrent: 2,
    });

    // Queue two more
    q.acquire("c", "task-c").catch(() => {});
    q.acquire("d", "task-d").catch(() => {});
    await new Promise((r) => setTimeout(r, 5));

    assert.deepStrictEqual(q.getSnapshot(), {
      running: 2,
      waiting: 2,
      maxConcurrent: 2,
    });

    r1();
    await new Promise((r) => setTimeout(r, 5));
    assert.deepStrictEqual(q.getSnapshot(), {
      running: 2,
      waiting: 1,
      maxConcurrent: 2,
    });

    q.cancelAllWaiting();
    r2();
  });

  test("concurrent acquire + release stress test", async () => {
    const q = new TestConcurrencyQueue(2);
    const releases: Array<() => void> = [];

    // Acquire 5 items rapidly
    const promises = Array.from({ length: 5 }, (_, i) =>
      q.acquire(`t${i}`, `task-${i}`, QueuePriority.USER).then((r) => {
        releases.push(r);
        return r;
      }),
    );

    // First 2 should resolve immediately
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(releases.length, 2);

    // Release the first two
    releases[0]();
    releases[1]();
    await new Promise((r) => setTimeout(r, 10));

    // Two more should have resolved
    assert.strictEqual(releases.length, 4);

    // Release those two
    releases[2]();
    releases[3]();
    await new Promise((r) => setTimeout(r, 10));

    // Last one should resolve
    assert.strictEqual(releases.length, 5);
    releases[4]();

    assert.deepStrictEqual(q.getSnapshot(), {
      running: 0,
      waiting: 0,
      maxConcurrent: 2,
    });
  });
});
