/**
 * Hybrid search service: BM25 full-text + vector similarity + temporal decay + MMR.
 *
 * Combines FTS5 keyword recall with vector semantic similarity via weighted
 * score fusion, then applies optional temporal decay and diversity re-ranking.
 *
 * @see OpenClaw reference: openclaw/src/memory/hybrid.ts
 */

import { Logger, LogLevel } from "../infrastructure/logger/logger";
import {
  applyTemporalDecay,
  DEFAULT_TEMPORAL_DECAY_CONFIG,
  type TemporalDecayConfig,
} from "./temporal-decay";
import { applyMMR, DEFAULT_MMR_CONFIG, type MMRConfig } from "./mmr";

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
  /** Weight for FTS5 (keyword) scores. Default: 0.3. */
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

/** Intermediate FTS5 result from the keyword store. */
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

// ─── FTS5 Helpers ─────────────────────────────────────────────────────

/**
 * Build an FTS5 MATCH query from raw user input.
 *
 * Tokenizes on Unicode word boundaries, strips quotes, wraps each token in
 * double quotes, and AND-joins them. Returns null if no valid tokens remain.
 */
export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((t) => `"${t.replaceAll('"', "")}"`).join(" AND ");
}

/**
 * Convert an FTS5 `bm25()` rank value to a [0, 1) score.
 *
 * FTS5 rank() returns negative BM25 relevance (more negative = more relevant).
 * This maps it to a 0–1 range via `relevance / (1 + relevance)`.
 */
export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) {
    return 1 / (1 + 999);
  }
  // FTS5 returns negative BM25 scores (more negative = more relevant)
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  // Positive rank = ordinal position (rank 0 is best)
  return 1 / (1 + rank);
}

// ─── Fusion ───────────────────────────────────────────────────────────

/**
 * Merge vector and keyword results by ID, apply weighted score fusion,
 * temporal decay, and optional MMR diversity re-ranking.
 */
export function mergeHybridResults(params: {
  vector: VectorHit[];
  keyword: KeywordHit[];
  config?: Partial<HybridSearchConfig>;
}): HybridSearchResult[] {
  const cfg = { ...DEFAULT_HYBRID_CONFIG, ...params.config };

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
      cfg.vectorWeight * entry.vectorScore + cfg.textWeight * entry.textScore,
    chunkType: entry.chunkType,
    language: entry.language,
    indexedAt: entry.indexedAt,
  }));

  // ── 3. Temporal decay ──────────────────────────────────────────────
  const decayConfig = {
    ...DEFAULT_TEMPORAL_DECAY_CONFIG,
    ...cfg.temporalDecay,
  };
  merged = applyTemporalDecay(merged, decayConfig, cfg.nowMs);

  // ── 4. Sort by score ───────────────────────────────────────────────
  merged.sort((a, b) => b.score - a.score);

  // ── 5. MMR diversity re-ranking ────────────────────────────────────
  const mmrConfig = { ...DEFAULT_MMR_CONFIG, ...cfg.mmr };
  if (mmrConfig.enabled) {
    merged = applyMMR(merged, mmrConfig);
  }

  // ── 6. Top-K ──────────────────────────────────────────────────────
  return merged.slice(0, cfg.topK);
}

// ─── Service (singleton) ──────────────────────────────────────────────

/**
 * HybridSearchService — singleton that orchestrates FTS5 + vector search
 * against the SqliteVectorStore database.
 */
export class HybridSearchService {
  private static instance: HybridSearchService;
  private readonly logger: Logger;
  /** Reference to the sql.js db from SqliteVectorStore */
  private db: any = null;
  private ftsInitialized = false;

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
   * Attach to the sql.js database and ensure the FTS5 virtual table exists.
   * Must be called after SqliteVectorStore.initialize().
   */
  initializeFts(db: any): void {
    if (this.ftsInitialized && this.db === db) {
      return;
    }
    this.db = db;
    this.createFtsTables();
    this.ftsInitialized = true;
    this.logger.info("FTS5 virtual table initialized");
  }

  get isReady(): boolean {
    return this.ftsInitialized && this.db !== null;
  }

  // ── FTS5 Schema ─────────────────────────────────────────────────────

  private createFtsTables(): void {
    // FTS5 content-sync table — mirrors the `text` column from `chunks`.
    // content=chunks tells FTS5 to read from the chunks table (external content).
    // We use a dedicated FTS table for insert-only (no content=) for simplicity
    // since sql.js FTS5 support with external content can be tricky.
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        content='chunks',
        content_rowid='rowid'
      )
    `);

    // Triggers to keep FTS5 in sync with the chunks table
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
      END
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      END
    `);

    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
        INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
      END
    `);

    // Back-fill: populate FTS from any existing chunks that lack FTS entries.
    // This is a one-time migration for databases created before FTS5 was added.
    this.backfillFts();
  }

  /**
   * One-time back-fill: insert existing chunks text into FTS5.
   * Idempotent — checks row count before proceeding.
   */
  private backfillFts(): void {
    try {
      const ftsCountResult = this.db.exec("SELECT COUNT(*) FROM chunks_fts");
      const ftsCount = ftsCountResult?.[0]?.values?.[0]?.[0] ?? 0;

      const chunksCountResult = this.db.exec("SELECT COUNT(*) FROM chunks");
      const chunksCount = chunksCountResult?.[0]?.values?.[0]?.[0] ?? 0;

      if (ftsCount < chunksCount) {
        this.logger.info(
          `Back-filling FTS5 index: ${chunksCount - ftsCount} chunks to index`,
        );
        // Rebuild from scratch for safety
        this.db.run("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
        this.logger.info("FTS5 back-fill complete");
      }
    } catch (err: any) {
      this.logger.warn(`FTS5 back-fill failed: ${err.message}`);
    }
  }

  // ── FTS5 Search ─────────────────────────────────────────────────────

  /**
   * Run an FTS5 full-text search and return scored keyword hits.
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
      const stmt = this.db.prepare(`
        SELECT
          c.id,
          c.text,
          c.file_path,
          c.start_line,
          c.end_line,
          c.chunk_type,
          c.language,
          c.indexed_at,
          chunks_fts.rank
        FROM chunks_fts
        JOIN chunks c ON c.rowid = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
        ORDER BY chunks_fts.rank
        LIMIT ?
      `);
      stmt.bind([ftsQuery, k]);

      while (stmt.step()) {
        const row = stmt.getAsObject();
        results.push({
          id: row.id as string,
          filePath: row.file_path as string,
          startLine: row.start_line as number,
          endLine: row.end_line as number,
          snippet: row.text as string,
          textScore: bm25RankToScore(row.rank as number),
          chunkType: row.chunk_type as string,
          language: row.language as string,
          indexedAt: row.indexed_at as string | undefined,
        });
      }
      stmt.free();
    } catch (err: any) {
      this.logger.warn(`FTS5 search failed: ${err.message}`);
    }

    return results;
  }

  // ── Vector Search → VectorHit adapter ──────────────────────────────

  /**
   * Run a vector cosine-similarity search and return VectorHit items.
   * Delegates to the raw sql.js query for efficiency (avoids materializing
   * VectorDocument objects we would immediately throw away).
   */
  async vectorSearch(
    queryVector: number[],
    k = 10,
    threshold = 0.0,
  ): Promise<VectorHit[]> {
    if (!this.isReady) {
      return [];
    }

    const results: VectorHit[] = [];
    const stmt = this.db.prepare(
      "SELECT id, text, vector, file_path, start_line, end_line, chunk_type, language, indexed_at FROM chunks WHERE vector IS NOT NULL",
    );

    let count = 0;
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const vectorBlob = row.vector as Uint8Array;
      if (!vectorBlob || vectorBlob.length === 0) {
        continue;
      }
      const vector = new Float32Array(
        vectorBlob.buffer,
        vectorBlob.byteOffset,
        vectorBlob.byteLength / 4,
      );
      const score = cosineSimilarity(queryVector, vector);
      if (score >= threshold) {
        results.push({
          id: row.id as string,
          filePath: row.file_path as string,
          startLine: row.start_line as number,
          endLine: row.end_line as number,
          snippet: row.text as string,
          vectorScore: score,
          chunkType: row.chunk_type as string,
          language: row.language as string,
          indexedAt: row.indexed_at as string | undefined,
        });
      }
      count++;
      if (count % 500 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    stmt.free();

    results.sort((a, b) => b.vectorScore - a.vectorScore);
    return results.slice(0, k);
  }

  // ── Hybrid Search (public API) ─────────────────────────────────────

  /**
   * Run hybrid search: vector + FTS5, merge, decay, MMR, top-K.
   *
   * @param queryVector — embedding of the user query (or undefined to skip vector)
   * @param queryText   — raw user query for FTS5 matching
   * @param config      — search configuration overrides
   */
  async search(
    queryVector: number[] | undefined,
    queryText: string,
    config?: Partial<HybridSearchConfig>,
  ): Promise<HybridSearchResult[]> {
    const cfg = { ...DEFAULT_HYBRID_CONFIG, ...config };
    const k = Math.max(cfg.topK, 20); // over-fetch before fusion

    // Run vector + FTS5 in parallel
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

function cosineSimilarity(a: number[], b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
