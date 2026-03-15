/**
 * Code Summarizer
 *
 * Generates concise 1-2 sentence summaries for key files.
 * Uses LLM for summarization with content-hash caching to avoid
 * re-summarizing unchanged files.
 *
 * Designed for dependency injection: accepts a summarize function
 * so it's testable without LLM infrastructure.
 */

import * as crypto from "crypto";
import type { CodeSnippet } from "../../interfaces/analysis.interface";

// ─── Types ───────────────────────────────────────────────────────

export interface FileSummary {
  file: string;
  summary: string;
  contentHash: string;
  language: string;
}

export interface SummarizeBatchResult {
  summaries: FileSummary[];
  cached: number;
  generated: number;
  failed: number;
  fallback: number;
}

/**
 * Function signature for LLM-based text generation.
 * Accepts a prompt string, returns generated text.
 * This abstraction allows testing without real LLM calls.
 */
export type SummarizeFunction = (prompt: string) => Promise<string>;

/**
 * Abstraction for summary cache storage.
 * Default: in-memory Map. Can be swapped for persistent storage
 * (e.g., workspace-scoped file cache) via dependency injection.
 */
export interface SummaryCache {
  get(file: string): { summary: FileSummary; expiry: number } | undefined;
  set(file: string, entry: { summary: FileSummary; expiry: number }): void;
  delete(file: string): void;
  clear(): void;
}

/** Default in-memory cache implementation. */
export class InMemorySummaryCache implements SummaryCache {
  private readonly store = new Map<
    string,
    { summary: FileSummary; expiry: number }
  >();
  get(file: string) {
    return this.store.get(file);
  }
  set(file: string, entry: { summary: FileSummary; expiry: number }) {
    this.store.set(file, entry);
  }
  delete(file: string) {
    this.store.delete(file);
  }
  clear() {
    this.store.clear();
  }
}

// ─── Constants ───────────────────────────────────────────────────

const MAX_BATCH_SIZE = 5;
const MAX_FILE_CHARS_FOR_SUMMARY = 3000;
const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const SUMMARY_PROMPT_TEMPLATE = `Summarize each code file below in exactly 1-2 sentences. Focus on:
- What it does (purpose)
- Key exports or API surface
- Notable dependencies

Respond with ONLY a JSON array of objects: [{"file": "filename", "summary": "..."}]
Do not include markdown fencing or explanation.

FILES:
`;

// ─── Summarizer ──────────────────────────────────────────────────

export class CodeSummarizer {
  private readonly cache: SummaryCache;
  private readonly summarizeFn: SummarizeFunction;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;

  constructor(
    summarizeFn: SummarizeFunction,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    cache: SummaryCache = new InMemorySummaryCache(),
    now: () => number = Date.now,
  ) {
    this.summarizeFn = summarizeFn;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = cache;
    this.now = now;
  }

  /**
   * Summarize a batch of code snippets.
   * Uses content-hash caching to skip unchanged files.
   * Batches LLM calls to reduce round-trips.
   */
  async summarize(snippets: CodeSnippet[]): Promise<SummarizeBatchResult> {
    const result: SummarizeBatchResult = {
      summaries: [],
      cached: 0,
      generated: 0,
      failed: 0,
      fallback: 0,
    };

    const needsSummarization: CodeSnippet[] = [];

    // Check cache first
    for (const snippet of snippets) {
      const hash = hashContent(snippet.content);
      const cached = this.getFromCache(snippet.file, hash);
      if (cached) {
        result.summaries.push(cached);
        result.cached++;
      } else {
        needsSummarization.push(snippet);
      }
    }

    // Batch LLM calls
    for (let i = 0; i < needsSummarization.length; i += MAX_BATCH_SIZE) {
      const batch = needsSummarization.slice(i, i + MAX_BATCH_SIZE);
      const { summaries: batchSummaries, fallbackFiles } =
        await this.summarizeBatch(batch);

      for (const summary of batchSummaries) {
        result.summaries.push(summary);
        this.putInCache(summary);
        if (fallbackFiles.has(summary.file)) {
          result.fallback++;
        } else {
          result.generated++;
        }
      }

      // Count files that didn't get a summary at all
      const batchFiles = new Set(batch.map((s) => s.file));
      const summarizedFiles = new Set(batchSummaries.map((s) => s.file));
      for (const file of batchFiles) {
        if (!summarizedFiles.has(file)) {
          result.failed++;
        }
      }
    }

    return result;
  }

  /**
   * Summarize a batch of files in a single LLM call.
   * Returns per-file fallback tracking so the caller can distinguish
   * LLM-generated summaries from heuristic fallbacks.
   */
  private async summarizeBatch(
    snippets: CodeSnippet[],
  ): Promise<{ summaries: FileSummary[]; fallbackFiles: Set<string> }> {
    const prompt = this.buildBatchPrompt(snippets);

    try {
      const response = await this.summarizeFn(prompt);
      const parsed = this.parseBatchResponse(response, snippets);

      // Any snippet that didn't parse cleanly gets a fallback
      const parsedFiles = new Set(parsed.map((s) => s.file));
      const fallbackFiles = new Set<string>();
      const fallbackSummaries = snippets
        .filter((s) => !parsedFiles.has(s.file))
        .map((s) => {
          fallbackFiles.add(s.file);
          return {
            file: s.file,
            summary: generateFallbackSummary(s),
            contentHash: hashContent(s.content),
            language: s.language,
          };
        });
      return { summaries: [...parsed, ...fallbackSummaries], fallbackFiles };
    } catch {
      // Full batch fallback: generate simple heuristic summaries
      const fallbackFiles = new Set(snippets.map((s) => s.file));
      return {
        summaries: snippets.map((s) => ({
          file: s.file,
          summary: generateFallbackSummary(s),
          contentHash: hashContent(s.content),
          language: s.language,
        })),
        fallbackFiles,
      };
    }
  }

  /**
   * Build a batched prompt for multiple files.
   */
  private buildBatchPrompt(snippets: CodeSnippet[]): string {
    let prompt = SUMMARY_PROMPT_TEMPLATE;

    for (const snippet of snippets) {
      const truncated =
        snippet.content.length > MAX_FILE_CHARS_FOR_SUMMARY
          ? snippet.content.slice(0, MAX_FILE_CHARS_FOR_SUMMARY) +
            "\n// ... truncated"
          : snippet.content;

      const shortPath = shortFilePath(snippet.file);
      prompt += `\n--- ${shortPath} (${snippet.language}) ---\n${truncated}\n`;
    }

    return prompt;
  }

  /**
   * Parse the LLM response into structured summaries.
   */
  private parseBatchResponse(
    response: string,
    snippets: CodeSnippet[],
  ): FileSummary[] {
    const results: FileSummary[] = [];

    try {
      // Strip markdown code fences if present
      const cleaned = response
        .replace(/^```(?:json)?\s*/m, "")
        .replace(/\s*```\s*$/m, "")
        .trim();

      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];

      // Build short path → candidates (handles collisions like src/index.ts and test/index.ts)
      const byShortPath = new Map<string, CodeSnippet[]>();
      for (const s of snippets) {
        const sp = shortFilePath(s.file);
        const list = byShortPath.get(sp) ?? [];
        list.push(s);
        byShortPath.set(sp, list);
      }

      for (const item of parsed) {
        if (!item.file || !item.summary) continue;

        const itemNormalized = item.file.replace(/\\/g, "/");
        // Prefer exact match, then suffix match with leading "/" to avoid partial collisions
        const exactMatch = snippets.find(
          (s) =>
            s.file === itemNormalized ||
            s.file.replace(/\\/g, "/").endsWith("/" + itemNormalized),
        );
        // Short path fallback — only use if unambiguous (single candidate)
        const candidates = byShortPath.get(itemNormalized) ?? [];
        const snippet =
          exactMatch ?? (candidates.length === 1 ? candidates[0] : undefined);

        if (snippet) {
          results.push({
            file: snippet.file,
            summary: String(item.summary).slice(0, 200), // bound output length
            contentHash: hashContent(snippet.content),
            language: snippet.language,
          });
        }
      }
    } catch {
      // JSON parse failed — try line-by-line fallback using plain string search
      // e.g. "filename.ts: Summary text here"
      for (const snippet of snippets) {
        const basename = snippet.file.split(/[\\/]/).pop() ?? "";
        const summary = parseFallbackLine(response, basename);
        if (summary) {
          results.push({
            file: snippet.file,
            summary,
            contentHash: hashContent(snippet.content),
            language: snippet.language,
          });
        }
      }
    }

    return results;
  }

  // ─── Cache ─────────────────────────────────────────────────────

  private getFromCache(file: string, contentHash: string): FileSummary | null {
    const entry = this.cache.get(file);
    if (!entry) return null;
    if (this.now() > entry.expiry) {
      this.cache.delete(file);
      return null;
    }
    if (entry.summary.contentHash !== contentHash) {
      this.cache.delete(file);
      return null;
    }
    return entry.summary;
  }

  private putInCache(summary: FileSummary): void {
    this.cache.set(summary.file, {
      summary,
      expiry: this.now() + this.cacheTtlMs,
    });
  }

  clearCache(): void {
    this.cache.clear();
  }
}

// ─── Utilities ───────────────────────────────────────────────────

/**
 * Return the last two path segments for a file path.
 * This disambiguates files better than basename alone when multiple files
 * share the same filename (e.g., src/index.ts vs test/index.ts).
 */
export function shortFilePath(filePath: string): string {
  const segments = filePath.replace(/\\/g, "/").split("/");
  return segments.length >= 2
    ? segments.slice(-2).join("/")
    : segments[segments.length - 1];
}

/**
 * Content-hash for cache keying.
 * Uses SHA-256 truncated to 12 hex chars (48 bits). Collision probability
 * is negligible for the expected cache population (~thousands of files)
 * and acceptable because a collision only causes a stale-cache hit, not
 * a correctness issue.
 */
function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/**
 * Generate a summary without LLM based on code structure heuristics.
 */
function generateFallbackSummary(snippet: CodeSnippet): string {
  const content = snippet.content;
  const basename = snippet.file.split(/[\\/]/).pop() ?? snippet.file;
  const parts: string[] = [];

  // Check for exports using \w (ASCII identifiers cover 99% of real-world code).
  // Uses exec loop to avoid creating the full match array — stops at 3 names.
  const exportRe =
    /export\s+(?:default\s+)?(?:class|function|const|interface)\s+(\w+)/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = exportRe.exec(content)) !== null && names.length < 3) {
    names.push(m[1]);
  }
  if (names.length > 0) {
    parts.push(`Exports: ${names.join(", ")}`);
  }

  // Check for framework patterns
  if (/express|fastify|koa|hono/i.test(content)) {
    parts.push("HTTP server/router module");
  } else if (/@Controller|@Injectable|@Module/i.test(content)) {
    parts.push("NestJS module");
  } else if (/React|useState|useEffect|jsx/i.test(content)) {
    parts.push("React component");
  }

  if (parts.length === 0) {
    parts.push(`${snippet.language} module`);
  }

  return `${basename}: ${parts.join(". ")}.`;
}

/**
 * Parse a single file summary from unstructured LLM response using plain string search.
 * Uses indexOf for case-insensitive search — no RegExp construction, no ReDoS risk.
 * Accepts basename only (no path separators) so indexOf cannot match partial directory names.
 */
function parseFallbackLine(response: string, basename: string): string | null {
  // Length guard: filesystem basenames are bounded at 255 chars; anything
  // longer is not a real filename and should be rejected immediately.
  if (!basename || basename.length > 255) return null;

  // Normalize to lowercase for case-insensitive comparison
  const needle = basename.toLowerCase();
  const haystack = response.toLowerCase();
  const idx = haystack.indexOf(needle);
  if (idx === -1) return null;

  // Find the delimiter after the filename in the ORIGINAL string
  const after = response.slice(idx + basename.length).trimStart();
  // Bound capture to 210 chars to prevent excessive allocation from malformed LLM output
  const delimMatch = after.match(/^[:—\-]\s*(.{1,210})/);
  return delimMatch ? delimMatch[1].trim().slice(0, 200) : null;
}
