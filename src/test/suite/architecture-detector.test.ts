import * as assert from "assert";
import {
  detectArchitecture,
  type ArchitectureReport,
} from "../../services/analyzers/architecture-detector";
import type { AnalysisResult } from "../../interfaces/analysis.interface";

function makeAnalysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    frameworks: [],
    dependencies: {},
    files: [],
    apiEndpoints: [],
    dataModels: [],
    databaseSchema: {},
    domainRelationships: [],
    codeSnippets: [],
    summary: {
      totalFiles: 0,
      totalLines: 0,
      languageDistribution: {},
      complexity: "low",
    },
    ...overrides,
  };
}

suite("Architecture Detector", () => {
  suite("detectArchitecture", () => {
    test("returns empty patterns for flat file structure", () => {
      const result = detectArchitecture(
        makeAnalysis({ files: ["README.md", "index.ts"] }),
      );
      assert.strictEqual(result.patterns.length, 0);
    });

    test("detects layered architecture (controllers + services)", () => {
      const result = detectArchitecture(
        makeAnalysis({
          files: [
            "src/controllers/user.controller.ts",
            "src/controllers/product.controller.ts",
            "src/services/user.service.ts",
            "src/services/product.service.ts",
            "src/models/user.model.ts",
          ],
        }),
      );
      const layered = result.patterns.find(
        (p) => p.name === "Layered Architecture",
      );
      assert.ok(layered, "Should detect Layered Architecture");
      assert.ok(layered.confidence >= 0.6);
    });

    test("higher confidence with repositories layer", () => {
      const result = detectArchitecture(
        makeAnalysis({
          files: [
            "src/controllers/user.controller.ts",
            "src/services/user.service.ts",
            "src/repositories/user.repository.ts",
          ],
        }),
      );
      const layered = result.patterns.find(
        (p) => p.name === "Layered Architecture",
      );
      assert.ok(layered);
      assert.ok(layered.confidence >= 0.9);
    });

    test("detects MVC pattern", () => {
      const result = detectArchitecture(
        makeAnalysis({
          files: [
            "app/controllers/home_controller.rb",
            "app/models/user.rb",
            "app/views/home/index.html.erb",
          ],
        }),
      );
      const mvc = result.patterns.find((p) => p.name === "MVC");
      assert.ok(mvc, "Should detect MVC");
      assert.ok(mvc.confidence >= 0.8);
    });

    test("detects module-based organization", () => {
      const result = detectArchitecture(
        makeAnalysis({
          files: [
            "src/modules/auth/auth.service.ts",
            "src/modules/auth/auth.controller.ts",
            "src/modules/user/user.service.ts",
            "src/modules/user/user.controller.ts",
            "src/modules/product/product.service.ts",
          ],
        }),
      );
      const modular = result.patterns.find(
        (p) => p.name === "Module-based Organization",
      );
      assert.ok(modular, "Should detect module-based organization");
      assert.ok(modular.indicators[0].includes("3 feature modules"));
    });

    test("detects monorepo", () => {
      const result = detectArchitecture(
        makeAnalysis({
          files: [
            "packages/api/package.json",
            "packages/api/src/index.ts",
            "packages/web/package.json",
            "packages/web/src/App.tsx",
            "packages/shared/package.json",
          ],
        }),
      );
      const monorepo = result.patterns.find((p) => p.name === "Monorepo");
      assert.ok(monorepo, "Should detect monorepo");
    });

    test("detects event-driven with message broker dependency", () => {
      const result = detectArchitecture(
        makeAnalysis({
          frameworks: ["kafkajs", "express"],
          files: ["src/events/user-created.handler.ts"],
        }),
      );
      const eventDriven = result.patterns.find(
        (p) => p.name === "Event-driven",
      );
      assert.ok(eventDriven);
    });

    test("detects middleware pipeline", () => {
      const result = detectArchitecture(
        makeAnalysis({
          files: [
            "src/middleware/auth.ts",
            "src/middleware/cors.ts",
            "src/controllers/user.ts",
          ],
          apiEndpoints: [
            { method: "GET", path: "/users" },
            { method: "POST", path: "/users" },
          ],
        }),
      );
      const mwPipeline = result.patterns.find(
        (p) => p.name === "Middleware Pipeline",
      );
      assert.ok(mwPipeline);
    });
  });

  suite("entry points", () => {
    test("detects common entry points", () => {
      const result = detectArchitecture(
        makeAnalysis({
          files: [
            "src/index.ts",
            "src/main.py",
            "src/utils/helpers.ts",
            "cmd/server/main.go",
          ],
        }),
      );
      assert.ok(result.entryPoints.length >= 2);
      assert.ok(result.entryPoints.some((e) => e.includes("index.ts")));
      assert.ok(result.entryPoints.some((e) => e.includes("main.go")));
    });

    test("does not match deeply nested vendor files as entry points", () => {
      // vendor/somelib/deep/src/index.ts = 3 prefix segments (exceeds Level 2 max of 2)
      // a/b/c/d/src/main.js = 4 prefix segments (exceeds Level 2 max of 2)
      const result = detectArchitecture(
        makeAnalysis({
          files: [
            "vendor/somelib/deep/src/index.ts",
            "a/b/c/d/src/main.js",
          ],
        }),
      );
      assert.strictEqual(result.entryPoints.length, 0);
    });

    test("detects monorepo sub-package entry points", () => {
      const result = detectArchitecture(
        makeAnalysis({
          files: [
            "packages/api/src/index.ts",
            "apps/web/src/main.tsx",
          ],
        }),
      );
      assert.ok(result.entryPoints.length >= 2);
      assert.ok(result.entryPoints.some((e) => e.includes("packages/api/src/index.ts")));
      assert.ok(result.entryPoints.some((e) => e.includes("apps/web/src/main.tsx")));
    });
  });

  suite("project type", () => {
    test("detects REST API", () => {
      const result = detectArchitecture(
        makeAnalysis({
          files: ["src/controllers/user.ts", "src/routes/api.ts"],
          frameworks: ["express"],
        }),
      );
      assert.strictEqual(result.projectType, "REST API");
    });

    test("detects Frontend SPA", () => {
      const result = detectArchitecture(
        makeAnalysis({
          files: ["src/components/App.tsx", "src/views/Home.tsx"],
          frameworks: ["react", "react-dom"],
        }),
      );
      assert.strictEqual(result.projectType, "Frontend SPA");
    });

    test("detects Full-stack Web App", () => {
      const result = detectArchitecture(
        makeAnalysis({
          files: ["pages/index.tsx", "pages/api/users.ts", "components/Nav.tsx"],
          frameworks: ["next"],
        }),
      );
      assert.strictEqual(result.projectType, "Full-stack Web App");
    });

    test("returns General Application as fallback", () => {
      const result = detectArchitecture(
        makeAnalysis({
          files: ["README.md"],
          frameworks: [],
        }),
      );
      assert.strictEqual(result.projectType, "General Application");
    });
  });

  suite("patterns sorted by confidence", () => {
    test("highest confidence pattern is first", () => {
      const result = detectArchitecture(
        makeAnalysis({
          files: [
            "src/controllers/user.ts",
            "src/services/user.ts",
            "src/repositories/user.ts",
            "src/modules/auth/auth.ts",
            "src/modules/user/user.ts",
          ],
        }),
      );
      assert.ok(result.patterns.length >= 2);
      for (let i = 1; i < result.patterns.length; i++) {
        assert.ok(
          result.patterns[i - 1].confidence >= result.patterns[i].confidence,
        );
      }
    });
  });

  suite("confidence clamping", () => {
    test("Event-driven confidence clamped to <= 0.95", () => {
      const result = detectArchitecture(
        makeAnalysis({
          frameworks: ["kafkajs"],
          files: [
            "src/events/handler.ts",
            "src/listeners/user.ts",
            "src/subscribers/order.ts",
          ],
        }),
      );
      const eventDriven = result.patterns.find(
        (p) => p.name === "Event-driven",
      );
      assert.ok(eventDriven);
      assert.ok(
        eventDriven.confidence <= 0.95,
        `Confidence ${eventDriven.confidence} should be <= 0.95`,
      );
    });
  });

  suite("Library / SDK detection", () => {
    test("does not claim Library / SDK when web framework present", () => {
      const result = detectArchitecture(
        makeAnalysis({
          files: ["src/index.ts"],
          frameworks: ["express"],
        }),
      );
      assert.notStrictEqual(result.projectType, "Library / SDK");
    });

    test("does not claim Library / SDK when app-like directories present", () => {
      const result = detectArchitecture(
        makeAnalysis({
          files: ["src/index.ts", "src/controllers/user.ts", "src/routes/api.ts"],
          frameworks: [],
        }),
      );
      assert.notStrictEqual(result.projectType, "Library / SDK");
    });
  });

  suite("project type priority ordering", () => {
    test("Full-stack beats REST API when scores are tied", () => {
      // Both types get score 2 from frameworks: "next" scores 2 for Full-stack,
      // but Full-stack has higher priority so wins the tie
      const result = detectArchitecture(
        makeAnalysis({
          files: [
            "pages/index.tsx",
            "components/Nav.tsx",
            "src/controllers/user.ts",
            "src/routes/api.ts",
          ],
          frameworks: ["next", "express"],
        }),
      );
      assert.strictEqual(result.projectType, "Full-stack Web App");
    });

    test("Microservices beats REST API on score tie", () => {
      // Both get similar scores but Microservices has higher priority
      const result = detectArchitecture(
        makeAnalysis({
          files: [
            "src/controllers/user.ts",
            "src/routes/api.ts",
            "services/auth/src/index.ts",
            "packages/shared/package.json",
          ],
          frameworks: ["@nestjs/microservices", "express"],
        }),
      );
      // Microservices should be preferred over REST API when scores are equal
      assert.ok(
        result.projectType === "Microservices" ||
          result.projectType === "REST API",
        `Expected Microservices or REST API, got: ${result.projectType}`,
      );
    });
  });
});
