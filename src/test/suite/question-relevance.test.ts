import * as assert from "assert";
import {
  extractKeywords,
  scoreFile,
  scoreEndpoint,
  scoreModel,
  analyzeQuestion,
  buildFocusedContext,
  analyzeQuestionCached,
  clearQuestionCache,
  QuestionAnalysisCache,
  TOP_FULL_CODE_FILES,
  TOP_SUMMARY_FILES,
  type QuestionAnalysis,
  type FocusedContext,
} from "../../services/analyzers/question-relevance";
import type {
  CachedAnalysis,
  CodeSnippet,
  CallGraphSummary,
} from "../../interfaces/analysis.interface";

function makeAnalysis(overrides: Partial<CachedAnalysis> = {}): CachedAnalysis {
  return {
    summary: {
      totalFiles: 10,
      totalLines: 5000,
      languageDistribution: { typescript: 8, javascript: 2 },
      complexity: "medium",
    },
    files: [
      "src/auth/jwt.service.ts",
      "src/controllers/user.controller.ts",
      "src/services/user.service.ts",
      "src/models/user.model.ts",
      "src/utils/logger.ts",
      "src/config/database.ts",
      "src/middleware/cors.ts",
      "src/app.ts",
      "src/index.ts",
      "test/user.test.ts",
    ],
    codeSnippets: [
      {
        file: "src/auth/jwt.service.ts",
        content: "import jwt from 'jsonwebtoken';\nexport class JwtService { sign(payload) {} verify(token) {} }",
        language: "typescript",
        summary: "JWT signing and verification service.",
      },
      {
        file: "src/controllers/user.controller.ts",
        content: "import { UserService } from '../services/user.service';\nexport class UserController { getUser() {} createUser() {} }",
        language: "typescript",
        summary: "REST controller for user CRUD operations.",
      },
      {
        file: "src/services/user.service.ts",
        content: "export class UserService { findById(id) {} create(data) {} }",
        language: "typescript",
        summary: "User business logic service.",
      },
      {
        file: "src/models/user.model.ts",
        content: "export interface User { id: string; name: string; email: string; }",
        language: "typescript",
        summary: "User data model interface.",
      },
      {
        file: "src/utils/logger.ts",
        content: "export const logger = { info() {}, error() {} };",
        language: "typescript",
        summary: "Utility logger module.",
      },
      {
        file: "src/app.ts",
        content: "import express from 'express';\nconst app = express();\napp.listen(3000);",
        language: "typescript",
        summary: "Express application entry point.",
      },
    ],
    apiEndpoints: [
      { method: "GET", path: "/api/users", file: "user.controller.ts", handler: "getUser" },
      { method: "POST", path: "/api/users", file: "user.controller.ts", handler: "createUser" },
      { method: "POST", path: "/api/auth/login", file: "auth.controller.ts", handler: "login" },
      { method: "GET", path: "/api/health", file: "health.controller.ts" },
    ],
    dataModels: [
      { name: "User", type: "interface", file: "user.model.ts", properties: ["id", "name", "email"] },
      { name: "AuthToken", type: "interface", file: "auth.model.ts", properties: ["token", "expiresAt"] },
      { name: "DatabaseConfig", type: "type", file: "database.ts", properties: ["host", "port"] },
    ],
    ...overrides,
  };
}

function makeCallGraph(overrides: Partial<CallGraphSummary> = {}): CallGraphSummary {
  return {
    entryPoints: ["src/index.ts"],
    hotNodes: ["src/utils/logger.ts", "src/services/shared.service.ts"],
    circularDependencies: [],
    edgeCount: 12,
    nodeCount: 10,
    ...overrides,
  };
}

suite("Question Relevance Analyzer", () => {
  setup(() => {
    clearQuestionCache();
  });

  suite("extractKeywords", () => {
    test("removes stop words and short single-char tokens", () => {
      const keywords = extractKeywords("How is the authentication handled in this project?");
      assert.ok(!keywords.includes("how"));
      assert.ok(!keywords.includes("is"));
      assert.ok(!keywords.includes("the"));
      assert.ok(!keywords.includes("in"));
      assert.ok(keywords.includes("authentication"));
      assert.ok(keywords.includes("handled"));
      assert.ok(keywords.includes("project"));
    });

    test("decomposes camelCase identifiers", () => {
      const keywords = extractKeywords("How does getUserById work?");
      assert.ok(keywords.includes("get"), "should decompose camelCase: get");
      assert.ok(keywords.includes("user"), "should decompose camelCase: user");
      assert.ok(keywords.includes("id"), "should decompose camelCase: id");
      // "by" is a stop word, so it's filtered out — this is expected
      assert.ok(!keywords.includes("by"), "'by' is a stop word and should be removed");
    });

    test("preserves two-letter acronyms", () => {
      const keywords = extractKeywords("Where is the db config and UI?");
      assert.ok(keywords.includes("db"), "should keep 2-letter token 'db'");
      assert.ok(keywords.includes("ui"), "should keep 2-letter token 'ui'");
    });

    test("deduplicates tokens", () => {
      const keywords = extractKeywords("user user user model");
      assert.strictEqual(keywords.filter((k) => k === "user").length, 1);
    });

    test("lowercases all tokens", () => {
      const keywords = extractKeywords("JWT Authentication Middleware");
      assert.ok(keywords.includes("jwt"));
      assert.ok(keywords.includes("authentication"));
      assert.ok(keywords.includes("middleware"));
    });

    test("preserves path-like tokens", () => {
      const keywords = extractKeywords("What is in src/auth/jwt.service.ts?");
      assert.ok(keywords.some((k) => k.includes("src/auth/jwt.service.ts")));
    });

    test("does not match version strings as path-like tokens", () => {
      // "1.2.3" should NOT be captured by the pathLike regex (requires letter start).
      // It may still appear as a regular decomposed token, so we verify the pathLike
      // regex specifically doesn't fire by checking a pure numeric version isn't duplicated.
      const keywords = extractKeywords("We use version 1.2.3 of the library");
      // The pathLike regex should not match "1.2.3" (starts with digit)
      // but the decomposed pipeline may still produce it — the key invariant is
      // that a leading-digit dot-separated string doesn't get the path boost.
      assert.ok(keywords.filter((k) => k === "1.2.3").length <= 1, "version string should appear at most once (no path-regex duplicate)");
    });

    test("truncates pathologically long questions", () => {
      const longQuestion = "auth ".repeat(1000); // 5000 chars
      const keywords = extractKeywords(longQuestion);
      // Should not throw; keywords should still be extracted from the first 2000 chars
      assert.ok(keywords.length > 0);
      assert.ok(keywords.includes("auth"));
    });
  });

  suite("scoreFile", () => {
    test("scores path keyword matches at +3", () => {
      const score = scoreFile("src/auth/jwt.service.ts", ["jwt", "auth"], undefined, undefined);
      assert.strictEqual(score, 6); // "jwt" +3, "auth" +3
    });

    test("scores content keyword matches capped at 5", () => {
      const content = "jwt token auth session oauth apikey basic";
      const score = scoreFile("unrelated.ts", ["jwt", "token", "auth", "session", "oauth", "apikey"], content, undefined);
      // 0 path hits, 6 content hits capped to 5
      assert.strictEqual(score, 5);
    });

    test("caps content scan at MAX_SCORE_SCAN_CHARS to avoid main-thread blocking", () => {
      // Place keyword at position 9000 (beyond the 8000-char scan cap)
      const content = "x".repeat(9000) + "secretkeyword";
      const score = scoreFile("unrelated.ts", ["secretkeyword"], content, undefined);
      // Keyword is beyond scan window — should NOT be found
      assert.strictEqual(score, 0, "keyword beyond scan cap should not score");

      // Place keyword within scan window
      const content2 = "secretkeyword" + "x".repeat(9000);
      const score2 = scoreFile("unrelated.ts", ["secretkeyword"], content2, undefined);
      assert.strictEqual(score2, 1, "keyword within scan cap should score");
    });

    test("adds entry point bonus from call graph", () => {
      const callGraph: CallGraphSummary = {
        entryPoints: ["src/index.ts"],
        hotNodes: [],
        circularDependencies: [],
        edgeCount: 5,
        nodeCount: 10,
      };
      const score = scoreFile("src/index.ts", [], undefined, callGraph);
      assert.strictEqual(score, 2); // entry point bonus
    });

    test("adds hot node bonus from call graph", () => {
      const callGraph: CallGraphSummary = {
        entryPoints: [],
        hotNodes: ["src/utils/logger.ts"],
        circularDependencies: [],
        edgeCount: 5,
        nodeCount: 10,
      };
      const score = scoreFile("src/utils/logger.ts", [], undefined, callGraph);
      assert.strictEqual(score, 2); // hot node bonus
    });

    test("returns 0 for no matches", () => {
      const score = scoreFile("README.md", ["jwt"], undefined, undefined);
      assert.strictEqual(score, 0);
    });
  });

  suite("scoreEndpoint", () => {
    test("scores path keyword matches at +3", () => {
      const score = scoreEndpoint({ method: "POST", path: "/api/auth/login" }, ["auth", "login"]);
      assert.strictEqual(score, 6);
    });

    test("scores handler keyword matches at +2", () => {
      const score = scoreEndpoint({ method: "GET", path: "/api/health", handler: "checkHealth" }, ["health"]);
      // path +3, handler +2
      assert.strictEqual(score, 5);
    });

    test("returns 0 for no matches", () => {
      const score = scoreEndpoint({ method: "GET", path: "/api/users" }, ["jwt"]);
      assert.strictEqual(score, 0);
    });
  });

  suite("scoreModel", () => {
    test("scores name matches at +4", () => {
      const score = scoreModel({ name: "User", type: "interface" }, ["user"]);
      assert.strictEqual(score, 4);
    });

    test("scores member matches capped at 3", () => {
      const score = scoreModel(
        { name: "Config", type: "type", properties: ["host", "port", "database", "timeout"] },
        ["host", "port", "database", "timeout"],
      );
      // name: 0 hits, members: 4 hits capped at 3
      assert.strictEqual(score, 3);
    });
  });

  suite("analyzeQuestion", () => {
    test("identifies relevant sections from domain signals", () => {
      const analysis = makeAnalysis();
      const qa = analyzeQuestion("How is JWT authentication handled?", analysis);

      assert.ok(qa.relevantSections.includes("middleware"));
      assert.ok(qa.keywords.includes("jwt"));
      assert.ok(qa.keywords.includes("authentication"));
    });

    test("scores files with keyword overlap", () => {
      const analysis = makeAnalysis();
      const qa = analyzeQuestion("How does the JWT service work?", analysis);

      const jwtScore = qa.fileScores.get("src/auth/jwt.service.ts") ?? 0;
      const loggerScore = qa.fileScores.get("src/utils/logger.ts") ?? 0;

      assert.ok(jwtScore > loggerScore, "JWT file should score higher than logger");
    });

    test("includes files from file list that have no snippet", () => {
      const analysis = makeAnalysis();
      const qa = analyzeQuestion("Where is the database configuration?", analysis);

      // database.ts is in files[] but not in codeSnippets — should still be scored
      const dbScore = qa.fileScores.get("src/config/database.ts") ?? 0;
      assert.ok(dbScore > 0, "files-only entries should be scored when relevant");
    });
  });

  suite("buildFocusedContext", () => {
    test("returns top files in full-code tier with correct count", () => {
      const analysis = makeAnalysis();
      const qa = analyzeQuestion("How does JWT authentication work?", analysis);
      const focused = buildFocusedContext(analysis, qa);

      assert.ok(focused.fullCodeFiles.length <= TOP_FULL_CODE_FILES);
      assert.ok(focused.fullCodeFiles.length > 0, "should have at least one full-code file");

      // JWT file should be in full-code tier
      const jwtFile = focused.fullCodeFiles.find((f) => f.file.includes("jwt"));
      assert.ok(jwtFile, "JWT file should be in full-code tier");
      assert.ok(jwtFile.content.includes("jsonwebtoken"));
    });

    test("returns summary-tier files after full-code tier", () => {
      const analysis = makeAnalysis();
      const qa = analyzeQuestion("How does the user service interact with authentication?", analysis);
      const focused = buildFocusedContext(analysis, qa);

      assert.ok(focused.summaryFiles.length <= TOP_SUMMARY_FILES);
      // Full + summary should not exceed both tier limits
      assert.ok(
        focused.rankedFiles.length <= TOP_FULL_CODE_FILES + TOP_SUMMARY_FILES,
      );
    });

    test("filters endpoints by relevance", () => {
      const analysis = makeAnalysis();
      const qa = analyzeQuestion("What are the auth login endpoints?", analysis);
      const focused = buildFocusedContext(analysis, qa);

      // Auth endpoint should be relevant, health likely not
      const hasAuth = focused.relevantEndpoints.some((ep) => ep.path.includes("auth"));
      assert.ok(hasAuth, "auth endpoint should be in relevant endpoints");
    });

    test("filters models by relevance", () => {
      const analysis = makeAnalysis();
      const qa = analyzeQuestion("What is the User model?", analysis);
      const focused = buildFocusedContext(analysis, qa);

      const hasUser = focused.relevantModels.some((m) => m.name === "User");
      assert.ok(hasUser, "User model should be in relevant models");
    });

    test("populates boosted sections from domain signals", () => {
      const analysis = makeAnalysis();
      const qa = analyzeQuestion("How is JWT middleware configured?", analysis);
      const focused = buildFocusedContext(analysis, qa);

      assert.ok(focused.boostedSections.includes("middleware"));
    });

    test("returns empty context for irrelevant question", () => {
      const analysis = makeAnalysis();
      const qa = analyzeQuestion("What is the weather today?", analysis);
      const focused = buildFocusedContext(analysis, qa);

      // May have zero or minimal matches
      assert.ok(focused.fullCodeFiles.length <= TOP_FULL_CODE_FILES);
    });

    test("summary fallback uses path-derived language for no-snippet files", () => {
      // database.ts is in files[] but has no snippet
      const analysis = makeAnalysis();
      const qa = analyzeQuestion("Where is the database configuration?", analysis);
      const focused = buildFocusedContext(analysis, qa);

      const dbSummary = focused.summaryFiles.find((f) => f.file.includes("database"));
      if (dbSummary) {
        // Should contain the inferred language and file path, not just "source file"
        assert.ok(
          dbSummary.summary.includes("typescript") || dbSummary.summary.includes("database"),
          `summary should include language or path info, got: "${dbSummary.summary}"`,
        );
      }
    });

    test("backfills full-code tier when top-scoring files lack snippets", () => {
      // Files in file list only (no snippet) should fall to summary,
      // while lower-scoring files WITH snippets fill the full-code tier
      const analysis = makeAnalysis({
        files: [
          "src/no-snippet-1.ts",
          "src/no-snippet-2.ts",
          ...makeAnalysis().files,
        ],
      });
      const qa = analyzeQuestion("How does the user service work?", analysis);
      const focused = buildFocusedContext(analysis, qa);

      // Full-code tier should be filled from files that HAVE snippets
      for (const f of focused.fullCodeFiles) {
        assert.ok(f.content.length > 0, `full-code file ${f.file} should have content`);
      }
    });

    test("relatedDependencies excludes already-ranked files", () => {
      const cg = makeCallGraph({
        hotNodes: ["src/auth/jwt.service.ts", "src/services/shared.service.ts"],
      });
      const analysis = makeAnalysis({ callGraphSummary: cg });
      const qa = analyzeQuestion("How does JWT work?", analysis);
      const focused = buildFocusedContext(analysis, qa);

      // jwt.service.ts is a top-ranked file, so it should NOT be in relatedDependencies
      const hasJwt = focused.relatedDependencies.some((d) => d.includes("jwt"));
      assert.ok(!hasJwt, "already-ranked file should not appear in relatedDependencies");

      // shared.service.ts is NOT ranked but IS a hot node → should appear
      const hasShared = focused.relatedDependencies.some((d) => d.includes("shared"));
      assert.ok(hasShared, "non-ranked hot node should appear in relatedDependencies");
    });

    test("truncates large file content in full-code tier", () => {
      const bigContent = "x".repeat(10000);
      const analysis = makeAnalysis({
        codeSnippets: [
          {
            file: "src/auth/jwt.service.ts",
            content: bigContent,
            language: "typescript",
            summary: "Big file.",
          },
          ...(makeAnalysis().codeSnippets ?? []).slice(1),
        ],
      });
      const qa = analyzeQuestion("How does JWT authentication work?", analysis);
      const focused = buildFocusedContext(analysis, qa);

      const jwtFile = focused.fullCodeFiles.find((f) => f.file.includes("jwt"));
      assert.ok(jwtFile, "JWT file should be in full-code tier");
      assert.ok(jwtFile.content.length < bigContent.length, "content should be truncated");
      assert.ok(jwtFile.content.endsWith("// ... truncated"), "should end with truncation marker");
    });
  });

  suite("analyzeQuestionCached", () => {
    test("returns cached result for identical question", () => {
      const analysis = makeAnalysis();
      const qa1 = analyzeQuestionCached("How does auth work?", analysis, 1000);
      const qa2 = analyzeQuestionCached("How does auth work?", analysis, 2000);

      // Should be the same object (cache hit)
      assert.strictEqual(qa1, qa2);
    });

    test("returns empty result for empty question", () => {
      const analysis = makeAnalysis();
      const qa = analyzeQuestionCached("", analysis, 1000);
      assert.strictEqual(qa.keywords.length, 0);
      assert.strictEqual(qa.fileScores.size, 0);
    });

    test("returns empty result for whitespace-only question", () => {
      const analysis = makeAnalysis();
      const qa = analyzeQuestionCached("   ", analysis, 1000);
      assert.strictEqual(qa.keywords.length, 0);
    });

    test("returns fresh result after TTL expires", () => {
      const analysis = makeAnalysis();
      const qa1 = analyzeQuestionCached("How does auth work?", analysis, 1000);
      // 6 minutes later (TTL is 5 min)
      const qa2 = analyzeQuestionCached("How does auth work?", analysis, 1000 + 6 * 60 * 1000);

      // Should be different objects (cache miss)
      assert.notStrictEqual(qa1, qa2);
    });

    test("different questions get different results", () => {
      const analysis = makeAnalysis();
      const qa1 = analyzeQuestionCached("How does auth work?", analysis, 1000);
      const qa2 = analyzeQuestionCached("What is the database schema?", analysis, 1000);

      assert.notStrictEqual(qa1, qa2);
      assert.notDeepStrictEqual(qa1.keywords, qa2.keywords);
    });

    test("returns cached result for case-variant question (normalization)", () => {
      const cache = new QuestionAnalysisCache();
      const analysis = makeAnalysis();
      const qa1 = analyzeQuestionCached("How does auth work?", analysis, 1000, cache);
      const qa2 = analyzeQuestionCached("how does auth work?", analysis, 2000, cache);

      // Normalization makes these the same cache key
      assert.strictEqual(qa1, qa2, "case-variant questions should hit cache");
    });

    test("returns cached result for whitespace-variant question (normalization)", () => {
      const cache = new QuestionAnalysisCache();
      const analysis = makeAnalysis();
      const qa1 = analyzeQuestionCached("How does auth work?", analysis, 1000, cache);
      const qa2 = analyzeQuestionCached("  How  does  auth  work?  ", analysis, 2000, cache);

      assert.strictEqual(qa1, qa2, "whitespace-variant questions should hit cache");
    });

    test("returns fresh result when analysis changes (different workspace)", () => {
      const analysis1 = makeAnalysis();
      const analysis2 = makeAnalysis({
        files: ["other-workspace/file.ts"],
        summary: { totalFiles: 1, totalLines: 50, languageDistribution: { typescript: 1 }, complexity: "low" },
      });

      const qa1 = analyzeQuestionCached("How does auth work?", analysis1, 1000);
      const qa2 = analyzeQuestionCached("How does auth work?", analysis2, 1000);

      // Same question, different analysis → different results
      assert.notStrictEqual(qa1, qa2);
    });
  });

  suite("scoreEndpoint edge cases", () => {
    test("returns 0 for endpoint with undefined path", () => {
      const ep = { method: "GET", path: undefined as unknown as string };
      const score = scoreEndpoint(ep, ["test"]);
      assert.strictEqual(score, 0);
    });
  });

  suite("scoreFile Windows paths", () => {
    test("normalizes backslashes in callGraph entries", () => {
      const callGraph: CallGraphSummary = {
        entryPoints: ["src\\index.ts"],
        hotNodes: ["src\\utils\\logger.ts"],
        circularDependencies: [],
        edgeCount: 5,
        nodeCount: 10,
      };
      // Forward-slash file path should still match backslash call graph entries
      const score = scoreFile("src/index.ts", [], undefined, callGraph);
      assert.strictEqual(score, 2, "entry point with backslashes should match");
    });
  });

  suite("scoreModel edge cases", () => {
    test("returns 0 for empty keywords", () => {
      const score = scoreModel(
        { name: "User", type: "interface", properties: ["id"] },
        [],
      );
      assert.strictEqual(score, 0);
    });

    test("handles properties that are objects instead of strings", () => {
      // Worker may produce {name, type} objects in properties array
      const model = {
        name: "Order",
        type: "class",
        properties: [
          { name: "userId", type: "string" },
          { name: "total", type: "number" },
        ] as unknown as string[],
      };
      const score = scoreModel(model, ["userid"]);
      assert.ok(score > 0, "should score object-shaped properties by name");
    });

    test("skips null/undefined entries in members array", () => {
      const model = {
        name: "Config",
        type: "interface",
        properties: [null, undefined, "host"] as unknown as string[],
      };
      // Should not throw
      const score = scoreModel(model, ["host"]);
      assert.ok(score > 0);
    });
  });

  suite("QuestionAnalysisCache", () => {
    test("get returns undefined for expired entries", () => {
      const cache = new QuestionAnalysisCache(100, 1000); // 1s TTL
      const entry = {
        question: "test",
        analysisFP: "fp",
        qa: { keywords: ["test"], relevantSections: [], fileScores: new Map() },
        ts: 0,
      };
      cache.set("key", entry, 0);
      assert.ok(cache.get("key", 500), "should find entry within TTL");
      assert.strictEqual(cache.get("key", 1500), undefined, "should expire after TTL");
    });

    test("LRU evicts oldest entry when at capacity", () => {
      const cache = new QuestionAnalysisCache(2, 60000);
      const mkEntry = (q: string, ts: number) => ({
        question: q,
        analysisFP: "fp",
        qa: { keywords: [q], relevantSections: [], fileScores: new Map() },
        ts,
      });
      cache.set("a", mkEntry("a", 100), 100);
      cache.set("b", mkEntry("b", 200), 200);
      // At capacity; inserting c should evict a (oldest by insertion order)
      cache.set("c", mkEntry("c", 300), 300);

      assert.strictEqual(cache.size, 2);
      assert.strictEqual(cache.get("a", 300), undefined, "oldest should be evicted");
      assert.ok(cache.get("b", 300), "b should remain");
      assert.ok(cache.get("c", 300), "c should remain");
    });

    test("periodic eviction sweeps stale entries regardless of size", () => {
      const cache = new QuestionAnalysisCache(100, 60000); // 60s TTL
      const mkEntry = (q: string, ts: number) => ({
        question: q,
        analysisFP: "fp",
        qa: { keywords: [q], relevantSections: [], fileScores: new Map() },
        ts,
      });
      cache.set("old", mkEntry("old", 0), 0);
      cache.set("recent", mkEntry("recent", 65000), 65000);

      // Trigger periodic sweep: time > EVICTION_INTERVAL_MS (60s) after last sweep (0)
      // "old" was written at ts=0, now=70000 → 70s > 60s TTL → stale
      // "recent" was written at ts=65000, now=70000 → 5s < 60s TTL → fresh
      cache.set("new", mkEntry("new", 70000), 70000);

      assert.strictEqual(cache.get("old", 70000), undefined, "stale entry should be swept");
      assert.ok(cache.get("recent", 70000), "recent entry should survive sweep");
      assert.ok(cache.get("new", 70000), "new entry should exist");
    });

    test("injectable cache isolates test state", () => {
      const cache = new QuestionAnalysisCache();
      const analysis = makeAnalysis();
      const qa1 = analyzeQuestionCached("test query", analysis, 1000, cache);
      const qa2 = analyzeQuestionCached("test query", analysis, 2000, cache);

      assert.strictEqual(qa1, qa2, "should return cached result from injected cache");
      assert.strictEqual(cache.size, 1);
    });

    test("clearQuestionCache clears an injected cache instance", () => {
      const cache = new QuestionAnalysisCache();
      const analysis = makeAnalysis();
      analyzeQuestionCached("test query", analysis, 1000, cache);
      assert.strictEqual(cache.size, 1);

      clearQuestionCache(cache);
      assert.strictEqual(cache.size, 0, "injected cache should be cleared");
    });
  });
});
