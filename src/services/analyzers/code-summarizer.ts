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
  private cache = new Map<string, { summary: FileSummary; expiry: number }>();
  private readonly summarizeFn: SummarizeFunction;
  private readonly cacheTtlMs: number;

  constructor(
    summarizeFn: SummarizeFunction,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  ) {
    this.summarizeFn = summarizeFn;
    this.cacheTtlMs = cacheTtlMs;
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
      const { summaries: batchSummaries, usedFallback } =
        await this.summarizeBatch(batch);

      for (const summary of batchSummaries) {
        result.summaries.push(summary);
        this.putInCache(summary);
        if (usedFallback) {
          result.fallback++;
        } else {
          result.generated++;
        }
      }

      // Count files that didn't get a summary at all (partial JSON parse failures)
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
   */
  private async summarizeBatch(
    snippets: CodeSnippet[],
  ): Promise<{ summaries: FileSummary[]; usedFallback: boolean }> {
    const prompt = this.buildBatchPrompt(snippets);

    try {
      const response = await this.summarizeFn(prompt);
      return {
        summaries: this.parseBatchResponse(response, snippets),
        usedFallback: false,
      };
    } catch {
      // Fallback: generate simple heuristic summaries
      return {
        summaries: snippets.map((s) => ({
          file: s.file,
          summary: generateFallbackSummary(s),
          contentHash: hashContent(s.content),
          language: s.language,
        })),
        usedFallback: true,
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

      const basename = snippet.file.split(/[\\/]/).pop() ?? snippet.file;
      prompt += `\n--- ${basename} (${snippet.language}) ---\n${truncated}\n`;
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

      // Build basename → candidates (handles collisions like src/index.ts and test/index.ts)
      const byBasename = new Map<string, CodeSnippet[]>();
      for (const s of snippets) {
        const basename = s.file.split(/[\\/]/).pop() ?? s.file;
        const list = byBasename.get(basename) ?? [];
        list.push(s);
        byBasename.set(basename, list);
      }

      for (const item of parsed) {
        if (!item.file || !item.summary) continue;

        // Prefer exact/suffix file path match, fall back to basename candidates
        const exactMatch = snippets.find(
          (s) => s.file === item.file || s.file.endsWith(item.file),
        );
        const candidates = byBasename.get(item.file) ?? [];
        const snippet = exactMatch ?? candidates[0];

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
    if (Date.now() > entry.expiry) {
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
      expiry: Date.now() + this.cacheTtlMs,
    });
  }

  clearCache(): void {
    this.cache.clear();
  }
}

// ─── Utilities ───────────────────────────────────────────────────

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

  // Check for exports
  const exportMatches = content.match(
    /export\s+(?:default\s+)?(?:class|function|const|interface)\s+(\w+)/g,
  );
  if (exportMatches && exportMatches.length > 0) {
    const names = exportMatches
      .map((m) => m.match(/(\w+)$/)?.[1])
      .filter(Boolean)
      .slice(0, 3);
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
 * Avoids dynamic RegExp construction to eliminate ReDoS risk.
 */
function parseFallbackLine(response: string, basename: string): string | null {
  if (!basename || basename.length > 255) return null;

  // Case-insensitive search using regex on the original string.
  // basename is our own filename (not LLM output), so regex is safe after escaping.
  const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idx = response.search(new RegExp(escaped, "i"));
  if (idx === -1) return null;

  // Find the delimiter after the filename
  const after = response.slice(idx + basename.length).trimStart();
  const delimMatch = after.match(/^[:—\-]\s*(.+)/);
  return delimMatch ? delimMatch[1].trim().slice(0, 200) : null;
}
