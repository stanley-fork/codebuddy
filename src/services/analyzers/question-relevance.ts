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

/** Stop words excluded from keyword extraction */
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us",
  "them", "my", "your", "his", "its", "our", "their",
  "this", "that", "these", "those", "what", "which", "who", "whom",
  "how", "where", "when", "why",
  "and", "but", "or", "nor", "not", "so", "yet", "for", "with",
  "about", "between", "through", "during", "before", "after",
  "in", "on", "at", "to", "from", "of", "by", "up", "out",
  "if", "then", "else", "than", "too", "very", "just",
  "all", "each", "every", "both", "few", "more", "most", "other",
  "some", "such", "no", "only", "same",
]);

/**
 * Domain terms that indicate the user cares about a specific architectural concept.
 * Maps keywords → analysis sections they correlate with.
 */
const DOMAIN_SIGNALS: ReadonlyMap<string, string[]> = new Map([
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
]);

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

/**
 * Extract meaningful keywords from the user question.
 * Removes stop words, short tokens, and deduplicates.
 */
export function extractKeywords(question: string): string[] {
  const tokens = question
    .toLowerCase()
    .replace(/[^a-z0-9_\-/.]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));

  return [...new Set(tokens)];
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

  // Content keyword matches (capped)
  if (content) {
    const lowerContent = content.toLowerCase();
    let contentHits = 0;
    for (const kw of keywords) {
      if (lowerContent.includes(kw)) {
        contentHits++;
      }
    }
    score += Math.min(contentHits, 5);
  }

  // Call graph bonuses
  if (callGraph) {
    const normalizedPath = filePath.replace(/\\/g, "/");
    if (callGraph.entryPoints.some((ep) => normalizedPath.endsWith(ep) || ep.endsWith(normalizedPath))) {
      score += 2;
    }
    if (callGraph.hotNodes.some((hn) => normalizedPath.endsWith(hn) || hn.endsWith(normalizedPath))) {
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
  let score = 0;
  const lowerName = model.name.toLowerCase();

  for (const kw of keywords) {
    if (lowerName.includes(kw)) score += 4;
  }

  // Property/method matches
  const members = [...(model.methods ?? []), ...(model.properties ?? [])];
  let memberHits = 0;
  for (const m of members) {
    const lowerMember = m.toLowerCase();
    for (const kw of keywords) {
      if (lowerMember.includes(kw)) {
        memberHits++;
        break; // one hit per member is enough
      }
    }
  }
  score += Math.min(memberHits, 3);

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
  const snippetMap = new Map<string, CodeSnippet>();

  for (const snippet of analysis.codeSnippets ?? []) {
    snippetMap.set(snippet.file, snippet);
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
      const score = scoreFile(file, keywords, undefined, analysis.callGraphSummary);
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

  for (const [file, score] of ranked) {
    if (fullCodeFiles.length < TOP_FULL_CODE_FILES) {
      const snippet = snippetMap.get(file);
      if (snippet) {
        fullCodeFiles.push({
          file: snippet.file,
          content: snippet.content,
          language: snippet.language,
        });
        rankedFiles.push({ file, score, tier: "full" });
        continue;
      }
    }

    if (summaryFiles.length < TOP_SUMMARY_FILES) {
      const snippet = snippetMap.get(file);
      const summary = snippet?.summary ?? `File: ${file}`;
      summaryFiles.push({ file, summary });
      rankedFiles.push({ file, score, tier: "summary" });
      continue;
    }

    // Beyond both tiers — stop
    break;
  }

  // Score endpoints
  const relevantEndpoints = (analysis.apiEndpoints ?? [])
    .map((ep) => ({ ep, score: scoreEndpoint(ep, qa.keywords) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ ep }) => ep);

  // Score models
  const relevantModels = (analysis.dataModels ?? [])
    .map((m) => ({ m, score: scoreModel(m, qa.keywords) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ m }) => m);

  // Related dependencies from call graph: files that import top files
  const relatedDependencies: string[] = [];
  const callGraph = analysis.callGraphSummary;
  if (callGraph) {
    // Hot nodes that overlap with top files are relevant dependencies
    for (const hn of callGraph.hotNodes) {
      const isTopFile = rankedFiles.some(
        (rf) => rf.file.endsWith(hn) || hn.endsWith(rf.file),
      );
      if (isTopFile && !relatedDependencies.includes(hn)) {
        relatedDependencies.push(hn);
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

/** Simple question-hash cache for Stage 1 results */
const questionCache = new Map<string, { qa: QuestionAnalysis; ts: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function hashQuestion(question: string): string {
  // Simple string hash — good enough for short question strings
  let h = 0;
  for (let i = 0; i < question.length; i++) {
    h = (Math.imul(31, h) + question.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

/**
 * Analyze question with caching. Returns cached result if the same question
 * was analyzed within the TTL window.
 */
export function analyzeQuestionCached(
  question: string,
  analysis: CachedAnalysis,
  now: number = Date.now(),
): QuestionAnalysis {
  const key = hashQuestion(question);
  const cached = questionCache.get(key);

  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return cached.qa;
  }

  const qa = analyzeQuestion(question, analysis);
  questionCache.set(key, { qa, ts: now });

  // Evict stale entries (keep cache bounded)
  if (questionCache.size > 100) {
    for (const [k, v] of questionCache) {
      if (now - v.ts > CACHE_TTL_MS) {
        questionCache.delete(k);
      }
    }
  }

  return qa;
}

/** Clear the question analysis cache (for testing) */
export function clearQuestionCache(): void {
  questionCache.clear();
}
