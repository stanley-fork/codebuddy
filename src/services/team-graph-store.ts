/**
 * TeamGraphStore — SQLite-backed graph store for Meeting Intelligence.
 *
 * Models:
 *   people        — team members with evolving role/personality traits
 *   standups      — meeting records (replaces MemoryTool storage)
 *   commitments   — per-person-per-standup action items
 *   blockers      — dependency issues tied to standups
 *   decisions     — team decisions tied to standups
 *   ticket_mentions — ticket references tied to standups
 *   relationships — weighted edges: collaboration, blocking, reviewing, etc.
 *
 * The "graph" is encoded as a node table (people) + edge table (relationships)
 * with JSON-serialisable properties, running on the same sql.js WASM engine used
 * by SqliteDatabaseService and SqliteVectorStore.
 */

import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../infrastructure/logger/logger";
import type {
  StandupRecord,
  Commitment,
  Blocker,
  Decision,
  TicketMention,
  DetectedRelationship,
} from "../shared/standup.types";

// ── Minimal sql.js type definitions ─────────────────────────────

type SqlValue = string | number | null | Uint8Array;

interface QueryExecResult {
  columns: string[];
  values: SqlValue[][];
}

interface SqlJsDatabase {
  run(sql: string, params?: SqlValue[]): void;
  exec(sql: string, params?: SqlValue[]): QueryExecResult[];
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}

// ── Relationship types between people ───────────────────────────

export type RelationshipKind =
  | "collaborates_with" // worked on same standup
  | "blocks" // A blocks B
  | "reviews_for" // A reviews B's work
  | "reports_to" // inferred from role mentions
  | "mentors" // mentor/mentee
  | "depends_on"; // A's work depends on B

export interface PersonProfile {
  id: number;
  name: string;
  /** Canonical normalised name (lowercase, trimmed). */
  canonical_name: string;
  /** Inferred role from meeting context (e.g. "Frontend Engineer"). */
  role: string | null;
  /** JSON-serialised personality/behavior traits object. */
  traits: Record<string, unknown>;
  /** Total standups this person appeared in. */
  standup_count: number;
  /** Total commitments made. */
  commitment_count: number;
  /** Total commitments completed. */
  completion_count: number;
  first_seen: string; // ISO date
  last_seen: string; // ISO date
}

export interface Relationship {
  id: number;
  source_person_id: number;
  target_person_id: number;
  kind: RelationshipKind;
  /** Monotonically increasing weight — each co-occurrence increments by 1. */
  weight: number;
  /** JSON metadata (e.g. latest ticket, context). */
  metadata: Record<string, unknown>;
  updated_at: string;
}

// ── TeamGraphStore ──────────────────────────────────────────────

export class TeamGraphStore implements vscode.Disposable {
  private static instance: TeamGraphStore | undefined;
  private db: SqlJsDatabase | null = null;
  private SQL: SqlJsStatic | null = null;
  private dbPath = "";
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private readonly logger: Logger;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SAVE_DEBOUNCE_MS = 3_000;

  /** Non-null DB accessor — only call after ensureInitialized / inside createTables. */
  private get _db(): SqlJsDatabase {
    if (!this.db) throw new Error("TeamGraphStore: DB not initialized");
    return this.db;
  }

  private constructor() {
    this.logger = Logger.initialize("TeamGraphStore", {
      minLevel: LogLevel.DEBUG,
      enableConsole: true,
      enableFile: true,
      enableTelemetry: true,
    });
  }

  static getInstance(): TeamGraphStore {
    return (TeamGraphStore.instance ??= new TeamGraphStore());
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const initSqlJs = (await import("sql.js")).default;
        const wasmPath = path.join(__dirname, "grammars", "sql-wasm.wasm");

        this.SQL = await initSqlJs({
          locateFile: (file: string) =>
            file.endsWith(".wasm") ? wasmPath : file,
        });

        const workspaceRoot =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const dir = workspaceRoot
          ? path.join(workspaceRoot, ".codebuddy")
          : path.join(__dirname, "..", "..", "database");

        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        this.dbPath = path.join(dir, "team_graph.db");

        const wasNewDb = !fs.existsSync(this.dbPath);

        let data: Uint8Array | undefined;
        if (!wasNewDb) {
          data = new Uint8Array(fs.readFileSync(this.dbPath));
        }
        this.db = new this.SQL!.Database(data);

        this.createTables();
        this.initialized = true;
        this.logger.info(`TeamGraphStore initialized at ${this.dbPath}`);
        // Only persist a fresh DB after schema creation succeeds
        if (wasNewDb) {
          this.saveToDisk();
        }
      } catch (err: unknown) {
        this.initPromise = null;
        const msg = err instanceof Error ? err.message : "Unknown init error";
        this.logger.error(`TeamGraphStore init failed: ${msg}`);
        throw err;
      }
    })();

    return this.initPromise;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    return this.initialize();
  }

  /** Whether the DB is initialized and ready for synchronous queries. */
  isReady(): boolean {
    return this.initialized && this.db !== null;
  }

  dispose(): void {
    this.saveToDisk();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.db?.close();
    this.db = null;
    this.initialized = false;
    this.initPromise = null;
    TeamGraphStore.instance = undefined;
  }

  // ── Schema ────────────────────────────────────────────────────

  private createTables(): void {
    this._db.run("PRAGMA journal_mode = WAL;");
    this._db.run("PRAGMA foreign_keys = ON;");

    // People (nodes)
    this._db.run(`
      CREATE TABLE IF NOT EXISTS people (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        canonical_name  TEXT NOT NULL UNIQUE,
        role            TEXT,
        traits          TEXT NOT NULL DEFAULT '{}',
        standup_count   INTEGER NOT NULL DEFAULT 0,
        commitment_count INTEGER NOT NULL DEFAULT 0,
        completion_count INTEGER NOT NULL DEFAULT 0,
        first_seen      TEXT NOT NULL,
        last_seen       TEXT NOT NULL
      );
    `);
    this._db.run(
      "CREATE INDEX IF NOT EXISTS idx_people_canonical ON people(canonical_name);",
    );

    // Standups
    this._db.run(`
      CREATE TABLE IF NOT EXISTS standups (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        date       TEXT NOT NULL,
        team_name  TEXT NOT NULL,
        raw_json   TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(date, team_name)
      );
    `);
    this._db.run(
      "CREATE INDEX IF NOT EXISTS idx_standups_date ON standups(date);",
    );

    // Commitments (per-person per-standup)
    this._db.run(`
      CREATE TABLE IF NOT EXISTS commitments (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        standup_id  INTEGER NOT NULL REFERENCES standups(id) ON DELETE CASCADE,
        person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        action      TEXT NOT NULL,
        deadline    TEXT,
        ticket_ids  TEXT NOT NULL DEFAULT '[]',
        status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done'))
      );
    `);
    this._db.run(
      "CREATE INDEX IF NOT EXISTS idx_commitments_person ON commitments(person_id);",
    );
    this._db.run(
      "CREATE INDEX IF NOT EXISTS idx_commitments_standup ON commitments(standup_id);",
    );

    // Blockers
    this._db.run(`
      CREATE TABLE IF NOT EXISTS blockers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        standup_id  INTEGER NOT NULL REFERENCES standups(id) ON DELETE CASCADE,
        blocked     TEXT NOT NULL,
        blocked_by  TEXT NOT NULL,
        owner_id    INTEGER REFERENCES people(id),
        reason      TEXT NOT NULL
      );
    `);

    // Decisions
    this._db.run(`
      CREATE TABLE IF NOT EXISTS decisions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        standup_id  INTEGER NOT NULL REFERENCES standups(id) ON DELETE CASCADE,
        summary     TEXT NOT NULL,
        participants TEXT NOT NULL DEFAULT '[]'
      );
    `);

    // Ticket mentions
    this._db.run(`
      CREATE TABLE IF NOT EXISTS ticket_mentions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        standup_id  INTEGER NOT NULL REFERENCES standups(id) ON DELETE CASCADE,
        ticket_id   TEXT NOT NULL,
        context     TEXT NOT NULL,
        assignee_id INTEGER REFERENCES people(id)
      );
    `);
    this._db.run(
      "CREATE INDEX IF NOT EXISTS idx_tickets_ticket ON ticket_mentions(ticket_id);",
    );

    // Relationships (edges)
    this._db.run(`
      CREATE TABLE IF NOT EXISTS relationships (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        source_person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        target_person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        kind             TEXT NOT NULL,
        weight           INTEGER NOT NULL DEFAULT 1,
        metadata         TEXT NOT NULL DEFAULT '{}',
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(source_person_id, target_person_id, kind)
      );
    `);
    this._db.run(
      "CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source_person_id);",
    );
    this._db.run(
      "CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_person_id);",
    );
  }

  // ── Persistence ───────────────────────────────────────────────

  private saveToDisk(): void {
    if (!this.db || !this.dbPath) return;
    try {
      const data = this._db.export();
      fs.writeFileSync(this.dbPath, data);
    } catch (err: unknown) {
      this.logger.error(
        `saveToDisk failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(
      () => this.saveToDisk(),
      TeamGraphStore.SAVE_DEBOUNCE_MS,
    );
  }

  // ── People CRUD ───────────────────────────────────────────────

  /**
   * Upsert a person by name. Returns the person's row ID.
   * Increments standup_count and updates last_seen on repeat encounters.
   */
  upsertPerson(name: string, date: string): number {
    const canonical = name.toLowerCase().trim();
    const existing = this._db.exec(
      "SELECT id FROM people WHERE canonical_name = ?",
      [canonical],
    );
    if (existing.length > 0 && existing[0].values.length > 0) {
      const id = existing[0].values[0][0] as number;
      this._db.run(
        `UPDATE people
         SET standup_count = standup_count + 1,
             last_seen = CASE WHEN last_seen < ? THEN ? ELSE last_seen END
         WHERE id = ?`,
        [date, date, id],
      );
      return id;
    }

    this._db.run(
      `INSERT INTO people (name, canonical_name, first_seen, last_seen, standup_count)
       VALUES (?, ?, ?, ?, 1)`,
      [name, canonical, date, date],
    );

    const result = this._db.exec("SELECT last_insert_rowid()");
    return result[0].values[0][0] as number;
  }

  /** Update a person's inferred role. */
  updateRole(personId: number, role: string): void {
    this._db.run("UPDATE people SET role = ? WHERE id = ?", [role, personId]);
    this.scheduleSave();
  }

  /** Merge partial trait observations into the person's trait JSON. */
  updateTraits(personId: number, newTraits: Record<string, unknown>): void {
    const row = this._db.exec("SELECT traits FROM people WHERE id = ?", [
      personId,
    ]);
    const existing: Record<string, unknown> =
      row.length > 0 ? JSON.parse(row[0].values[0][0] as string) : {};
    const merged = { ...existing, ...newTraits };
    this._db.run("UPDATE people SET traits = ? WHERE id = ?", [
      JSON.stringify(merged),
      personId,
    ]);
    this.scheduleSave();
  }

  /** Get a person by canonical name. */
  getPersonByName(name: string): PersonProfile | null {
    const canonical = name.toLowerCase().trim();
    const rows = this._db.exec(
      "SELECT * FROM people WHERE canonical_name = ?",
      [canonical],
    );
    if (!rows.length || !rows[0].values.length) return null;
    return this.rowToPerson(rows[0].columns, rows[0].values[0]);
  }

  /** List all known people, ordered by last_seen desc. */
  getAllPeople(): PersonProfile[] {
    const rows = this._db.exec("SELECT * FROM people ORDER BY last_seen DESC");
    if (!rows.length) return [];
    return rows[0].values.map((v: SqlValue[]) =>
      this.rowToPerson(rows[0].columns, v),
    );
  }

  private rowToPerson(columns: string[], values: SqlValue[]): PersonProfile {
    const obj: Record<string, unknown> = {};
    columns.forEach((c, i) => (obj[c] = values[i]));
    return {
      id: obj.id as number,
      name: obj.name as string,
      canonical_name: obj.canonical_name as string,
      role: (obj.role as string | null) ?? null,
      traits: JSON.parse((obj.traits as string) || "{}"),
      standup_count: obj.standup_count as number,
      commitment_count: obj.commitment_count as number,
      completion_count: obj.completion_count as number,
      first_seen: obj.first_seen as string,
      last_seen: obj.last_seen as string,
    };
  }

  // ── Relationship CRUD ─────────────────────────────────────────

  /**
   * Record or strengthen a relationship between two people.
   * If the edge already exists, weight is incremented.
   */
  upsertRelationship(
    sourceId: number,
    targetId: number,
    kind: RelationshipKind,
    metadata?: Record<string, unknown>,
  ): void {
    if (sourceId === targetId) return;
    const existing = this._db.exec(
      `SELECT id, weight FROM relationships
       WHERE source_person_id = ? AND target_person_id = ? AND kind = ?`,
      [sourceId, targetId, kind],
    );
    if (existing.length > 0 && existing[0].values.length > 0) {
      const id = existing[0].values[0][0] as number;
      const weight = (existing[0].values[0][1] as number) + 1;
      this._db.run(
        `UPDATE relationships
         SET weight = ?, metadata = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [weight, JSON.stringify(metadata ?? {}), id],
      );
    } else {
      this._db.run(
        `INSERT INTO relationships
           (source_person_id, target_person_id, kind, weight, metadata)
         VALUES (?, ?, ?, 1, ?)`,
        [sourceId, targetId, kind, JSON.stringify(metadata ?? {})],
      );
    }
  }

  /** Get all relationships for a person (outgoing + incoming). */
  getRelationshipsFor(personId: number): Relationship[] {
    const rows = this._db.exec(
      `SELECT * FROM relationships
       WHERE source_person_id = ? OR target_person_id = ?`,
      [personId, personId],
    );
    if (!rows.length) return [];
    return rows[0].values.map((v: SqlValue[]) =>
      this.rowToRelationship(rows[0].columns, v),
    );
  }

  /** Get the strongest collaborators for a person. */
  getTopCollaborators(
    personId: number,
    limit = 5,
  ): Array<{ person: PersonProfile; weight: number }> {
    const rows = this._db.exec(
      `SELECT
         CASE WHEN r.source_person_id = ? THEN r.target_person_id ELSE r.source_person_id END AS other_id,
         SUM(r.weight) AS total_weight
       FROM relationships r
       WHERE (r.source_person_id = ? OR r.target_person_id = ?)
         AND r.kind = 'collaborates_with'
       GROUP BY other_id
       ORDER BY total_weight DESC
       LIMIT ?`,
      [personId, personId, personId, limit],
    );
    if (!rows.length) return [];
    return rows[0].values.map((v: SqlValue[]) => {
      const otherId = v[0] as number;
      const weight = v[1] as number;
      const personRows = this._db.exec("SELECT * FROM people WHERE id = ?", [
        otherId,
      ]);
      const person =
        personRows.length && personRows[0].values.length
          ? this.rowToPerson(personRows[0].columns, personRows[0].values[0])
          : ({
              id: otherId,
              name: "Unknown",
              canonical_name: "unknown",
            } as PersonProfile);
      return { person, weight };
    });
  }

  private rowToRelationship(
    columns: string[],
    values: SqlValue[],
  ): Relationship {
    const obj: Record<string, unknown> = {};
    columns.forEach((c, i) => (obj[c] = values[i]));
    return {
      id: obj.id as number,
      source_person_id: obj.source_person_id as number,
      target_person_id: obj.target_person_id as number,
      kind: obj.kind as RelationshipKind,
      weight: obj.weight as number,
      metadata: JSON.parse((obj.metadata as string) || "{}"),
      updated_at: obj.updated_at as string,
    };
  }

  // ── Standup Storage ───────────────────────────────────────────

  /**
   * Store a parsed StandupRecord. Upserts people, creates commitments,
   * blockers, decisions, ticket mentions, and collaboration edges.
   * Replaces the MemoryTool-based storage.
   */
  storeStandup(record: StandupRecord): number {
    const db = this._db;
    db.run("BEGIN TRANSACTION");
    try {
      // Upsert standup row (ON CONFLICT replace)
      db.run(
        `INSERT INTO standups (date, team_name, raw_json)
         VALUES (?, ?, ?)
         ON CONFLICT(date, team_name) DO UPDATE SET raw_json = excluded.raw_json`,
        [record.date, record.teamName, JSON.stringify(record)],
      );
      const standupResult = db.exec(
        "SELECT id FROM standups WHERE date = ? AND team_name = ?",
        [record.date, record.teamName],
      );
      const standupId = standupResult[0].values[0][0] as number;

      // Clean out old child rows for this standup (idempotent re-ingest)
      db.run("DELETE FROM commitments WHERE standup_id = ?", [standupId]);
      db.run("DELETE FROM blockers WHERE standup_id = ?", [standupId]);
      db.run("DELETE FROM decisions WHERE standup_id = ?", [standupId]);
      db.run("DELETE FROM ticket_mentions WHERE standup_id = ?", [standupId]);

      // Upsert participants
      const personIds = new Map<string, number>();
      for (const name of record.participants) {
        personIds.set(
          name.toLowerCase().trim(),
          this.upsertPerson(name, record.date),
        );
      }

      // Store commitments
      for (const c of record.commitments) {
        const canonical = c.person.toLowerCase().trim();
        let pid = personIds.get(canonical);
        if (!pid) {
          pid = this.upsertPerson(c.person, record.date);
          personIds.set(canonical, pid);
        }
        db.run(
          `INSERT INTO commitments (standup_id, person_id, action, deadline, ticket_ids, status)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            standupId,
            pid,
            c.action,
            c.deadline ?? null,
            JSON.stringify(c.ticketIds),
            c.status,
          ],
        );
        db.run(
          "UPDATE people SET commitment_count = commitment_count + 1 WHERE id = ?",
          [pid],
        );
        if (c.status === "done") {
          db.run(
            "UPDATE people SET completion_count = completion_count + 1 WHERE id = ?",
            [pid],
          );
        }
      }

      // Store blockers
      for (const b of record.blockers) {
        const ownerId = personIds.get(b.owner.toLowerCase().trim()) ?? null;
        db.run(
          `INSERT INTO blockers (standup_id, blocked, blocked_by, owner_id, reason)
           VALUES (?, ?, ?, ?, ?)`,
          [standupId, b.blocked, b.blockedBy, ownerId, b.reason],
        );
      }

      // Store decisions
      for (const d of record.decisions) {
        db.run(
          `INSERT INTO decisions (standup_id, summary, participants)
           VALUES (?, ?, ?)`,
          [standupId, d.summary, JSON.stringify(d.participants)],
        );
      }

      // Store ticket mentions
      for (const t of record.ticketMentions) {
        const assigneeId = t.assignee
          ? (personIds.get(t.assignee.toLowerCase().trim()) ?? null)
          : null;
        db.run(
          `INSERT INTO ticket_mentions (standup_id, ticket_id, context, assignee_id)
           VALUES (?, ?, ?, ?)`,
          [standupId, t.id, t.context, assigneeId],
        );
      }

      // Build collaboration edges: every pair of participants
      const ids = [...personIds.values()];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          this.upsertRelationship(ids[i], ids[j], "collaborates_with", {
            standup_date: record.date,
          });
        }
      }

      // Build blocking edges — only to people committed on the blocked item
      for (const b of record.blockers) {
        const ownerId = personIds.get(b.owner.toLowerCase().trim());
        if (!ownerId) continue;

        const affectedCommitments = record.commitments.filter((c) => {
          if (c.person.toLowerCase().trim() === b.owner.toLowerCase().trim())
            return false;
          return c.ticketIds.some((tid) => b.blocked.includes(tid));
        });

        for (const c of affectedCommitments) {
          const targetId = personIds.get(c.person.toLowerCase().trim());
          if (targetId && targetId !== ownerId) {
            this.upsertRelationship(ownerId, targetId, "blocks", {
              blocked: b.blocked,
              reason: b.reason,
              standup_date: record.date,
            });
          }
        }
      }

      // Build LLM-detected relationship edges (reviews_for, reports_to, mentors)
      if (record.relationships?.length) {
        for (const rel of record.relationships) {
          const fromId = personIds.get(rel.from.toLowerCase().trim());
          const toId = personIds.get(rel.to.toLowerCase().trim());
          if (fromId && toId && fromId !== toId) {
            this.upsertRelationship(fromId, toId, rel.kind, {
              context: rel.context,
              standup_date: record.date,
            });
          }
        }
      }

      db.run("COMMIT");
      this.scheduleSave();
      this.logger.info(
        `Stored standup ${record.date} (${record.teamName}): ${record.commitments.length} commitments, ${personIds.size} people`,
      );
      return standupId;
    } catch (err) {
      db.run("ROLLBACK");
      this.logger.error(
        `storeStandup failed, rolled back: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /** Load all standups, most recent first. */
  loadStandups(limit = 50): StandupRecord[] {
    const rows = this._db.exec(
      "SELECT raw_json FROM standups ORDER BY date DESC LIMIT ?",
      [limit],
    );
    if (!rows.length) return [];
    return rows[0].values
      .map((v: SqlValue[]) => {
        try {
          return JSON.parse(v[0] as string) as StandupRecord;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as StandupRecord[];
  }

  /** Delete a standup by date and optional team name. CASCADE deletes children. */
  deleteStandup(date: string, teamName?: string): boolean {
    let result;
    if (teamName) {
      this._db.run("DELETE FROM standups WHERE date = ? AND team_name = ?", [
        date,
        teamName,
      ]);
      result = this._db.exec("SELECT changes()");
    } else {
      this._db.run("DELETE FROM standups WHERE date = ?", [date]);
      result = this._db.exec("SELECT changes()");
    }
    const deleted = (result[0]?.values[0]?.[0] as number) > 0;
    if (deleted) this.scheduleSave();
    return deleted;
  }

  /** Get recent standup summaries for webview hydration. */
  getRecentSummaries(limit = 10): Array<{
    date: string;
    teamName: string;
    commitmentCount: number;
    blockerCount: number;
    participantCount: number;
  }> {
    const rows = this._db.exec(
      `SELECT
         s.date,
         s.team_name,
         (SELECT COUNT(*) FROM commitments c WHERE c.standup_id = s.id) AS commitment_count,
         (SELECT COUNT(*) FROM blockers b WHERE b.standup_id = s.id) AS blocker_count,
         (SELECT COUNT(DISTINCT c2.person_id) FROM commitments c2 WHERE c2.standup_id = s.id) AS participant_count
       FROM standups s
       ORDER BY s.date DESC
       LIMIT ?`,
      [limit],
    );
    if (!rows.length) return [];
    return rows[0].values.map((v: SqlValue[]) => ({
      date: v[0] as string,
      teamName: v[1] as string,
      commitmentCount: v[2] as number,
      blockerCount: v[3] as number,
      participantCount: v[4] as number,
    }));
  }

  // ── Query helpers ─────────────────────────────────────────────

  /** Get a person's commitments across all standups. */
  getCommitmentsFor(
    personId: number,
    limit = 20,
  ): Array<Commitment & { date: string }> {
    const rows = this._db.exec(
      `SELECT c.action, c.deadline, c.ticket_ids, c.status, s.date, p.name
       FROM commitments c
       JOIN standups s ON c.standup_id = s.id
       JOIN people p ON c.person_id = p.id
       WHERE c.person_id = ?
       ORDER BY s.date DESC
       LIMIT ?`,
      [personId, limit],
    );
    if (!rows.length) return [];
    return rows[0].values.map((v: SqlValue[]) => ({
      person: v[5] as string,
      action: v[0] as string,
      deadline: v[1] as string | null,
      ticketIds: JSON.parse(v[2] as string),
      status: v[3] as "pending" | "done",
      date: v[4] as string,
    }));
  }

  private static readonly DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  private assertDateFormat(value: string, field: string): void {
    if (!TeamGraphStore.DATE_RE.test(value)) {
      throw new Error(
        `Invalid date format for ${field}: "${value}". Expected YYYY-MM-DD.`,
      );
    }
  }

  /** Get standups filtered by date range. */
  getStandupsByDateRange(since: string, until = "9999-12-31"): StandupRecord[] {
    this.assertDateFormat(since, "since");
    this.assertDateFormat(until, "until");

    const rows = this._db.exec(
      "SELECT raw_json FROM standups WHERE date >= ? AND date <= ? ORDER BY date DESC",
      [since, until],
    );
    if (!rows.length) return [];
    return rows[0].values.flatMap((v: SqlValue[]) => {
      try {
        return [JSON.parse(v[0] as string) as StandupRecord];
      } catch {
        return [];
      }
    });
  }

  /** Find standups mentioning a specific ticket ID. */
  getStandupsByTicket(ticketId: string): StandupRecord[] {
    const rows = this._db.exec(
      `SELECT DISTINCT s.raw_json
       FROM ticket_mentions tm
       JOIN standups s ON tm.standup_id = s.id
       WHERE tm.ticket_id = ?
       ORDER BY s.date DESC`,
      [ticketId],
    );
    if (!rows.length) return [];
    return rows[0].values
      .map((v: SqlValue[]) => {
        try {
          return JSON.parse(v[0] as string) as StandupRecord;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as StandupRecord[];
  }

  /** Prune standups older than `maxCount`, keeping the most recent. Atomic via single DELETE. */
  pruneOldStandups(maxCount = 30): number {
    this._db.run(
      `DELETE FROM standups WHERE id NOT IN (
         SELECT id FROM standups ORDER BY date DESC LIMIT ?
       )`,
      [maxCount],
    );
    const result = this._db.exec("SELECT changes()");
    const deleted = (result[0]?.values[0]?.[0] as number) ?? 0;
    if (deleted > 0) this.scheduleSave();
    return deleted;
  }

  private static readonly MAX_TEAM_SUMMARY_PEOPLE = 20;

  /** Get a team profile summary — useful for LLM context. */
  getTeamSummary(): string {
    if (!this.isReady()) return "No team members tracked yet.";

    const people = this.getAllPeople();
    if (people.length === 0) return "No team members tracked yet.";

    let summary = `## Team Profile (${people.length} members)\n\n`;
    for (const p of people.slice(0, TeamGraphStore.MAX_TEAM_SUMMARY_PEOPLE)) {
      const completionRate =
        p.commitment_count > 0
          ? Math.round((p.completion_count / p.commitment_count) * 100)
          : 0;
      summary += `- **${p.name}**`;
      if (p.role) summary += ` (${p.role})`;
      const expertise = p.traits.expertise as string[] | undefined;
      if (expertise?.length) summary += ` [${expertise.join(", ")}]`;
      summary += ` — ${p.standup_count} standups, ${p.commitment_count} commitments`;
      if (p.commitment_count > 0) summary += ` (${completionRate}% done)`;
      summary += `, last seen ${p.last_seen}\n`;
    }

    // Top collaborations
    const relRows = this._db.exec(
      `SELECT p1.name, p2.name, r.weight
       FROM relationships r
       JOIN people p1 ON r.source_person_id = p1.id
       JOIN people p2 ON r.target_person_id = p2.id
       WHERE r.kind = 'collaborates_with'
       ORDER BY r.weight DESC
       LIMIT 5`,
    );
    if (relRows.length && relRows[0].values.length) {
      summary += "\n### Strongest Collaborations\n";
      for (const v of relRows[0].values) {
        summary += `- ${v[0]} ↔ ${v[1]} (${v[2]} meetings together)\n`;
      }
    }

    // Recurring blockers
    const blockerRows = this._db.exec(
      `SELECT p.name, COUNT(*) AS block_count
       FROM blockers b
       JOIN people p ON b.owner_id = p.id
       GROUP BY p.id
       HAVING block_count >= 2
       ORDER BY block_count DESC
       LIMIT 5`,
    );
    if (blockerRows.length && blockerRows[0].values.length) {
      summary += "\n### Frequent Blockers\n";
      for (const v of blockerRows[0].values) {
        summary += `- ${v[0]} (blocked ${v[1]} times)\n`;
      }
    }

    return summary;
  }

  /** Get a detailed person profile for the agent. */
  getPersonProfile(name: string): string {
    const person = this.getPersonByName(name);
    if (!person) return `No profile found for "${name}".`;

    const completionRate =
      person.commitment_count > 0
        ? Math.round((person.completion_count / person.commitment_count) * 100)
        : 0;

    let profile = `## ${person.name}\n`;
    if (person.role) profile += `**Role:** ${person.role}\n`;
    const expertise = person.traits.expertise as string[] | undefined;
    if (expertise?.length)
      profile += `**Expertise:** ${expertise.join(", ")}\n`;
    const workStyle = person.traits.workStyle as string | undefined;
    if (workStyle) profile += `**Work Style:** ${workStyle}\n`;
    profile += `**Stats:** ${person.standup_count} standups, ${person.commitment_count} commitments (${completionRate}% completed)\n`;
    profile += `**Active since:** ${person.first_seen} — last seen ${person.last_seen}\n\n`;

    // Recent commitments
    const commitments = this.getCommitmentsFor(person.id, 5);
    if (commitments.length) {
      profile += "### Recent Commitments\n";
      for (const c of commitments) {
        const status = c.status === "done" ? "✅" : "⬜";
        profile += `- ${status} ${c.action} (${c.date})\n`;
      }
      profile += "\n";
    }

    // Top collaborators
    const collabs = this.getTopCollaborators(person.id, 5);
    if (collabs.length) {
      profile += "### Top Collaborators\n";
      for (const { person: p, weight } of collabs) {
        profile += `- ${p.name} (${weight} meetings together)\n`;
      }
    }

    return profile;
  }

  /** Get people/tickets that appear in blockers repeatedly. */
  getRecurringBlockers(minCount = 2): string {
    const rows = this._db.exec(
      `SELECT p.name, COUNT(*) AS block_count, GROUP_CONCAT(DISTINCT b.blocked) AS items
       FROM blockers b
       JOIN people p ON b.owner_id = p.id
       GROUP BY p.id
       HAVING block_count >= ?
       ORDER BY block_count DESC`,
      [minCount],
    );
    if (!rows.length || !rows[0].values.length)
      return "No recurring blockers found.";

    let out = "## Recurring Blockers\n\n";
    for (const v of rows[0].values) {
      out += `- **${v[0]}** — blocked ${v[1]} times (items: ${v[2]})\n`;
    }
    return out;
  }

  /** Get commitment completion rate trends by week for a person. */
  getCompletionTrends(personId: number, weeks = 8): string {
    const rows = this._db.exec(
      `SELECT
         strftime('%Y-W%W', s.date) AS week,
         COUNT(CASE WHEN c.status = 'done' THEN 1 END) AS completed,
         COUNT(*) AS total
       FROM commitments c
       JOIN standups s ON c.standup_id = s.id
       WHERE c.person_id = ?
       GROUP BY week
       ORDER BY week DESC
       LIMIT ?`,
      [personId, weeks],
    );
    if (!rows.length || !rows[0].values.length)
      return "No commitment data found.";

    let out =
      "## Completion Trends\n\n| Week | Completed | Total | Rate |\n|------|-----------|-------|------|\n";
    for (const v of rows[0].values) {
      const completed = v[1] as number;
      const total = v[2] as number;
      const rate = total > 0 ? Math.round((completed / total) * 100) : 0;
      out += `| ${v[0]} | ${completed} | ${total} | ${rate}% |\n`;
    }
    return out;
  }

  /** Get full history for a specific ticket across all standups. */
  getTicketHistory(ticketId: string): string {
    // Validate ticket ID: strip optional # prefix, allow only alphanumeric + dash/underscore
    const normalized = ticketId.replace(/^#/, "").trim();
    if (!/^[A-Za-z0-9_\-]+$/.test(normalized)) {
      return `Invalid ticket ID format: "${ticketId}". Use alphanumeric characters, dashes, or underscores only.`;
    }

    // Mentions
    const mentionRows = this._db.exec(
      `SELECT s.date, s.team_name, tm.context, p.name
       FROM ticket_mentions tm
       JOIN standups s ON tm.standup_id = s.id
       LEFT JOIN people p ON tm.assignee_id = p.id
       WHERE tm.ticket_id = ?
       ORDER BY s.date DESC`,
      [normalized],
    );

    // Commitments referencing this ticket
    const likePattern = `%"${normalized}"%`;
    const commitRows = this._db.exec(
      `SELECT s.date, p.name, c.action, c.status
       FROM commitments c
       JOIN standups s ON c.standup_id = s.id
       JOIN people p ON c.person_id = p.id
       WHERE c.ticket_ids LIKE ?
       ORDER BY s.date DESC`,
      [likePattern],
    );

    if (
      (!mentionRows.length || !mentionRows[0].values.length) &&
      (!commitRows.length || !commitRows[0].values.length)
    ) {
      return `No history found for ticket "${normalized}".`;
    }

    let out = `## Ticket #${normalized} History\n\n`;

    if (mentionRows.length && mentionRows[0].values.length) {
      out += "### Mentions\n";
      for (const v of mentionRows[0].values) {
        const assignee = v[3] ? ` (${v[3]})` : "";
        out += `- **${v[0]}** ${v[1]}: ${v[2]}${assignee}\n`;
      }
      out += "\n";
    }

    if (commitRows.length && commitRows[0].values.length) {
      out += "### Related Commitments\n";
      for (const v of commitRows[0].values) {
        const status = v[3] === "done" ? "✅" : "⬜";
        out += `- ${status} **${v[0]}** ${v[1]}: ${v[2]}\n`;
      }
    }

    return out;
  }

  /** Aggregate team health metrics. */
  getTeamHealth(): string {
    const people = this.getAllPeople();
    if (people.length === 0) return "No team data available yet.";

    const totalCommitments = people.reduce((s, p) => s + p.commitment_count, 0);
    const totalCompleted = people.reduce((s, p) => s + p.completion_count, 0);
    const avgCompletion =
      totalCommitments > 0
        ? Math.round((totalCompleted / totalCommitments) * 100)
        : 0;

    const totalStandups = this._db.exec("SELECT COUNT(*) FROM standups");
    const standupCount = (totalStandups[0]?.values[0]?.[0] as number) ?? 0;

    const blockerCount = this._db.exec("SELECT COUNT(*) FROM blockers");
    const totalBlockers = (blockerCount[0]?.values[0]?.[0] as number) ?? 0;

    const relCount = this._db.exec(
      "SELECT COUNT(*) FROM relationships WHERE kind = 'collaborates_with'",
    );
    const totalEdges = (relCount[0]?.values[0]?.[0] as number) ?? 0;

    let out = "## Team Health Dashboard\n\n";
    out += `- **Team Size:** ${people.length} members\n`;
    out += `- **Total Standups:** ${standupCount}\n`;
    out += `- **Avg Completion Rate:** ${avgCompletion}%\n`;
    out += `- **Total Blockers Recorded:** ${totalBlockers}\n`;
    out += `- **Collaboration Edges:** ${totalEdges}\n\n`;

    // Top performers
    const sorted = [...people]
      .filter((p) => p.commitment_count >= 3)
      .sort((a, b) => {
        const rateA = a.completion_count / (a.commitment_count || 1);
        const rateB = b.completion_count / (b.commitment_count || 1);
        return rateB - rateA;
      });
    if (sorted.length) {
      out += "### Top Performers (by completion rate)\n";
      for (const p of sorted.slice(0, 5)) {
        const rate = Math.round(
          (p.completion_count / p.commitment_count) * 100,
        );
        out += `- ${p.name}: ${rate}% (${p.completion_count}/${p.commitment_count})\n`;
      }
    }

    return out;
  }
}
