/**
 * LangGraph BaseCheckpointSaver implementation backed by sql.js (WASM SQLite).
 *
 * This replaces the native-module-dependent `@langchain/langgraph-checkpoint-sqlite`
 * which uses `better-sqlite3` and fails to load in bundled VS Code extensions.
 *
 * sql.js is already a project dependency used by SqliteVectorStore and
 * TelemetryPersistenceService.
 */
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import {
  BaseCheckpointSaver,
  copyCheckpoint,
  TASKS,
  maxChannelVersion,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  CheckpointMetadata,
  PendingWrite,
  CheckpointPendingWrite,
} from "@langchain/langgraph-checkpoint";
import { Logger, LogLevel } from "../infrastructure/logger/logger";

// Re-export the types needed by callers
type Checkpoint = Parameters<BaseCheckpointSaver["put"]>[1];
type ChannelVersions = Parameters<BaseCheckpointSaver["put"]>[3];
type CheckpointTuple = NonNullable<
  Awaited<ReturnType<BaseCheckpointSaver["getTuple"]>>
>;
type CheckpointListOptions = Parameters<BaseCheckpointSaver["list"]>[1];

// ── Typed sql.js interfaces ──────────────────────────────────────────

type SqlValue = string | number | Uint8Array | null;
type BindParams = SqlValue[];

interface SqlJsStatement {
  bind(params: BindParams): void;
  step(): boolean;
  getAsObject(): Record<string, SqlValue>;
  free(): void;
}

interface SqlJsDatabase {
  run(sql: string, params?: BindParams): void;
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: Uint8Array) => SqlJsDatabase;
}

/** Shape of a deserialized checkpoint row before type narrowing. */
interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string | null;
  checkpoint: Uint8Array | string;
  metadata: Uint8Array | string;
  pending_writes: string;
  pending_sends: string;
}

const VALID_METADATA_KEYS = ["source", "step", "parents"] as const;

/** Pre-mapped JSON paths for metadata filter keys — zero injection surface. */
const METADATA_JSON_PATHS: Record<
  (typeof VALID_METADATA_KEYS)[number],
  string
> = {
  source: "$.source",
  step: "$.step",
  parents: "$.parents",
} as const;

export class SqlJsCheckpointSaver extends BaseCheckpointSaver {
  private db: SqlJsDatabase | null = null;
  private SQL: SqlJsStatic | null = null;
  private isSetup = false;
  private readonly dbPath: string;
  private readonly wasmLocator: (file: string) => string;
  private readonly logger: Logger;
  private saveTimer: NodeJS.Timeout | null = null;
  private isDirty = false;
  private isSaving = false;
  private initPromise: Promise<void> | null = null;

  constructor(opts: { dbPath: string; wasmLocator: (file: string) => string }) {
    super();
    this.dbPath = opts.dbPath;
    this.wasmLocator = opts.wasmLocator;
    this.logger = Logger.initialize("SqlJsCheckpointSaver", {
      minLevel: LogLevel.INFO,
      enableConsole: true,
      enableFile: true,
      enableTelemetry: true,
    });
  }

  /**
   * Factory: create from a directory + extensionPath for WASM resolution.
   * Enumerates candidate paths, validates existence, fails fast on missing WASM.
   */
  static async create(opts: {
    dbDir: string;
    extensionPath: string;
  }): Promise<SqlJsCheckpointSaver> {
    const dbPath = path.join(opts.dbDir, "checkpoints.db");

    const candidatePaths = [
      path.join(opts.extensionPath, "dist", "grammars", "sql-wasm.wasm"),
      path.join(
        opts.extensionPath,
        "node_modules",
        "sql.js",
        "dist",
        "sql-wasm.wasm",
      ),
      path.join(__dirname, "grammars", "sql-wasm.wasm"),
      path.join(__dirname, "sql-wasm.wasm"),
    ];

    let resolvedWasmPath: string | undefined;
    for (const p of candidatePaths) {
      try {
        await fsp.access(p, fs.constants.R_OK);
        resolvedWasmPath = p;
        break;
      } catch {
        // candidate not found, try next
      }
    }
    if (!resolvedWasmPath) {
      throw new Error(
        `sql-wasm.wasm not found. Searched:\n${candidatePaths.join("\n")}`,
      );
    }

    // resolvedWasmPath is guaranteed non-undefined after the check above
    const wasmPath = resolvedWasmPath;
    return new SqlJsCheckpointSaver({
      dbPath,
      wasmLocator: (file: string) => (file.endsWith(".wasm") ? wasmPath : file),
    });
  }

  // ── Internal setup ──────────────────────────────────────────────────

  private async ensureSetup(): Promise<void> {
    if (this.isSetup) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doSetup();
    return this.initPromise;
  }

  private async doSetup(): Promise<void> {
    const initSqlJs = (await import("sql.js")).default;
    this.SQL = (await initSqlJs({
      locateFile: this.wasmLocator,
    })) as SqlJsStatic;

    // Load existing DB file if present
    let data: Uint8Array | undefined;
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      data = new Uint8Array(buffer);
    }

    this.db = new this.SQL.Database(data);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint BLOB,
        metadata BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      )
    `);

    this.isSetup = true;
    this.logger.info(`Checkpoint DB initialized at ${this.dbPath}`);
  }

  /** Assert db is initialized — narrows type from `| null`. */
  private getDb(): SqlJsDatabase {
    if (!this.db) throw new Error("Checkpoint DB not initialized");
    return this.db;
  }

  // ── Disk persistence ────────────────────────────────────────────────

  private scheduleSave(): void {
    this.isDirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveToDiskAsync();
    }, 1000);
  }

  private async saveToDiskAsync(): Promise<void> {
    if (!this.db || !this.isDirty || this.isSaving) return;
    this.isSaving = true;
    try {
      await fsp.mkdir(path.dirname(this.dbPath), { recursive: true });
      const data: Uint8Array = this.db.export();
      // Write to temp file, then atomic rename to avoid partial writes on crash
      const tmpPath = `${this.dbPath}.tmp`;
      await fsp.writeFile(tmpPath, data);
      await fsp.rename(tmpPath, this.dbPath);
      this.isDirty = false;
    } catch (err) {
      this.logger.error("Failed to persist checkpoint DB", err);
    } finally {
      this.isSaving = false;
    }
  }

  // ── sql.js query helpers ────────────────────────────────────────────

  /** Validate and map a raw sql.js row to CheckpointRow with runtime checks. */
  private toCheckpointRow(raw: Record<string, SqlValue>): CheckpointRow {
    if (typeof raw.thread_id !== "string") {
      throw new Error(`Invalid checkpoint row: thread_id=${raw.thread_id}`);
    }
    if (typeof raw.checkpoint_id !== "string") {
      throw new Error(
        `Invalid checkpoint row: checkpoint_id=${raw.checkpoint_id}`,
      );
    }
    return {
      thread_id: raw.thread_id,
      checkpoint_ns:
        typeof raw.checkpoint_ns === "string" ? raw.checkpoint_ns : "",
      checkpoint_id: raw.checkpoint_id,
      parent_checkpoint_id:
        typeof raw.parent_checkpoint_id === "string"
          ? raw.parent_checkpoint_id
          : null,
      type: typeof raw.type === "string" ? raw.type : null,
      checkpoint: raw.checkpoint as Uint8Array | string,
      metadata: raw.metadata as Uint8Array | string,
      pending_writes:
        typeof raw.pending_writes === "string" ? raw.pending_writes : "[]",
      pending_sends:
        typeof raw.pending_sends === "string" ? raw.pending_sends : "[]",
    };
  }

  /** Run a query that returns a single row (or undefined). */
  private queryOne(sql: string, params: BindParams): CheckpointRow | undefined {
    const db = this.getDb();
    const stmt = db.prepare(sql);
    stmt.bind(params);
    let row: CheckpointRow | undefined;
    if (stmt.step()) {
      row = this.toCheckpointRow(stmt.getAsObject());
    }
    stmt.free();
    return row;
  }

  /** Run a query that returns all rows. */
  private queryAll(sql: string, params: BindParams): CheckpointRow[] {
    const db = this.getDb();
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows: CheckpointRow[] = [];
    while (stmt.step()) {
      rows.push(this.toCheckpointRow(stmt.getAsObject()));
    }
    stmt.free();
    return rows;
  }

  // ── Build the SELECT for checkpoints + pending writes ───────────────

  private buildCheckpointQuery(withCheckpointId: boolean): string {
    return `
      SELECT
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        parent_checkpoint_id,
        type,
        checkpoint,
        metadata,
        (
          SELECT json_group_array(
            json_object(
              'task_id', pw.task_id,
              'channel', pw.channel,
              'type', pw.type,
              'value', CAST(pw.value AS TEXT)
            )
          )
          FROM writes AS pw
          WHERE pw.thread_id = checkpoints.thread_id
            AND pw.checkpoint_ns = checkpoints.checkpoint_ns
            AND pw.checkpoint_id = checkpoints.checkpoint_id
        ) AS pending_writes,
        (
          SELECT json_group_array(
            json_object(
              'type', ps.type,
              'value', CAST(ps.value AS TEXT)
            )
          )
          FROM writes AS ps
          WHERE ps.thread_id = checkpoints.thread_id
            AND ps.checkpoint_ns = checkpoints.checkpoint_ns
            AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
            AND ps.channel = ?
          ORDER BY ps.idx
        ) AS pending_sends
      FROM checkpoints
      WHERE thread_id = ? AND checkpoint_ns = ?
      ${withCheckpointId ? "AND checkpoint_id = ?" : "ORDER BY checkpoint_id DESC LIMIT 1"}
    `;
  }

  /** Deserialize a checkpoint row from the DB into a CheckpointTuple. */
  private async rowToTuple(
    row: CheckpointRow,
    config: RunnableConfig,
    inferConfigFromRow: boolean,
  ): Promise<CheckpointTuple> {
    const checkpoint_ns = row.checkpoint_ns ?? "";

    let finalConfig = config;
    if (inferConfigFromRow) {
      finalConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      };
    }

    // Deserialize pending writes with schema validation
    let rawWrites: Array<{
      task_id: string;
      channel: string;
      type: string;
      value: string;
    }> = [];
    try {
      const parsed = JSON.parse(String(row.pending_writes || "[]"));
      if (Array.isArray(parsed)) {
        rawWrites = parsed.filter(
          (
            w: unknown,
          ): w is {
            task_id: string;
            channel: string;
            type: string;
            value: string;
          } =>
            typeof w === "object" &&
            w !== null &&
            typeof (w as any).task_id === "string" &&
            typeof (w as any).channel === "string",
        );
      }
    } catch {
      this.logger.warn(
        "Failed to parse pending_writes JSON, using empty array",
      );
    }
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      rawWrites.map(async (w) => [
        w.task_id,
        w.channel,
        await this.serde.loadsTyped(w.type ?? "json", w.value ?? ""),
      ]),
    );

    // Deserialize checkpoint + metadata
    const checkpoint = await this.serde.loadsTyped(
      row.type ?? "json",
      row.checkpoint,
    );
    const metadata = await this.serde.loadsTyped(
      row.type ?? "json",
      row.metadata,
    );

    // Handle v3 → v4 migration of pending sends (returns migrated copy)
    let finalCheckpoint = checkpoint;
    if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
      finalCheckpoint = await this.buildMigratedCheckpoint(
        checkpoint,
        row.thread_id,
        row.parent_checkpoint_id,
      );
    }

    return {
      config: finalConfig,
      checkpoint: finalCheckpoint,
      metadata,
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns,
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites,
    };
  }

  // ── BaseCheckpointSaver abstract methods ────────────────────────────

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    await this.ensureSetup();

    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns ?? "";
    const checkpoint_id = config.configurable?.checkpoint_id;

    const sql = this.buildCheckpointQuery(!!checkpoint_id);
    const params: BindParams = checkpoint_id
      ? [TASKS, thread_id, checkpoint_ns, checkpoint_id]
      : [TASKS, thread_id, checkpoint_ns];

    const row = this.queryOne(sql, params);
    if (!row) return undefined;

    return this.rowToTuple(row, config, !checkpoint_id);
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    await this.ensureSetup();

    const { limit, before, filter } = options ?? {};
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns;

    let sql = `
      SELECT
        thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
        type, checkpoint, metadata,
        (
          SELECT json_group_array(
            json_object('task_id', pw.task_id, 'channel', pw.channel, 'type', pw.type, 'value', CAST(pw.value AS TEXT))
          )
          FROM writes AS pw
          WHERE pw.thread_id = checkpoints.thread_id
            AND pw.checkpoint_ns = checkpoints.checkpoint_ns
            AND pw.checkpoint_id = checkpoints.checkpoint_id
        ) AS pending_writes,
        (
          SELECT json_group_array(
            json_object('type', ps.type, 'value', CAST(ps.value AS TEXT))
          )
          FROM writes AS ps
          WHERE ps.thread_id = checkpoints.thread_id
            AND ps.checkpoint_ns = checkpoints.checkpoint_ns
            AND ps.checkpoint_id = checkpoints.parent_checkpoint_id
            AND ps.channel = ?
          ORDER BY ps.idx
        ) AS pending_sends
      FROM checkpoints
    `;

    const whereClauses: string[] = [];
    const params: BindParams = [TASKS];

    if (thread_id) {
      whereClauses.push("thread_id = ?");
      params.push(thread_id);
    }
    if (checkpoint_ns !== undefined && checkpoint_ns !== null) {
      whereClauses.push("checkpoint_ns = ?");
      params.push(checkpoint_ns);
    }
    if (before?.configurable?.checkpoint_id !== undefined) {
      whereClauses.push("checkpoint_id < ?");
      params.push(before.configurable.checkpoint_id);
    }

    // Apply metadata filters — keys mapped to pre-defined JSON path literals.
    if (filter) {
      for (const [key, value] of Object.entries(filter)) {
        if (value === undefined) continue;
        const jsonPath =
          METADATA_JSON_PATHS[key as keyof typeof METADATA_JSON_PATHS];
        if (!jsonPath) continue; // unknown key — skip silently
        whereClauses.push(
          `json_extract(CAST(metadata AS TEXT), '${jsonPath}') = ?`,
        );
        params.push(JSON.stringify(value));
      }
    }

    if (whereClauses.length > 0) {
      sql += `WHERE ${whereClauses.join(" AND ")} `;
    }
    sql += "ORDER BY checkpoint_id DESC";

    // Parameterized LIMIT to prevent SQL injection
    if (limit !== undefined && limit !== null) {
      const safeLimit = Math.max(1, Math.floor(Number(limit)));
      if (!Number.isFinite(safeLimit)) {
        throw new Error(`Invalid limit value: ${limit}`);
      }
      sql += " LIMIT ?";
      params.push(safeLimit);
    }

    const rows = this.queryAll(sql, params);
    for (const row of rows) {
      yield await this.rowToTuple(row, config, true);
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    await this.ensureSetup();
    const db = this.getDb();

    if (!config.configurable) {
      throw new Error("Empty configuration supplied.");
    }

    const thread_id = config.configurable.thread_id;
    const checkpoint_ns = config.configurable.checkpoint_ns ?? "";
    const parent_checkpoint_id = config.configurable.checkpoint_id;

    if (!thread_id) {
      throw new Error('Missing "thread_id" in config.configurable.');
    }

    const preparedCheckpoint = copyCheckpoint(checkpoint);
    const [[type1, serializedCheckpoint], [type2, serializedMetadata]] =
      await Promise.all([
        this.serde.dumpsTyped(preparedCheckpoint),
        this.serde.dumpsTyped(metadata),
      ]);

    if (type1 !== type2) {
      throw new Error(
        "Failed to serialize checkpoint and metadata to the same type.",
      );
    }

    db.run(
      `INSERT OR REPLACE INTO checkpoints
       (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        thread_id as string,
        checkpoint_ns,
        checkpoint.id,
        parent_checkpoint_id ?? null,
        type1,
        serializedCheckpoint,
        serializedMetadata,
      ],
    );

    this.scheduleSave();

    return {
      configurable: {
        thread_id,
        checkpoint_ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  /**
   * Store intermediate writes atomically via BEGIN/COMMIT transaction.
   * Pre-serializes all values before opening the transaction so async
   * work doesn't hold the transaction open.
   */
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    await this.ensureSetup();
    const db = this.getDb();

    if (!config.configurable) {
      throw new Error("Empty configuration supplied.");
    }
    if (!config.configurable.thread_id) {
      throw new Error("Missing thread_id in config.configurable.");
    }
    if (!config.configurable.checkpoint_id) {
      throw new Error("Missing checkpoint_id in config.configurable.");
    }

    const thread_id = config.configurable.thread_id as string;
    const checkpoint_ns = (config.configurable.checkpoint_ns as string) ?? "";
    const checkpoint_id = config.configurable.checkpoint_id as string;

    // Pre-serialize outside the transaction (async)
    const serialized = await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const [type, serializedValue] = await this.serde.dumpsTyped(value);
        return {
          channel: channel as string,
          type,
          serializedValue,
          idx,
        };
      }),
    );

    // Atomic transaction (sync sql.js calls only)
    db.run("BEGIN");
    try {
      for (const { channel, type, serializedValue, idx } of serialized) {
        db.run(
          `INSERT OR REPLACE INTO writes
           (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            thread_id,
            checkpoint_ns,
            checkpoint_id,
            taskId,
            idx,
            channel,
            type,
            serializedValue,
          ],
        );
      }
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }

    this.scheduleSave();
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.ensureSetup();
    const db = this.getDb();
    db.run(`DELETE FROM checkpoints WHERE thread_id = ?`, [threadId]);
    db.run(`DELETE FROM writes WHERE thread_id = ?`, [threadId]);
    this.scheduleSave();
  }

  // ── v3 → v4 migration helper ───────────────────────────────────────

  /**
   * Build a migrated copy of the checkpoint with pending sends populated.
   * Returns a new object — does not mutate the input.
   */
  private async buildMigratedCheckpoint<
    T extends {
      v: number;
      channel_values?: Record<string, unknown>;
      channel_versions: Record<string, string | number>;
    },
  >(checkpoint: T, threadId: string, parentCheckpointId: string): Promise<T> {
    const row = this.queryOne(
      `SELECT json_group_array(
         json_object('type', ps.type, 'value', CAST(ps.value AS TEXT))
       ) AS pending_sends
       FROM writes AS ps
       WHERE ps.thread_id = ? AND ps.checkpoint_id = ? AND ps.channel = ?
       ORDER BY ps.idx`,
      [threadId, parentCheckpointId, TASKS],
    );

    if (!row?.pending_sends) return checkpoint;

    const sends: Array<{ type: string; value: string }> = JSON.parse(
      String(row.pending_sends),
    );

    const migratedValues = {
      ...(checkpoint.channel_values ?? {}),
      [TASKS]: await Promise.all(
        sends.map(({ type, value }) => this.serde.loadsTyped(type, value)),
      ),
    };

    const existingVersions = checkpoint.channel_versions;
    const version =
      Object.keys(existingVersions).length > 0
        ? maxChannelVersion(
            ...(Object.values(existingVersions) as Array<string | number>),
          )
        : 1; // Initial version for newly-created channel

    return {
      ...checkpoint,
      channel_values: migratedValues,
      channel_versions: {
        ...existingVersions,
        [TASKS]: version,
      },
    };
  }

  // ── Cleanup (defensive dispose with error isolation) ────────────────

  async dispose(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      await this.saveToDiskAsync();
    } catch (err) {
      this.logger.error("Final checkpoint save failed during dispose", err);
    } finally {
      if (this.db) {
        try {
          this.db.close();
        } catch (err) {
          this.logger.error("Failed to close checkpoint DB", err);
        }
        this.db = null;
        this.isSetup = false;
        this.initPromise = null;
      }
    }
  }
}
