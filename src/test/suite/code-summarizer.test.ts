import * as assert from "assert";
import {
  CodeSummarizer,
  InMemorySummaryCache,
  type SummarizeFunction,
  type FileSummary,
} from "../../services/analyzers/code-summarizer";
import type { CodeSnippet } from "../../interfaces/analysis.interface";

function makeSnippet(overrides: Partial<CodeSnippet>): CodeSnippet {
  return {
    file: "/workspace/src/app.ts",
    content: "export function main() { console.log('hello'); }",
    language: "typescript",
    ...overrides,
  };
}

suite("Code Summarizer", () => {
  suite("basic summarization", () => {
    test("returns summaries from LLM response", async () => {
      const mockLLM: SummarizeFunction = async () =>
        JSON.stringify([
          { file: "app.ts", summary: "Main application entry point." },
        ]);

      const summarizer = new CodeSummarizer(mockLLM);
      const result = await summarizer.summarize([makeSnippet({})]);

      assert.strictEqual(result.summaries.length, 1);
      assert.strictEqual(result.summaries[0].summary, "Main application entry point.");
      assert.strictEqual(result.generated, 1);
      assert.strictEqual(result.cached, 0);
      assert.strictEqual(result.failed, 0);
      assert.strictEqual(result.fallback, 0);
    });

    test("handles multiple files in batch", async () => {
      const mockLLM: SummarizeFunction = async () =>
        JSON.stringify([
          { file: "a.ts", summary: "Module A." },
          { file: "b.ts", summary: "Module B." },
          { file: "c.ts", summary: "Module C." },
        ]);

      const summarizer = new CodeSummarizer(mockLLM);
      const snippets = [
        makeSnippet({ file: "/workspace/src/a.ts", content: "export const a = 1;" }),
        makeSnippet({ file: "/workspace/src/b.ts", content: "export const b = 2;" }),
        makeSnippet({ file: "/workspace/src/c.ts", content: "export const c = 3;" }),
      ];
      const result = await summarizer.summarize(snippets);

      assert.strictEqual(result.summaries.length, 3);
      assert.strictEqual(result.generated, 3);
    });
  });

  suite("caching", () => {
    test("returns cached result for unchanged content", async () => {
      let callCount = 0;
      const mockLLM: SummarizeFunction = async () => {
        callCount++;
        return JSON.stringify([
          { file: "app.ts", summary: "Entry point." },
        ]);
      };

      const summarizer = new CodeSummarizer(mockLLM);
      const snippet = makeSnippet({});

      // First call: generates
      await summarizer.summarize([snippet]);
      assert.strictEqual(callCount, 1);

      // Second call: should be cached
      const result = await summarizer.summarize([snippet]);
      assert.strictEqual(callCount, 1); // no second LLM call
      assert.strictEqual(result.cached, 1);
      assert.strictEqual(result.generated, 0);
    });

    test("invalidates cache when content changes", async () => {
      let callCount = 0;
      const mockLLM: SummarizeFunction = async () => {
        callCount++;
        return JSON.stringify([
          { file: "app.ts", summary: `Summary v${callCount}` },
        ]);
      };

      const summarizer = new CodeSummarizer(mockLLM);

      // First call with content A
      await summarizer.summarize([
        makeSnippet({ content: "const x = 1;" }),
      ]);
      assert.strictEqual(callCount, 1);

      // Second call with different content
      await summarizer.summarize([
        makeSnippet({ content: "const x = 2; // changed" }),
      ]);
      assert.strictEqual(callCount, 2);
    });

    test("clearCache forces re-generation", async () => {
      let callCount = 0;
      const mockLLM: SummarizeFunction = async () => {
        callCount++;
        return JSON.stringify([
          { file: "app.ts", summary: "Summary." },
        ]);
      };

      const summarizer = new CodeSummarizer(mockLLM);
      const snippet = makeSnippet({});

      await summarizer.summarize([snippet]);
      assert.strictEqual(callCount, 1);

      summarizer.clearCache();

      await summarizer.summarize([snippet]);
      assert.strictEqual(callCount, 2);
    });
  });

  suite("batch splitting", () => {
    test("splits more than 5 items into multiple batches", async () => {
      let callCount = 0;
      const mockLLM: SummarizeFunction = async (prompt) => {
        callCount++;
        // Return summaries for whatever files are in this batch
        const fileMatches = [...prompt.matchAll(/--- (\S+)/g)];
        return JSON.stringify(
          fileMatches.map((m) => ({
            file: m[1],
            summary: `Summary for ${m[1]}`,
          })),
        );
      };

      const summarizer = new CodeSummarizer(mockLLM);
      const snippets = Array.from({ length: 7 }, (_, i) =>
        makeSnippet({
          file: `/workspace/src/file${i}.ts`,
          content: `export const x${i} = ${i};`,
        }),
      );

      const result = await summarizer.summarize(snippets);

      assert.strictEqual(callCount, 2); // 5 + 2
      assert.strictEqual(result.generated, 7);
    });
  });

  suite("fallback handling", () => {
    test("falls back to heuristic when LLM throws", async () => {
      const failingLLM: SummarizeFunction = async () => {
        throw new Error("LLM unavailable");
      };

      const summarizer = new CodeSummarizer(failingLLM);
      const result = await summarizer.summarize([
        makeSnippet({
          content: `export function main() { console.log('hello'); }\nexport class App {}`,
        }),
      ]);

      assert.strictEqual(result.summaries.length, 1);
      assert.ok(result.summaries[0].summary.length > 0);
      // Heuristic should mention exports
      assert.ok(
        result.summaries[0].summary.includes("Export") ||
          result.summaries[0].summary.includes("app.ts"),
      );
      // Should be counted as fallback, not generated
      assert.strictEqual(result.fallback, 1);
      assert.strictEqual(result.generated, 0);
    });

    test("uses line-by-line fallback when JSON parse fails", async () => {
      const badJsonLLM: SummarizeFunction = async () =>
        "app.ts: This is the main application entry point.";

      const summarizer = new CodeSummarizer(badJsonLLM);
      const result = await summarizer.summarize([makeSnippet({})]);

      assert.strictEqual(result.summaries.length, 1);
      assert.ok(
        result.summaries[0].summary.includes("main application entry point"),
      );
    });

    test("strips markdown fences from LLM response", async () => {
      const fencedLLM: SummarizeFunction = async () =>
        '```json\n[{"file": "app.ts", "summary": "Entry point."}]\n```';

      const summarizer = new CodeSummarizer(fencedLLM);
      const result = await summarizer.summarize([makeSnippet({})]);

      assert.strictEqual(result.summaries.length, 1);
      assert.strictEqual(result.summaries[0].summary, "Entry point.");
    });
  });

  suite("summary truncation", () => {
    test("truncates summaries longer than 200 chars", async () => {
      const longSummary = "A".repeat(300);
      const mockLLM: SummarizeFunction = async () =>
        JSON.stringify([{ file: "app.ts", summary: longSummary }]);

      const summarizer = new CodeSummarizer(mockLLM);
      const result = await summarizer.summarize([makeSnippet({})]);

      assert.strictEqual(result.summaries[0].summary.length, 200);
    });
  });

  suite("configurable TTL", () => {
    test("cache expires after custom TTL", async () => {
      let callCount = 0;
      const mockLLM: SummarizeFunction = async () => {
        callCount++;
        return JSON.stringify([
          { file: "app.ts", summary: "Summary." },
        ]);
      };

      // Use injectable clock for deterministic TTL testing
      let fakeNow = 1000;
      const summarizer = new CodeSummarizer(
        mockLLM,
        100, // 100ms TTL
        new InMemorySummaryCache(),
        () => fakeNow,
      );
      const snippet = makeSnippet({});

      await summarizer.summarize([snippet]);
      assert.strictEqual(callCount, 1);

      // Advance clock past TTL
      fakeNow = 1200;

      const result = await summarizer.summarize([snippet]);
      assert.strictEqual(callCount, 2);
      assert.strictEqual(result.cached, 0);
      assert.strictEqual(result.generated, 1);
    });
  });

  suite("basename collision", () => {
    test("handles files with same basename in different directories", async () => {
      const mockLLM: SummarizeFunction = async () =>
        JSON.stringify([
          { file: "src/index.ts", summary: "Main entry." },
          { file: "test/index.ts", summary: "Test entry." },
        ]);

      const summarizer = new CodeSummarizer(mockLLM);
      const result = await summarizer.summarize([
        makeSnippet({ file: "/workspace/src/index.ts", content: "export const main = 1;" }),
        makeSnippet({ file: "/workspace/test/index.ts", content: "import { main } from '../src';" }),
      ]);

      assert.strictEqual(result.summaries.length, 2);
      // Each should map to its correct file
      const srcSummary = result.summaries.find((s) => s.file.includes("src/"));
      const testSummary = result.summaries.find((s) => s.file.includes("test/"));
      assert.ok(srcSummary);
      assert.ok(testSummary);
    });
  });
});
