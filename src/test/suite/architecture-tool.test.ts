import * as assert from "assert";
import {
  formatArchitectureContext,
  type ArchitectureAnalysisInput,
  type ArchitectureSection,
} from "../../agents/langgraph/tools/architecture";

// ─── Helpers ─────────────────────────────────────────────────────

function makeAnalysis(
  overrides: Partial<ArchitectureAnalysisInput> = {},
): ArchitectureAnalysisInput {
  return {
    architectureReport: {
      projectType: "Node.js API",
      entryPoints: ["src/index.ts"],
      patterns: [
        {
          name: "Layered Architecture",
          confidence: 0.9,
          indicators: ["controllers/ directory", "services/ directory"],
        },
      ],
    },
    callGraphSummary: {
      nodeCount: 42,
      edgeCount: 87,
      hotNodes: ["src/utils/logger.ts"],
      entryPoints: ["src/index.ts"],
      circularDependencies: [["a.ts", "b.ts", "a.ts"]],
    },
    middlewareSummary: {
      middleware: [
        { name: "auth", type: "express", file: "src/middleware/auth.ts" },
      ],
      authStrategies: ["JWT"],
      authFlows: [
        {
          strategy: "JWT",
          indicators: ["Bearer token"],
          files: ["src/auth.ts"],
        },
      ],
      errorHandlerCount: 1,
      errorHandlerFiles: ["src/middleware/error.ts"],
    },
    frameworks: ["Express", "TypeScript"],
    files: new Array(100).fill("file.ts"),
    apiEndpoints: [
      { method: "GET", path: "/api/v1/users", file: "src/routes/users.ts" },
    ],
    dataModels: [
      {
        name: "User",
        type: "interface",
        properties: ["id", "name", "email"],
      },
    ],
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────

suite("Architecture Tool", () => {
  suite("formatArchitectureContext", () => {
    suite("section routing", () => {
      const sections: ArchitectureSection[] = [
        "all",
        "overview",
        "patterns",
        "call-graph",
        "middleware",
        "endpoints",
        "models",
      ];

      for (const section of sections) {
        test(`returns non-empty content for section="${section}"`, () => {
          const result = formatArchitectureContext(makeAnalysis(), section);
          assert.ok(
            result.length > 0,
            `Expected non-empty output for section=${section}`,
          );
          assert.ok(
            !result.includes("No architecture data"),
            `Unexpected fallback for section=${section}`,
          );
        });
      }
    });

    suite("overview section", () => {
      test("includes project type", () => {
        const result = formatArchitectureContext(makeAnalysis(), "overview");
        assert.ok(result.includes("Node.js API"));
      });

      test("includes entry points", () => {
        const result = formatArchitectureContext(makeAnalysis(), "overview");
        assert.ok(result.includes("src/index.ts"));
      });

      test("includes framework list", () => {
        const result = formatArchitectureContext(makeAnalysis(), "overview");
        assert.ok(result.includes("Express"));
        assert.ok(result.includes("TypeScript"));
      });

      test("includes file count", () => {
        const result = formatArchitectureContext(makeAnalysis(), "overview");
        assert.ok(result.includes("100"));
      });
    });

    suite("patterns section", () => {
      test("includes pattern name and confidence", () => {
        const result = formatArchitectureContext(makeAnalysis(), "patterns");
        assert.ok(result.includes("Layered Architecture"));
        assert.ok(result.includes("90%"));
      });

      test("includes indicators", () => {
        const result = formatArchitectureContext(makeAnalysis(), "patterns");
        assert.ok(result.includes("controllers/ directory"));
        assert.ok(result.includes("services/ directory"));
      });

      test("caps patterns at MAX_PATTERNS", () => {
        const analysis = makeAnalysis({
          architectureReport: {
            projectType: "API",
            entryPoints: [],
            patterns: Array.from({ length: 10 }, (_, i) => ({
              name: `Pattern${i}`,
              confidence: 0.5,
              indicators: ["ind"],
            })),
          },
        });
        const result = formatArchitectureContext(analysis, "patterns");
        // MAX_PATTERNS = 5, so Pattern5–Pattern9 should not appear
        assert.ok(!result.includes("Pattern5"));
        assert.ok(!result.includes("Pattern9"));
      });
    });

    suite("call-graph section", () => {
      test("includes node and edge counts", () => {
        const result = formatArchitectureContext(makeAnalysis(), "call-graph");
        assert.ok(result.includes("42 modules"));
        assert.ok(result.includes("87 import edges"));
      });

      test("includes hot nodes", () => {
        const result = formatArchitectureContext(makeAnalysis(), "call-graph");
        assert.ok(result.includes("src/utils/logger.ts"));
      });

      test("includes circular dependencies", () => {
        const result = formatArchitectureContext(makeAnalysis(), "call-graph");
        assert.ok(result.includes("Circular dependencies"));
        assert.ok(result.includes("a.ts"));
      });
    });

    suite("middleware section", () => {
      test("includes auth strategies", () => {
        const result = formatArchitectureContext(makeAnalysis(), "middleware");
        assert.ok(result.includes("JWT"));
      });

      test("includes middleware chain", () => {
        const result = formatArchitectureContext(makeAnalysis(), "middleware");
        assert.ok(result.includes("auth"));
        assert.ok(result.includes("express"));
      });

      test("includes error handlers", () => {
        const result = formatArchitectureContext(makeAnalysis(), "middleware");
        assert.ok(result.includes("Error Handlers"));
      });
    });

    suite("endpoints section", () => {
      test("includes endpoint method and path", () => {
        const result = formatArchitectureContext(makeAnalysis(), "endpoints");
        assert.ok(result.includes("GET /api/v1/users"));
      });

      test("shows overflow count when endpoints exceed limit", () => {
        const analysis = makeAnalysis({
          apiEndpoints: Array.from({ length: 20 }, (_, i) => ({
            method: "GET",
            path: `/api/v${i}`,
            file: `route${i}.ts`,
          })),
        });
        const result = formatArchitectureContext(analysis, "endpoints");
        assert.ok(result.includes("... and 5 more endpoints"));
      });
    });

    suite("models section", () => {
      test("includes model name", () => {
        const result = formatArchitectureContext(makeAnalysis(), "models");
        assert.ok(result.includes("User"));
      });

      test("includes model properties", () => {
        const result = formatArchitectureContext(makeAnalysis(), "models");
        assert.ok(result.includes("id"));
        assert.ok(result.includes("name"));
      });

      test("shows overflow count when models exceed limit", () => {
        const analysis = makeAnalysis({
          dataModels: Array.from({ length: 15 }, (_, i) => ({
            name: `Model${i}`,
            type: "interface",
          })),
        });
        const result = formatArchitectureContext(analysis, "models");
        assert.ok(result.includes("... and 5 more models"));
      });
    });

    suite("empty data", () => {
      test("returns fallback message when no data for targeted section", () => {
        // A targeted section with no matching data returns the fallback
        const result = formatArchitectureContext({}, "patterns");
        assert.ok(result.includes("No architecture data available"));
      });

      test("overview with empty data still produces heading", () => {
        // "all" includes overview which unconditionally adds a heading
        const result = formatArchitectureContext({}, "all");
        assert.ok(result.includes("Codebase Architecture Overview"));
      });

      test("returns fallback when call-graph is absent", () => {
        const result = formatArchitectureContext({}, "call-graph");
        assert.ok(result.includes("No architecture data available"));
      });
    });

    suite("output size cap", () => {
      test("truncates output beyond MAX_OUTPUT_CHARS", () => {
        // Build an analysis object that produces >12K chars even after
        // per-section slice limits. The overview section includes
        // frameworks (unsliced) and file count, so we inflate frameworks.
        const analysis = makeAnalysis({
          frameworks: Array.from(
            { length: 300 },
            (_, i) =>
              `SomeVeryLongFrameworkOrTechnologyName-${i}-with-extra-padding`,
          ),
          architectureReport: {
            projectType: "Massive Microservice Platform",
            entryPoints: Array.from(
              { length: 20 },
              (_, i) => `packages/service-${i}/src/index.ts`,
            ),
            patterns: Array.from({ length: 10 }, (_, i) => ({
              name: `Very Long Architecture Pattern Name Number ${i}`,
              confidence: 0.8,
              indicators: Array.from(
                { length: 20 },
                (__, j) =>
                  `Indicator ${j} for pattern ${i}: detected in many/deeply/nested/directories`,
              ),
            })),
          },
          apiEndpoints: Array.from({ length: 500 }, (_, i) => ({
            method: "GET",
            path: `/api/very/long/path/segment/v${i}/resource/sub-resource/action`,
            file: `src/routes/deeply/nested/module/route-handler-${i}.ts`,
          })),
          dataModels: Array.from({ length: 200 }, (_, i) => ({
            name: `VeryLongModelName${i}WithExtraDescription`,
            type: "class",
            properties: Array.from(
              { length: 10 },
              (__, j) => `longPropertyName${j}`,
            ),
          })),
        });
        const result = formatArchitectureContext(analysis, "all");
        // MAX_OUTPUT_CHARS=12000 + truncation notice ~100 chars
        assert.ok(
          result.length <= 12_200,
          `Output too long: ${result.length} chars`,
        );
        assert.ok(
          result.includes("Output truncated"),
          "Missing truncation notice",
        );
      });

      test("does not truncate small output", () => {
        const result = formatArchitectureContext(makeAnalysis(), "overview");
        assert.ok(
          !result.includes("Output truncated"),
          "Small output should not be truncated",
        );
      });
    });

    suite("section isolation", () => {
      test("overview does not include call-graph data", () => {
        const result = formatArchitectureContext(makeAnalysis(), "overview");
        assert.ok(!result.includes("Import Graph"));
        assert.ok(!result.includes("dependency hubs"));
      });

      test("patterns does not include middleware data", () => {
        const result = formatArchitectureContext(makeAnalysis(), "patterns");
        assert.ok(!result.includes("Middleware"));
        assert.ok(!result.includes("Auth Strategies"));
      });

      test("all includes data from every section", () => {
        const result = formatArchitectureContext(makeAnalysis(), "all");
        assert.ok(result.includes("Architecture Overview"));
        assert.ok(result.includes("Architectural Patterns"));
        assert.ok(result.includes("Import Graph"));
        assert.ok(result.includes("Middleware & Auth"));
        assert.ok(result.includes("API Endpoints"));
        assert.ok(result.includes("Data Models"));
      });
    });
  });
});
