/**
 * Question-Relevance Analyzer (Phase 3)
 *
 * Stage 1 of the two-pass analysis pipeline:
 *   1. Analyze the user question to identify relevant files, concepts, and sections
 *   2. Score and rank all analysis artifacts by relevance to the question
 *   3. Produce a FocusedContext — full code for top files, summaries for the next tier
 *
 * Builds on Phase 1's RelevanceScoring and Phase 2's architectural metadata.
 */

import type {
  CachedAnalysis,
  CodeSnippet,
  EndpointData,
  ModelData,
  CallGraphSummary,
} from "../../interfaces/analysis.interface";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of files to return with full code content */
export const TOP_FULL_CODE_FILES = 3;

/** Maximum number of files to return with summary only */
export const TOP_SUMMARY_FILES = 7;
/** Per-file content cap to prevent a single large file from dominating focused context */
const MAX_FILE_CONTENT_CHARS = 8000;
/** Max chars to scan for keyword scoring — keeps main-thread work bounded */
const MAX_SCORE_SCAN_CHARS = 8000;

/** Stop words excluded from keyword extraction */
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "must",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "its",
  "our",
  "their",
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "who",
  "whom",
  "how",
  "where",
  "when",
  "why",
  "and",
  "but",
  "or",
  "nor",
  "not",
  "so",
  "yet",
  "for",
  "with",
  "about",
  "between",
  "through",
  "during",
  "before",
  "after",
  "in",
  "on",
  "at",
  "to",
  "from",
  "of",
  "by",
  "up",
  "out",
  "if",
  "then",
  "else",
  "than",
  "too",
  "very",
  "just",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "only",
  "same",
]);

/**
 * Domain terms that indicate the user cares about a specific architectural concept.
 * Maps keywords → analysis sections they correlate with.
 */
const DOMAIN_SIGNALS: ReadonlyMap<string, readonly string[]> =
  /* @__PURE__ */ Object.freeze(
    new Map([
      ["auth", ["middleware", "endpoints"]],
      ["authentication", ["middleware", "endpoints"]],
      ["authorization", ["middleware"]],
      ["jwt", ["middleware"]],
      ["oauth", ["middleware"]],
      ["session", ["middleware"]],
      ["middleware", ["middleware"]],
      ["guard", ["middleware"]],
      ["interceptor", ["middleware"]],
      ["pipe", ["middleware"]],
      ["filter", ["middleware"]],
      ["route", ["endpoints"]],
      ["endpoint", ["endpoints"]],
      ["api", ["endpoints"]],
      ["rest", ["endpoints"]],
      ["graphql", ["endpoints"]],
      ["controller", ["endpoints", "architecture"]],
      ["service", ["architecture"]],
      ["repository", ["architecture"]],
      ["model", ["models"]],
      ["schema", ["models"]],
      ["entity", ["models"]],
      ["database", ["models", "dependencies"]],
      ["dependency", ["dependencies", "callGraph"]],
      ["import", ["callGraph"]],
      ["circular", ["callGraph"]],
      ["cycle", ["callGraph"]],
      ["architecture", ["architecture"]],
      ["pattern", ["architecture"]],
      ["layer", ["architecture"]],
      ["monorepo", ["architecture"]],
      ["microservice", ["architecture"]],
      ["event", ["architecture"]],
      ["component", ["snippets"]],
      ["function", ["snippets"]],
      ["class", ["snippets", "models"]],
      ["test", ["snippets"]],
      ["config", ["snippets", "dependencies"]],
      ["error", ["middleware"]],
      ["handler", ["middleware", "endpoints"]],
    ]),
  );

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of Stage 1 question analysis */
export interface QuestionAnalysis {
  /** Keywords extracted from question (lowercased, stop-words removed) */
  keywords: string[];
  /** Sections that are likely relevant based on domain signals */
  relevantSections: string[];
  /** Per-file relevance scores (file path → score) */
  fileScores: Map<string, number>;
}

/** A file selected for the focused context with its tier */
export interface RankedFile {
  file: string;
  score: number;
  /** "full" = full code content; "summary" = summary only */
  tier: "full" | "summary";
}

/** The focused context produced by Stage 1 for Stage 2 consumption */
export interface FocusedContext {
  /** Top files with full code (up to TOP_FULL_CODE_FILES) */
  fullCodeFiles: { file: string; content: string; language: string }[];
  /** Next tier files with summaries only (up to TOP_SUMMARY_FILES) */
  summaryFiles: { file: string; summary: string }[];
  /** Ranked files list for diagnostics */
  rankedFiles: RankedFile[];
  /** Relevant endpoints (scored > 0) */
  relevantEndpoints: EndpointData[];
  /** Relevant models (scored > 0) */
  relevantModels: ModelData[];
  /** Relationship hints from call graph (imports of top files) */
  relatedDependencies: string[];
  /** Which budget sections are boosted by the question */
  boostedSections: string[];
}

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

/** Maximum question length to prevent main-thread blocking */
const MAX_QUESTION_LENGTH = 2000;

/**
 * Extract meaningful keywords from the user question.
 * Decomposes camelCase/PascalCase, removes stop words, deduplicates.
 * Preserves path-like tokens (e.g. src/auth/jwt.service.ts) separately.
 */
export function extractKeywords(question: string): string[] {
  // Truncate pathologically long questions
  const q =
    question.length > MAX_QUESTION_LENGTH
      ? question.slice(0, MAX_QUESTION_LENGTH)
      : question;

  // Capture path-like tokens: must start with a letter, contain / or .,
  // and the segment after the separator must also start with a letter.
  // Cap matches at 120 chars to prevent greedy suffix consumption.
  const pathLike = /[a-zA-Z][a-zA-Z0-9_-]*[./][a-zA-Z][a-zA-Z0-9_./-]*/g;
  const pathTokens = (q.match(pathLike) ?? []).map((t) =>
    (t.length > 120 ? t.slice(0, 120) : t).toLowerCase(),
  );

  const decomposed = q
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9_\-/.]+/g, " ")
    .split(/\s+/);

  const MIN_LEN = 2;
  const all = [...decomposed, ...pathTokens]
    .map((t) => t.replace(/^[-_.]+|[-_.]+$/g, ""))
    .filter((t) => t.length >= MIN_LEN && !STOP_WORDS.has(t));

  return [...new Set(all)];
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score a single file against the question keywords.
 *
 * Factors:
 *  - Keyword match in file path (+3 per hit)
 *  - Keyword match in snippet content (+1 per hit, capped at 5)
 *  - Entry point bonus (+2) if in callGraph.entryPoints
 *  - Hot node bonus (+2) if in callGraph.hotNodes
 *  - Import proximity bonus (+1) if imported by a high-scoring file
 */
export function scoreFile(
  filePath: string,
  keywords: string[],
  content: string | undefined,
  callGraph: CallGraphSummary | undefined,
): number {
  let score = 0;
  const lowerPath = filePath.toLowerCase();

  // Path keyword matches
  for (const kw of keywords) {
    if (lowerPath.includes(kw)) {
      score += 3;
    }
  }

  // Content keyword matches (capped at 5, with early exit)
  if (content && keywords.length > 0) {
    // Cap scan window to prevent main-thread blocking on large files
    const scannable =
      content.length > MAX_SCORE_SCAN_CHARS
        ? content.slice(0, MAX_SCORE_SCAN_CHARS)
        : content;
    const lowerContent = scannable.toLowerCase();
    let contentHits = 0;
    for (const kw of keywords) {
      if (lowerContent.includes(kw)) {
        if (++contentHits >= 5) break;
      }
    }
    score += contentHits;
  }

  // Call graph bonuses
  if (callGraph) {
    const normalizedPath = filePath.replace(/\\/g, "/");
    const norm = (p: string) => p.replace(/\\/g, "/");

    if (
      callGraph.entryPoints.some((ep) => {
        const n = norm(ep);
        return normalizedPath.endsWith(n) || n.endsWith(normalizedPath);
      })
    ) {
      score += 2;
    }
    if (
      callGraph.hotNodes.some((hn) => {
        const n = norm(hn);
        return normalizedPath.endsWith(n) || n.endsWith(normalizedPath);
      })
    ) {
      score += 2;
    }
  }

  return score;
}

/**
 * Score an endpoint against the question keywords.
 */
export function scoreEndpoint(
  endpoint: EndpointData,
  keywords: string[],
): number {
  if (!endpoint.path) return 0;
  let score = 0;
  const lowerPath = endpoint.path.toLowerCase();
  const lowerHandler = (endpoint.handler ?? "").toLowerCase();

  for (const kw of keywords) {
    if (lowerPath.includes(kw)) score += 3;
    if (lowerHandler.includes(kw)) score += 2;
  }

  return score;
}

/**
 * Score a data model against the question keywords.
 */
export function scoreModel(model: ModelData, keywords: string[]): number {
  if (keywords.length === 0) return 0;

  let score = 0;
  const lowerName = model.name.toLowerCase();

  for (const kw of keywords) {
    if (lowerName.includes(kw)) score += 4;
  }

  // Property/method matches — labeled break exits both loops at cap
  const members = [...(model.methods ?? []), ...(model.properties ?? [])];
  let memberHits = 0;

  memberScan: for (const m of members) {
    // Guard: properties may arrive as {name, type} objects from the worker
    if (!m) continue;
    const raw = typeof m === "string" ? m : (m as { name?: string }).name;
    if (!raw) continue;
    const lowerMember = raw.toLowerCase();
    for (const kw of keywords) {
      if (lowerMember.includes(kw)) {
        memberHits++;
        if (memberHits >= 3) break memberScan;
        break; // one hit per member is enough; continue outer
      }
    }
  }
  score += memberHits;

  return score;
}

// ---------------------------------------------------------------------------
// Stage 1: Analyze question + rank
// ---------------------------------------------------------------------------

/**
 * Analyze the user question against the full analysis result.
 * Returns scored/ranked artifacts ready for focused context generation.
 */
export function analyzeQuestion(
  question: string,
  analysis: CachedAnalysis,
): QuestionAnalysis {
  const keywords = extractKeywords(question);

  // Determine boosted sections from domain signals
  const sectionSet = new Set<string>();
  for (const kw of keywords) {
    const sections = DOMAIN_SIGNALS.get(kw);
    if (sections) {
      for (const s of sections) sectionSet.add(s);
    }
  }

  // Score every file that has a code snippet
  const fileScores = new Map<string, number>();

  for (const snippet of analysis.codeSnippets ?? []) {
    const score = scoreFile(
      snippet.file,
      keywords,
      snippet.content,
      analysis.callGraphSummary,
    );
    fileScores.set(snippet.file, score);
  }

  // Also score files that appear in the file list but have no snippet
  for (const file of analysis.files) {
    if (!fileScores.has(file)) {
      const score = scoreFile(
        file,
        keywords,
        undefined,
        analysis.callGraphSummary,
      );
      if (score > 0) {
        fileScores.set(file, score);
      }
    }
  }

  return {
    keywords,
    relevantSections: [...sectionSet],
    fileScores,
  };
}

// ---------------------------------------------------------------------------
// Focused context builder
// ---------------------------------------------------------------------------

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  cs: "csharp",
  rb: "ruby",
  tsx: "typescript",
  jsx: "javascript",
  vue: "vue",
  svelte: "svelte",
};

/** Infer a human-readable language name from a file path extension */
function inferLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return (EXT_TO_LANGUAGE[ext] ?? ext) || "source";
}

/**
 * Build a FocusedContext from the question analysis.
 * Full code for top N files, summaries for the next M, relevant endpoints/models.
 */
export function buildFocusedContext(
  analysis: CachedAnalysis,
  qa: QuestionAnalysis,
): FocusedContext {
  // Rank files by score descending
  const ranked = [...qa.fileScores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);

  const snippetMap = new Map<string, CodeSnippet>();
  for (const snippet of analysis.codeSnippets ?? []) {
    snippetMap.set(snippet.file, snippet);
  }

  const rankedFiles: RankedFile[] = [];
  const fullCodeFiles: FocusedContext["fullCodeFiles"] = [];
  const summaryFiles: FocusedContext["summaryFiles"] = [];

  // Two-pass selection: full-code tier from files WITH snippets first,
  // then summary tier from remaining files (ensures full-code tier is maximally filled)
  const snippetFiles = ranked.filter(([file]) => snippetMap.has(file));
  const noSnippetFiles = ranked.filter(([file]) => !snippetMap.has(file));

  // Pass 1: fill full-code tier from highest-scoring snippet files
  for (const [file, score] of snippetFiles.slice(0, TOP_FULL_CODE_FILES)) {
    const snippet = snippetMap.get(file)!;
    const content =
      snippet.content.length > MAX_FILE_CONTENT_CHARS
        ? snippet.content.slice(0, MAX_FILE_CONTENT_CHARS) +
          "\n// ... truncated"
        : snippet.content;
    fullCodeFiles.push({
      file: snippet.file,
      content,
      language: snippet.language,
    });
    rankedFiles.push({ file, score, tier: "full" });
  }

  // Pass 2: summary tier from remaining snippet files + no-snippet files, sorted by score
  const summaryPool = [
    ...snippetFiles.slice(TOP_FULL_CODE_FILES),
    ...noSnippetFiles,
  ].sort((a, b) => b[1] - a[1]);

  for (const [file, score] of summaryPool.slice(0, TOP_SUMMARY_FILES)) {
    const snippet = snippetMap.get(file);
    // Progressive fallback: snippet summary → snippet language → path-derived language
    const summary =
      snippet?.summary ??
      (snippet?.language ? `${snippet.language} file` : null) ??
      `${inferLanguageFromPath(file)} file — ${file}`;
    summaryFiles.push({ file, summary });
    rankedFiles.push({ file, score, tier: "summary" });
  }

  // Score endpoints (cap at 10 to bound FocusedContext size)
  const relevantEndpoints = (analysis.apiEndpoints ?? [])
    .map((ep) => ({ ep, score: scoreEndpoint(ep, qa.keywords) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ ep }) => ep);

  // Score models (cap at 10)
  const relevantModels = (analysis.dataModels ?? [])
    .map((m) => ({ m, score: scoreModel(m, qa.keywords) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ m }) => m);

  // Related dependencies: hot nodes NOT already in our top files
  // (shared utilities/services that our top files likely import)
  const relatedDependencies: string[] = [];
  const callGraph = analysis.callGraphSummary;
  if (callGraph) {
    const norm = (p: string) => p.replace(/\\/g, "/");
    // Pre-build a segment set: full path + trailing filename for O(1) lookup
    const rankedFileSet = new Set(rankedFiles.map((rf) => norm(rf.file)));
    const rankedSegments = new Set<string>();
    for (const p of rankedFileSet) {
      rankedSegments.add(p);
      const slash = p.lastIndexOf("/");
      if (slash >= 0) rankedSegments.add(p.slice(slash + 1));
    }
    const seenDeps = new Set<string>();

    for (const hn of callGraph.hotNodes) {
      const normHn = norm(hn);

      // Segment-index lookup: O(1) instead of O(n) spread-and-scan
      const hnSegment = normHn.includes("/")
        ? normHn.slice(normHn.lastIndexOf("/") + 1)
        : normHn;
      const alreadyRanked =
        rankedSegments.has(normHn) || rankedSegments.has(hnSegment);

      if (!alreadyRanked && !seenDeps.has(normHn)) {
        relatedDependencies.push(hn);
        seenDeps.add(normHn);
        if (relatedDependencies.length >= 5) break;
      }
    }
  }

  return {
    fullCodeFiles,
    summaryFiles,
    rankedFiles,
    relevantEndpoints,
    relevantModels,
    relatedDependencies,
    boostedSections: qa.relevantSections,
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** Cache entry stores the original question for collision validation */
interface CacheEntry {
  question: string;
  analysisFP: string;
  qa: QuestionAnalysis;
  ts: number;
}

/**
 * Bounded question-analysis cache with TTL expiry and LRU fallback.
 * Encapsulated as a class for lifecycle ownership and testability.
 */
export class QuestionAnalysisCache {
  private readonly cache = new Map<string, CacheEntry>();
  private lastEvictionSweep = 0;

  /** How often to run a full stale-eviction sweep (ms) */
  private static readonly EVICTION_INTERVAL_MS = 60 * 1000;

  constructor(
    private readonly maxSize: number = 100,
    private readonly ttlMs: number = 5 * 60 * 1000,
  ) {}

  get(key: string, now: number): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (now - entry.ts > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, entry: CacheEntry, now: number): void {
    // Periodic sweep regardless of cache size
    if (
      now - this.lastEvictionSweep >
      QuestionAnalysisCache.EVICTION_INTERVAL_MS
    ) {
      this.evictStale(now);
      this.lastEvictionSweep = now;
    }

    // LRU fallback if still at capacity after stale eviction
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }

    this.cache.set(key, entry);
  }

  clear(): void {
    this.cache.clear();
    this.lastEvictionSweep = 0;
  }

  get size(): number {
    return this.cache.size;
  }

  private evictStale(now: number): void {
    for (const [k, v] of this.cache) {
      if (now - v.ts > this.ttlMs) this.cache.delete(k);
    }
  }
}

/** Singleton cache for production use — exported for extension lifecycle hooks */
export const questionCache = new QuestionAnalysisCache();

/** FNV-1a 32-bit hash — better avalanche than djb2, still zero-dependency */
function hashQuestion(question: string): string {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < question.length; i++) {
    h ^= question.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; // FNV prime, unsigned
  }
  return h.toString(36);
}

/**
 * Content-addressable fingerprint of the analysis file list.
 * FNV-1a hashes ALL file paths in a single O(total_chars) pass — cheap
 * and eliminates the cross-workspace collision risk of sampling.
 */
function analysisFingerprint(analysis: CachedAnalysis): string {
  const files = analysis.files;
  if (files.length === 0) return "empty";

  let h = 0x811c9dc5; // FNV offset basis
  for (const f of files) {
    for (let i = 0; i < f.length; i++) {
      h ^= f.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    // Separator sentinel between file paths
    h ^= 0x2f;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${files.length}:${h.toString(36)}`;
}

/**
 * Analyze question with caching. Returns cached result if the same question
 * was analyzed within the TTL window against the same analysis.
 * Uses composite key (hash + analysis fingerprint) with collision validation.
 *
 * @param cache Injectable cache instance for testing; defaults to the singleton.
 */
export function analyzeQuestionCached(
  question: string,
  analysis: CachedAnalysis,
  now: number = Date.now(),
  cache: QuestionAnalysisCache = questionCache,
): QuestionAnalysis {
  // Guard against empty or pathologically long questions
  if (!question || question.trim().length === 0) {
    return { keywords: [], relevantSections: [], fileScores: new Map() };
  }

  // Normalize: trim + collapse whitespace + lowercase for cache hit rate
  const normalized = question.trim().replace(/\s+/g, " ").toLowerCase();

  const fp = analysisFingerprint(analysis);
  const key = `${hashQuestion(normalized)}|${fp}`;
  const cached = cache.get(key, now);

  if (
    cached &&
    cached.question === normalized // collision guard
  ) {
    return cached.qa;
  }

  const qa = analyzeQuestion(question, analysis); // original question for keyword extraction
  cache.set(key, { question: normalized, analysisFP: fp, qa, ts: now }, now);
  return qa;
}

/**
 * Clear the question analysis cache.
 * @internal Exported for testing and extension lifecycle (workspace switch).
 * Call from the extension's workspace-change handler to prevent stale cross-workspace hits.
 * @param cache Optional cache instance; defaults to the singleton.
 */
export function clearQuestionCache(
  cache: QuestionAnalysisCache = questionCache,
): void {
  cache.clear();
}
