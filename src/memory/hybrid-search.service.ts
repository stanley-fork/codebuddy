/**
 * Hybrid search service: BM25 full-text + vector similarity + temporal decay + MMR.
 *
 * Combines FTS4 keyword recall with vector semantic similarity via weighted
 * score fusion, then applies optional temporal decay and diversity re-ranking.
 * Uses FTS4 (not FTS5) because sql.js's default WASM build only includes FTS3/FTS4.
 */

import { Logger, LogLevel } from "../infrastructure/logger/logger";
import {
  applyTemporalDecay,
  DEFAULT_TEMPORAL_DECAY_CONFIG,
  type TemporalDecayConfig,
} from "./temporal-decay";
import { applyMMR, DEFAULT_MMR_CONFIG, type MMRConfig } from "./mmr";
import type { SqlJsDatabase, SqlJsStatement } from "../types/sql-js.d";

export type { SqlJsDatabase, SqlJsStatement };

// ─── Types ────────────────────────────────────────────────────────────

export interface HybridSearchResult {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  chunkType: string;
  language: string;
  indexedAt?: string;
}

export interface HybridSearchConfig {
  /** Weight for vector (semantic) scores. Default: 0.7. */
  vectorWeight: number;
  /** Weight for FTS4 (keyword) scores. Default: 0.3. */
  textWeight: number;
  /** Maximum results to return. Default: 10. */
  topK: number;
  /** MMR re-ranking configuration. */
  mmr: Partial<MMRConfig>;
  /** Temporal decay configuration. */
  temporalDecay: Partial<TemporalDecayConfig>;
  /** Reference timestamp (ms) for decay. Default: Date.now(). */
  nowMs?: number;
}

export const DEFAULT_HYBRID_CONFIG: HybridSearchConfig = {
  vectorWeight: 0.7,
  textWeight: 0.3,
  topK: 10,
  mmr: DEFAULT_MMR_CONFIG,
  temporalDecay: DEFAULT_TEMPORAL_DECAY_CONFIG,
};

/** Intermediate vector result from the vector store. */
export interface VectorHit {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
  vectorScore: number;
  chunkType: string;
  language: string;
  indexedAt?: string;
}

/** Intermediate FTS4 result from the keyword store. */
export interface KeywordHit {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
  textScore: number;
  chunkType: string;
  language: string;
  indexedAt?: string;
}

// ─── FTS Helpers ──────────────────────────────────────────────────────

const MAX_FTS_TOKENS = 32;
const MAX_TOKEN_LENGTH = 128;

/**
 * Build an FTS4 MATCH query from raw user input.
 *
 * Tokenizes on Unicode word boundaries, strips quotes, wraps each token in
 * double quotes, and AND-joins them. Returns null if no valid tokens remain.
 * Input is bounded to prevent degenerate SQL generation.
 */
export function buildFtsQuery(raw: string): string | null {
  if (!raw || typeof raw !== "string") {
    return null;
  }

  // Truncate input before regex to avoid ReDoS on huge strings
  const truncated = raw.slice(0, 4096);

  const tokens = (truncated.match(/[\p{L}\p{N}_]+/gu) ?? [])
    .map((t) => t.slice(0, MAX_TOKEN_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_FTS_TOKENS);

  if (tokens.length === 0) {
    return null;
  }

  // FTS5 safe: double-quote wrapping with internal quote removal
  // (FTS4 also supports double-quoted phrase matching)
  return tokens.map((t) => `"${t.replaceAll('"', "")}"`).join(" AND ");
}

const BM25_NAN_FALLBACK_SCORE = 0.001;

/**
 * Compute a BM25-like relevance score from FTS4 matchinfo('pcx') data.
 *
 * The 'pcx' format returns:
 *   p = number of matchable phrases in the query
 *   c = number of columns in the FTS table
 *   x = for each (phrase, column) pair: [hits_this_row, hits_all_rows, docs_with_hit]
 *
 * We compute a simplified BM25 score:
 *   score = Σ over phrases: tf × log(N / df)
 * where tf = hits in this row, N = total docs, df = docs containing this phrase.
 * Returns a value in [0, 1) via the standard normalization.
 */
export function computeFts4Score(matchinfoBlob: Uint8Array): number {
  if (matchinfoBlob.byteLength < 8) {
    return BM25_NAN_FALLBACK_SCORE;
  }

  // Ensure 4-byte alignment via copy into fresh ArrayBuffer.
  // matchinfo() returns a raw blob; creating Int32Array from a Uint8Array's
  // buffer may violate alignment on some JS engines if byteOffset % 4 !== 0.
  const aligned = new ArrayBuffer(matchinfoBlob.byteLength);
  new Uint8Array(aligned).set(matchinfoBlob);
  const ints = new Int32Array(aligned);

  const p = ints[0]; // number of phrases
  const c = ints[1]; // number of columns (always 1 for our table)

  if (p <= 0 || c <= 0 || ints.length < 2 + p * c * 3) {
    return BM25_NAN_FALLBACK_SCORE;
  }

  let rawScore = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < c; j++) {
      const offset = 2 + (i * c + j) * 3;
      const hitsThisRow = ints[offset]; // term frequency in this doc
      const docsWithHit = ints[offset + 2]; // document frequency

      if (hitsThisRow > 0 && docsWithHit > 0) {
        rawScore += hitsThisRow / docsWithHit;
      }
    }
  }

  return rawScore <= 0 ? BM25_NAN_FALLBACK_SCORE : rawScore / (1 + rawScore);
}

// ─── Fusion ───────────────────────────────────────────────────────────

/**
 * Merge vector and keyword results by ID, apply weighted score fusion,
 * temporal decay, and optional MMR diversity re-ranking.
 */
/**
 * Resolve a partial config into a complete HybridSearchConfig.
 * Uses explicit property resolution (not spread) so every field is visible.
 */
export function resolveHybridConfig(
  input: Partial<HybridSearchConfig>,
): HybridSearchConfig {
  return {
    vectorWeight: input.vectorWeight ?? DEFAULT_HYBRID_CONFIG.vectorWeight,
    textWeight: input.textWeight ?? DEFAULT_HYBRID_CONFIG.textWeight,
    topK: input.topK ?? DEFAULT_HYBRID_CONFIG.topK,
    nowMs: input.nowMs,
    mmr: {
      enabled: input.mmr?.enabled ?? DEFAULT_MMR_CONFIG.enabled,
      lambda: input.mmr?.lambda ?? DEFAULT_MMR_CONFIG.lambda,
    },
    temporalDecay: {
      enabled:
        input.temporalDecay?.enabled ?? DEFAULT_TEMPORAL_DECAY_CONFIG.enabled,
      halfLifeDays:
        input.temporalDecay?.halfLifeDays ??
        DEFAULT_TEMPORAL_DECAY_CONFIG.halfLifeDays,
    },
  };
}

export function mergeHybridResults(params: {
  vector: VectorHit[];
  keyword: KeywordHit[];
  config?: Partial<HybridSearchConfig>;
}): HybridSearchResult[] {
  const cfg = resolveHybridConfig(params.config ?? {});

  // Normalize weights to sum to 1.0 for consistent scoring
  const weightSum = cfg.vectorWeight + cfg.textWeight;
  const normalizedVectorWeight =
    weightSum > 0 ? cfg.vectorWeight / weightSum : 0.5;
  const normalizedTextWeight = weightSum > 0 ? cfg.textWeight / weightSum : 0.5;

  // ── 1. Union by ID ──────────────────────────────────────────────────
  const byId = new Map<
    string,
    {
      id: string;
      filePath: string;
      startLine: number;
      endLine: number;
      snippet: string;
      vectorScore: number;
      textScore: number;
      chunkType: string;
      language: string;
      indexedAt?: string;
    }
  >();

  for (const r of params.vector) {
    byId.set(r.id, {
      id: r.id,
      filePath: r.filePath,
      startLine: r.startLine,
      endLine: r.endLine,
      snippet: r.snippet,
      vectorScore: r.vectorScore,
      textScore: 0,
      chunkType: r.chunkType,
      language: r.language,
      indexedAt: r.indexedAt,
    });
  }

  for (const r of params.keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
      // Prefer keyword snippet (shows BM25 match context)
      if (r.snippet && r.snippet.length > 0) {
        existing.snippet = r.snippet;
      }
    } else {
      byId.set(r.id, {
        id: r.id,
        filePath: r.filePath,
        startLine: r.startLine,
        endLine: r.endLine,
        snippet: r.snippet,
        vectorScore: 0,
        textScore: r.textScore,
        chunkType: r.chunkType,
        language: r.language,
        indexedAt: r.indexedAt,
      });
    }
  }

  // ── 2. Weighted score fusion ────────────────────────────────────────
  let merged: HybridSearchResult[] = Array.from(byId.values()).map((entry) => ({
    id: entry.id,
    filePath: entry.filePath,
    startLine: entry.startLine,
    endLine: entry.endLine,
    snippet: entry.snippet,
    score:
      normalizedVectorWeight * entry.vectorScore +
      normalizedTextWeight * entry.textScore,
    chunkType: entry.chunkType,
    language: entry.language,
    indexedAt: entry.indexedAt,
  }));

  // ── 3. Temporal decay ──────────────────────────────────────────────
  merged = applyTemporalDecay(merged, cfg.temporalDecay, cfg.nowMs);

  // ── 4. Sort by score ───────────────────────────────────────────────
  merged.sort((a, b) => b.score - a.score);

  // ── 5. MMR diversity re-ranking ────────────────────────────────────
  if (cfg.mmr.enabled) {
    merged = applyMMR(merged, cfg.mmr);
  }

  // ── 6. Top-K ──────────────────────────────────────────────────────
  return merged.slice(0, cfg.topK);
}

// ─── Service (singleton) ──────────────────────────────────────────────

/**
 * HybridSearchService — singleton that orchestrates FTS4 + vector search
 * against the SqliteVectorStore database.
 */
export class HybridSearchService {
  private static instance: HybridSearchService;
  private readonly logger: Logger;
  /** Reference to the sql.js db from SqliteVectorStore */
  private db: SqlJsDatabase | null = null;
  private ftsInitialized = false;
  private initPromise: Promise<void> | null = null;
  private initializedForDb: SqlJsDatabase | null = null;
  private vectorSearchStmt: SqlJsStatement | null = null;
  private ftsSearchStmt: SqlJsStatement | null = null;
  private static readonly VECTOR_SCAN_LIMIT = 5000;
  /** Time budget (ms) per synchronous burst before yielding to the event loop. */
  private static readonly YIELD_BUDGET_MS = 8;

  private constructor() {
    this.logger = Logger.initialize("HybridSearchService", {
      minLevel: LogLevel.DEBUG,
      enableConsole: true,
      enableFile: true,
      enableTelemetry: false,
    });
  }

  static getInstance(): HybridSearchService {
    return (HybridSearchService.instance ??= new HybridSearchService());
  }

  /**
   * Attach to the sql.js database and ensure the FTS4 virtual table exists.
   * Must be called after SqliteVectorStore.initialize().
   * Uses a promise-as-mutex pattern to prevent concurrent double-init.
   */
  async initializeFts(db: SqlJsDatabase): Promise<void> {
    // Already initialized for this exact db instance
    if (this.initializedForDb === db) {
      return;
    }

    // If initialization is in-flight, wait for it then re-check
    if (this.initPromise) {
      await this.initPromise;
      // Re-check: the completed init may have been for a different db
      if (this.initializedForDb === db) {
        return;
      }
    }

    // Reset state for new db (handles workspace switch)
    this.dispose();

    this.initPromise = (async () => {
      try {
        this.db = db;
        this.vectorSearchStmt = null;
        this.ftsSearchStmt = null;
        this.createFtsTables();
        this.initializedForDb = db;
        this.ftsInitialized = true;
        this.logger.info("FTS4 virtual table initialized");
      } finally {
        this.initPromise = null;
      }
    })();

    await this.initPromise;
  }

  get isReady(): boolean {
    return this.ftsInitialized && this.db !== null;
  }

  /**
   * Clean up resources. Must be called when the underlying database is
   * replaced (workspace change) or when the extension deactivates.
   */
  dispose(): void {
    if (this.vectorSearchStmt) {
      try {
        this.vectorSearchStmt.free();
      } catch {
        // Statement may already be freed if db was closed
      }
      this.vectorSearchStmt = null;
    }
    if (this.ftsSearchStmt) {
      try {
        this.ftsSearchStmt.free();
      } catch {
        // Statement may already be freed if db was closed
      }
      this.ftsSearchStmt = null;
    }
    this.db = null;
    this.ftsInitialized = false;
    this.initializedForDb = null;
    // Do NOT null initPromise here — an in-flight promise still resolves
    // and callers awaiting it would get a use-after-dispose scenario.
    // Instead, the finally block in initializeFts clears it.
    this.logger.info("HybridSearchService disposed");
  }

  // ── FTS4 Schema ─────────────────────────────────────────────────────

  /**
   * Detect and migrate a leftover FTS5 virtual table to FTS4.
   * Checks the CREATE statement in sqlite_master — FTS5 tables will
   * contain 'fts5' in their SQL. Drops everything and lets createFtsTables
   * recreate with FTS4.
   */
  private migrateFts5ToFts4(): void {
    try {
      const result = this.db!.exec(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_fts'",
      );
      if (result.length === 0 || !result[0].values[0]?.[0]) {
        return; // table doesn't exist yet — nothing to migrate
      }
      const createSql = (result[0].values[0][0] as string).toLowerCase();
      if (createSql.includes("fts5")) {
        this.logger.warn(
          "Detected FTS5 table from prior version. Migrating to FTS4...",
        );
        // Drop old triggers first, then the FTS5 table
        this.db!.run("DROP TRIGGER IF EXISTS chunks_ai");
        this.db!.run("DROP TRIGGER IF EXISTS chunks_ad");
        this.db!.run("DROP TRIGGER IF EXISTS chunks_au");
        this.db!.run("DROP TABLE IF EXISTS chunks_fts");
        this.logger.info(
          "FTS5 → FTS4 migration complete. Table will be recreated.",
        );
      }
    } catch (err: unknown) {
      this.logger.warn(
        `FTS5→FTS4 migration check failed: ${(err as Error).message}`,
      );
    }
  }

  private createFtsTables(): void {
    // Migrate from FTS5 → FTS4: if a prior version created the table with FTS5,
    // drop it and recreate with FTS4. Detect by querying sqlite_master.
    this.migrateFts5ToFts4();

    // Standalone FTS4 table — sql.js ships with FTS3/FTS4 enabled but not FTS5.
    // FTS4 supports unicode61 tokenizer, MATCH queries, and matchinfo().
    this.db!.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts4(
        text,
        tokenize=unicode61
      )
    `);

    // Triggers to keep FTS4 in sync with the chunks table.
    // FTS4 uses standard DELETE (unlike FTS5's special delete syntax).
    this.db!.run(`
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
      END
    `);

    this.db!.run(`
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        DELETE FROM chunks_fts WHERE rowid = old.rowid;
      END
    `);

    this.db!.run(`
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        DELETE FROM chunks_fts WHERE rowid = old.rowid;
        INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
      END
    `);

    // Back-fill: populate FTS from any existing chunks that lack FTS entries.
    // This is a one-time migration for databases created before FTS was added.
    this.backfillFts();
  }

  /**
   * One-time back-fill: insert existing chunks text into FTS4.
   * Idempotent — checks row count before proceeding.
   * Uses incremental insert for small deficits, full rebuild for large ones.
   */
  private backfillFts(): void {
    try {
      const ftsCount = Number(
        this.db!.exec("SELECT COUNT(*) FROM chunks_fts")?.[0]
          ?.values?.[0]?.[0] ?? 0,
      );
      const chunksCount = Number(
        this.db!.exec("SELECT COUNT(*) FROM chunks")?.[0]?.values?.[0]?.[0] ??
          0,
      );

      if (ftsCount >= chunksCount) {
        return;
      }

      const deficit = chunksCount - ftsCount;
      this.logger.info(`Back-filling FTS4 index: ${deficit} chunks to index`);

      if (deficit < 100) {
        // Anti-join: find chunks whose rowid is NOT in chunks_fts.
        // Handles rowid gaps from deleted rows (MAX(rowid) approach would miss them).
        this.db!.run(`
          INSERT INTO chunks_fts(rowid, text)
          SELECT c.rowid, c.text
          FROM chunks c
          WHERE NOT EXISTS (
            SELECT 1 FROM chunks_fts f WHERE f.rowid = c.rowid
          )
        `);
      } else {
        // Full rebuild for large deficits
        this.logger.warn(
          `Large FTS4 backfill (${deficit} chunks). This may take a moment.`,
        );
        this.db!.run("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
      }

      this.logger.info("FTS4 back-fill complete");
    } catch (err: unknown) {
      this.logger.warn(`FTS4 back-fill failed: ${(err as Error).message}`);
    }
  }

  // ── FTS4 Search ─────────────────────────────────────────────────────

  /**
   * Get or create a reusable prepared statement for FTS search.
   * Uses matchinfo('pcx') for BM25-like scoring since FTS4 has no built-in rank.
   */
  private getFtsSearchStmt(): SqlJsStatement {
    if (!this.ftsSearchStmt) {
      this.ftsSearchStmt = this.db!.prepare(`
        SELECT
          c.id,
          c.text,
          c.file_path,
          c.start_line,
          c.end_line,
          c.chunk_type,
          c.language,
          c.indexed_at,
          matchinfo(chunks_fts, 'pcx') as mi
        FROM chunks_fts
        JOIN chunks c ON c.rowid = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
        LIMIT ?
      `);
    }
    return this.ftsSearchStmt;
  }

  /**
   * Run an FTS4 full-text search and return scored keyword hits.
   */
  ftsSearch(query: string, k = 10): KeywordHit[] {
    if (!this.isReady) {
      return [];
    }

    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) {
      return [];
    }

    const results: KeywordHit[] = [];

    try {
      const stmt = this.getFtsSearchStmt();
      stmt.bind([ftsQuery, k * 2]); // over-fetch since we sort in JS

      while (stmt.step()) {
        const row = stmt.getAsObject();
        const mi = row.mi as Uint8Array;
        const textScore = mi ? computeFts4Score(mi) : BM25_NAN_FALLBACK_SCORE;
        results.push({
          id: row.id as string,
          filePath: row.file_path as string,
          startLine: row.start_line as number,
          endLine: row.end_line as number,
          snippet: row.text as string,
          textScore,
          chunkType: row.chunk_type as string,
          language: row.language as string,
          indexedAt: (row.indexed_at as string) ?? undefined,
        });
      }
      stmt.reset();

      // Sort by score descending and trim to k (FTS4 has no ORDER BY rank)
      results.sort((a, b) => b.textScore - a.textScore);
      return results.slice(0, k);
    } catch (err: unknown) {
      this.ftsSearchStmt = null; // invalidate on error
      this.logger.warn(`FTS4 search failed: ${(err as Error).message}`);
    }

    return results;
  }

  // ── Vector Search → VectorHit adapter ──────────────────────────────

  /**
   * Get or create a reusable prepared statement for vector search.
   */
  private getVectorSearchStmt(): SqlJsStatement {
    if (!this.vectorSearchStmt) {
      this.vectorSearchStmt = this.db!.prepare(`
        SELECT id, text, vector, file_path, start_line, end_line,
               chunk_type, language, indexed_at
        FROM chunks
        WHERE vector IS NOT NULL
        LIMIT ?
      `);
    }
    return this.vectorSearchStmt;
  }

  /**
   * Run a vector cosine-similarity search and return VectorHit items.
   *
   * Uses a bounded scan with a reusable prepared statement and a top-K
   * buffer to avoid materializing all results. Periodically yields to
   * the event loop to keep the extension host responsive.
   */
  async vectorSearch(
    queryVector: number[],
    k = 10,
    threshold = 0.0,
  ): Promise<VectorHit[]> {
    if (!this.isReady || queryVector.length === 0) {
      return [];
    }

    // Pre-normalize query vector once (avoids per-row normA recomputation)
    const qNorm = Math.sqrt(queryVector.reduce((s, v) => s + v * v, 0));
    if (qNorm === 0) {
      return [];
    }
    const qNormalized = queryVector.map((v) => v / qNorm);

    let stmt: SqlJsStatement;
    try {
      stmt = this.getVectorSearchStmt();
      stmt.bind([HybridSearchService.VECTOR_SCAN_LIMIT]);
    } catch (err) {
      this.vectorSearchStmt = null;
      this.logger.warn(
        `Vector search stmt preparation failed: ${(err as Error).message}`,
      );
      return [];
    }

    const topK: VectorHit[] = [];
    let worstTopKScore = -Infinity;
    let yieldDeadline = performance.now() + HybridSearchService.YIELD_BUDGET_MS;

    while (stmt.step()) {
      const row = stmt.getAsObject();
      const vectorBlob = row.vector as Uint8Array | null;
      if (!vectorBlob?.length) {
        continue;
      }

      // Aligned copy: prevents RangeError when byteOffset % 4 !== 0
      const aligned = new ArrayBuffer(vectorBlob.byteLength);
      new Uint8Array(aligned).set(vectorBlob);
      const vector = new Float32Array(aligned);

      // Dimension guard: skip mismatched vectors
      if (vector.length !== queryVector.length) {
        continue;
      }

      // Optimized: query is pre-normalized, only compute dot + dbNorm
      const score = dotProductNormalized(qNormalized, vector);
      if (score < threshold) {
        continue;
      }
      if (topK.length >= k && score <= worstTopKScore) {
        continue;
      }

      const hit: VectorHit = {
        id: row.id as string,
        filePath: row.file_path as string,
        startLine: row.start_line as number,
        endLine: row.end_line as number,
        snippet: row.text as string,
        vectorScore: score,
        chunkType: row.chunk_type as string,
        language: row.language as string,
        indexedAt: (row.indexed_at as string) ?? undefined,
      };

      insertSortedVectorHit(topK, hit, k);
      worstTopKScore = topK[topK.length - 1]?.vectorScore ?? -Infinity;

      // Time-based yield: adaptive, prevents frame drops regardless of vector size
      if (performance.now() > yieldDeadline) {
        await new Promise((resolve) => setImmediate(resolve));
        yieldDeadline = performance.now() + HybridSearchService.YIELD_BUDGET_MS;
      }
    }

    try {
      stmt.reset();
    } catch {
      this.vectorSearchStmt = null;
    }

    return topK;
  }

  // ── Hybrid Search (public API) ─────────────────────────────────────

  /**
   * Run hybrid search: vector + FTS4, merge, decay, MMR, top-K.
   *
   * @param queryVector — embedding of the user query (or undefined to skip vector)
   * @param queryText   — raw user query for FTS4 matching
   * @param config      — search configuration overrides
   */
  async search(
    queryVector: number[] | undefined,
    queryText: string,
    config?: Partial<HybridSearchConfig>,
  ): Promise<HybridSearchResult[]> {
    const cfg = { ...DEFAULT_HYBRID_CONFIG, ...config };
    const k = Math.max(cfg.topK, 20); // over-fetch before fusion

    // Run vector + FTS4 in parallel
    const [vectorHits, keywordHits] = await Promise.all([
      queryVector ? this.vectorSearch(queryVector, k) : Promise.resolve([]),
      Promise.resolve(this.ftsSearch(queryText, k)),
    ]);

    this.logger.info(
      `Hybrid search: ${vectorHits.length} vector + ${keywordHits.length} keyword hits`,
    );

    return mergeHybridResults({
      vector: vectorHits,
      keyword: keywordHits,
      config: cfg,
    });
  }

  /**
   * Keyword-only search (no embeddings needed).
   * Useful as a fast fallback when embedding generation fails.
   */
  keywordOnlySearch(
    queryText: string,
    config?: Partial<HybridSearchConfig>,
  ): HybridSearchResult[] {
    const cfg = { ...DEFAULT_HYBRID_CONFIG, ...config };
    const keywordHits = this.ftsSearch(queryText, cfg.topK * 2);

    return mergeHybridResults({
      vector: [],
      keyword: keywordHits,
      config: { ...cfg, vectorWeight: 0, textWeight: 1 },
    });
  }
}

// ─── Utility ──────────────────────────────────────────────────────────

/**
 * Insert a VectorHit into a descending-sorted array, maintaining sorted order
 * and capping at k elements. Uses binary search for O(log k) per insertion.
 */
function insertSortedVectorHit(
  arr: VectorHit[],
  hit: VectorHit,
  k: number,
): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].vectorScore > hit.vectorScore) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  arr.splice(lo, 0, hit);
  if (arr.length > k) {
    arr.pop();
  }
}

/**
 * Dot product between a pre-normalized query vector and an unnormalized db vector.
 * Since the query is already unit-length, we only need dot / ||db||.
 * Saves ~25% of inner-loop work vs full cosine similarity.
 */
function dotProductNormalized(qNorm: number[], db: Float32Array): number {
  let dot = 0;
  let dbNormSq = 0;
  for (let i = 0; i < qNorm.length; i++) {
    dot += qNorm[i] * db[i];
    dbNormSq += db[i] * db[i];
  }
  const dbNorm = Math.sqrt(dbNormSq);
  return dbNorm === 0 ? 0 : dot / dbNorm;
}
