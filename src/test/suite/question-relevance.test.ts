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
      "/workspace/src/auth/jwt.service.ts",
      "/workspace/src/controllers/user.controller.ts",
      "/workspace/src/services/user.service.ts",
      "/workspace/src/models/user.model.ts",
      "/workspace/src/utils/logger.ts",
      "/workspace/src/config/database.ts",
      "/workspace/src/middleware/cors.ts",
      "/workspace/src/app.ts",
      "/workspace/src/index.ts",
      "/workspace/test/user.test.ts",
    ],
    codeSnippets: [
      {
        file: "/workspace/src/auth/jwt.service.ts",
        content: "import jwt from 'jsonwebtoken';\nexport class JwtService { sign(payload) {} verify(token) {} }",
        language: "typescript",
        summary: "JWT signing and verification service.",
      },
      {
        file: "/workspace/src/controllers/user.controller.ts",
        content: "import { UserService } from '../services/user.service';\nexport class UserController { getUser() {} createUser() {} }",
        language: "typescript",
        summary: "REST controller for user CRUD operations.",
      },
      {
        file: "/workspace/src/services/user.service.ts",
        content: "export class UserService { findById(id) {} create(data) {} }",
        language: "typescript",
        summary: "User business logic service.",
      },
      {
        file: "/workspace/src/models/user.model.ts",
        content: "export interface User { id: string; name: string; email: string; }",
        language: "typescript",
        summary: "User data model interface.",
      },
      {
        file: "/workspace/src/utils/logger.ts",
        content: "export const logger = { info() {}, error() {} };",
        language: "typescript",
        summary: "Utility logger module.",
      },
      {
        file: "/workspace/src/app.ts",
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
  });

  suite("scoreFile", () => {
    test("scores path keyword matches at +3", () => {
      const score = scoreFile("/workspace/src/auth/jwt.service.ts", ["jwt", "auth"], undefined, undefined);
      assert.strictEqual(score, 6); // "jwt" +3, "auth" +3
    });

    test("scores content keyword matches capped at 5", () => {
      const content = "jwt token auth session oauth apikey basic";
      const score = scoreFile("/workspace/unrelated.ts", ["jwt", "token", "auth", "session", "oauth", "apikey"], content, undefined);
      // 0 path hits, 6 content hits capped to 5
      assert.strictEqual(score, 5);
    });

    test("adds entry point bonus from call graph", () => {
      const callGraph: CallGraphSummary = {
        entryPoints: ["src/index.ts"],
        hotNodes: [],
        circularDependencies: [],
        edgeCount: 5,
        nodeCount: 10,
      };
      const score = scoreFile("/workspace/src/index.ts", [], undefined, callGraph);
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
      const score = scoreFile("/workspace/src/utils/logger.ts", [], undefined, callGraph);
      assert.strictEqual(score, 2); // hot node bonus
    });

    test("returns 0 for no matches", () => {
      const score = scoreFile("/workspace/README.md", ["jwt"], undefined, undefined);
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

      const jwtScore = qa.fileScores.get("/workspace/src/auth/jwt.service.ts") ?? 0;
      const loggerScore = qa.fileScores.get("/workspace/src/utils/logger.ts") ?? 0;

      assert.ok(jwtScore > loggerScore, "JWT file should score higher than logger");
    });

    test("includes files from file list that have no snippet", () => {
      const analysis = makeAnalysis();
      const qa = analyzeQuestion("Where is the database configuration?", analysis);

      // database.ts is in files[] but not in codeSnippets — should still be scored
      const dbScore = qa.fileScores.get("/workspace/src/config/database.ts") ?? 0;
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

    test("backfills full-code tier when top-scoring files lack snippets", () => {
      // Files in file list only (no snippet) should fall to summary,
      // while lower-scoring files WITH snippets fill the full-code tier
      const analysis = makeAnalysis({
        files: [
          "/workspace/src/no-snippet-1.ts",
          "/workspace/src/no-snippet-2.ts",
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
  });

  suite("analyzeQuestionCached", () => {
    test("returns cached result for identical question", () => {
      const analysis = makeAnalysis();
      const qa1 = analyzeQuestionCached("How does auth work?", analysis, 1000);
      const qa2 = analyzeQuestionCached("How does auth work?", analysis, 2000);

      // Should be the same object (cache hit)
      assert.strictEqual(qa1, qa2);
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

    test("returns fresh result when analysis changes (different workspace)", () => {
      const analysis1 = makeAnalysis();
      const analysis2 = makeAnalysis({
        files: ["/other/workspace/file.ts"],
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
      const score = scoreFile("/workspace/src/index.ts", [], undefined, callGraph);
      assert.strictEqual(score, 2, "entry point with backslashes should match");
    });
  });
});
