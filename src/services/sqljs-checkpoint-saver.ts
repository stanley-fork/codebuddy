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

const VALID_METADATA_KEYS = ["source", "step", "parents"] as const;

export class SqlJsCheckpointSaver extends BaseCheckpointSaver {
  private db: any = null;
  private SQL: any = null;
  private isSetup = false;
  private readonly dbPath: string;
  private readonly wasmLocator: (file: string) => string;
  private readonly logger: Logger;
  private saveTimer: NodeJS.Timeout | null = null;
  private isDirty = false;
  private initPromise: Promise<void> | null = null;

  constructor(opts: { dbPath: string; wasmLocator: (file: string) => string }) {
    super();
    this.dbPath = opts.dbPath;
    this.wasmLocator = opts.wasmLocator;
    this.logger = Logger.initialize("SqlJsCheckpointSaver", {
      minLevel: LogLevel.DEBUG,
      enableConsole: true,
      enableFile: true,
      enableTelemetry: true,
    });
  }

  /**
   * Factory: create from a directory + extensionPath for WASM resolution.
   */
  static create(opts: {
    dbDir: string;
    extensionPath: string;
  }): SqlJsCheckpointSaver {
    const dbPath = path.join(opts.dbDir, "checkpoints.db");
    const wasmPath = path.join(
      opts.extensionPath,
      "dist",
      "grammars",
      "sql-wasm.wasm",
    );
    const resolvedWasmPath = fs.existsSync(wasmPath)
      ? wasmPath
      : path.join(__dirname, "grammars", "sql-wasm.wasm");

    return new SqlJsCheckpointSaver({
      dbPath,
      wasmLocator: (file: string) =>
        file.endsWith(".wasm") ? resolvedWasmPath : file,
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
    this.SQL = await initSqlJs({ locateFile: this.wasmLocator });

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

  // ── Disk persistence ────────────────────────────────────────────────

  private scheduleSave(): void {
    this.isDirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk();
    }, 1000);
  }

  private saveToDisk(): void {
    if (!this.db || !this.isDirty) return;
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data: Uint8Array = this.db.export();
      fs.writeFileSync(this.dbPath, data);
      this.isDirty = false;
    } catch (err) {
      this.logger.error("Failed to persist checkpoint DB", err);
    }
  }

  // ── sql.js query helpers ────────────────────────────────────────────

  /** Run a query that returns a single row (or undefined). */
  private queryOne(
    sql: string,
    params: any[],
  ): Record<string, any> | undefined {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    let row: Record<string, any> | undefined;
    if (stmt.step()) {
      row = stmt.getAsObject();
    }
    stmt.free();
    return row;
  }

  /** Run a query that returns all rows. */
  private queryAll(sql: string, params: any[]): Record<string, any>[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows: Record<string, any>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
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
            AND ps.channel = '${TASKS}'
          ORDER BY ps.idx
        ) AS pending_sends
      FROM checkpoints
      WHERE thread_id = ? AND checkpoint_ns = ?
      ${withCheckpointId ? "AND checkpoint_id = ?" : "ORDER BY checkpoint_id DESC LIMIT 1"}
    `;
  }

  /** Deserialize a checkpoint row from the DB into a CheckpointTuple. */
  private async rowToTuple(
    row: Record<string, any>,
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

    // Deserialize pending writes
    const rawWrites: any[] = JSON.parse(row.pending_writes || "[]");
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      rawWrites.map(async (w: any) => [
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

    // Handle v3 → v4 migration of pending sends
    if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
      await this.migratePendingSends(
        checkpoint,
        row.thread_id,
        row.parent_checkpoint_id,
      );
    }

    return {
      config: finalConfig,
      checkpoint,
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
    const params = checkpoint_id
      ? [thread_id, checkpoint_ns, checkpoint_id]
      : [thread_id, checkpoint_ns];

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
            AND ps.channel = '${TASKS}'
          ORDER BY ps.idx
        ) AS pending_sends
      FROM checkpoints
    `;

    const whereClauses: string[] = [];
    const params: any[] = [];

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

    // Apply metadata filters
    const sanitized = Object.entries(filter ?? {}).filter(
      ([key, value]) =>
        value !== undefined && VALID_METADATA_KEYS.includes(key as any),
    );
    for (const [key, value] of sanitized) {
      whereClauses.push(`json_extract(CAST(metadata AS TEXT), '$.${key}') = ?`);
      params.push(JSON.stringify(value));
    }

    if (whereClauses.length > 0) {
      sql += `WHERE ${whereClauses.join(" AND ")} `;
    }
    sql += "ORDER BY checkpoint_id DESC";
    if (limit) {
      sql += ` LIMIT ${parseInt(String(limit), 10)}`;
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

    this.db.run(
      `INSERT OR REPLACE INTO checkpoints
       (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        thread_id,
        checkpoint_ns,
        checkpoint.id,
        parent_checkpoint_id,
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

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    await this.ensureSetup();

    if (!config.configurable) {
      throw new Error("Empty configuration supplied.");
    }
    if (!config.configurable.thread_id) {
      throw new Error("Missing thread_id in config.configurable.");
    }
    if (!config.configurable.checkpoint_id) {
      throw new Error("Missing checkpoint_id in config.configurable.");
    }

    const thread_id = config.configurable.thread_id;
    const checkpoint_ns = config.configurable.checkpoint_ns ?? "";
    const checkpoint_id = config.configurable.checkpoint_id;

    for (let idx = 0; idx < writes.length; idx++) {
      const [channel, value] = writes[idx];
      const [type, serializedValue] = await this.serde.dumpsTyped(value);
      this.db.run(
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

    this.scheduleSave();
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.ensureSetup();
    this.db.run(`DELETE FROM checkpoints WHERE thread_id = ?`, [threadId]);
    this.db.run(`DELETE FROM writes WHERE thread_id = ?`, [threadId]);
    this.scheduleSave();
  }

  // ── v3 → v4 migration helper ───────────────────────────────────────

  private async migratePendingSends(
    checkpoint: any,
    threadId: string,
    parentCheckpointId: string,
  ): Promise<void> {
    const row = this.queryOne(
      `SELECT json_group_array(
         json_object('type', ps.type, 'value', CAST(ps.value AS TEXT))
       ) AS pending_sends
       FROM writes AS ps
       WHERE ps.thread_id = ? AND ps.checkpoint_id = ? AND ps.channel = '${TASKS}'
       ORDER BY ps.idx`,
      [threadId, parentCheckpointId],
    );

    if (!row?.pending_sends) return;

    const sends: any[] = JSON.parse(row.pending_sends);
    checkpoint.channel_values ??= {};
    checkpoint.channel_values[TASKS] = await Promise.all(
      sends.map(({ type, value }: any) => this.serde.loadsTyped(type, value)),
    );
    checkpoint.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(
            ...(Object.values(checkpoint.channel_versions) as Array<
              string | number
            >),
          )
        : this.getNextVersion(undefined);
  }

  // ── Cleanup ─────────────────────────────────────────────────────────

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // Final save
    this.saveToDisk();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
