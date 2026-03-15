import * as assert from "assert";
import {
  detectMiddleware,
  type MiddlewareReport,
} from "../../services/analyzers/middleware-detector";
import type {
  CodeSnippet,
  ModelData,
} from "../../interfaces/analysis.interface";

function makeSnippet(overrides: Partial<CodeSnippet>): CodeSnippet {
  return {
    file: "/workspace/src/app.ts",
    content: "",
    language: "typescript",
    ...overrides,
  };
}

suite("Middleware Detector", () => {
  suite("file-based detection", () => {
    test("detects files in middleware/ directory", () => {
      const report = detectMiddleware(
        [
          "/workspace/src/middleware/auth.ts",
          "/workspace/src/middleware/logging.ts",
        ],
        [],
        [],
      );
      assert.strictEqual(report.middleware.length, 2);
      assert.ok(report.middleware.some((m) => m.name === "auth" && m.type === "auth"));
      assert.ok(report.middleware.some((m) => m.name === "logging" && m.type === "logging"));
    });

    test("detects files in guards/ directory", () => {
      const report = detectMiddleware(
        ["/workspace/src/guards/jwt-auth.guard.ts"],
        [],
        [],
      );
      assert.strictEqual(report.middleware.length, 1);
      assert.strictEqual(report.middleware[0].type, "auth");
    });

    test("ignores files not in middleware directories", () => {
      const report = detectMiddleware(
        ["/workspace/src/services/user.service.ts"],
        [],
        [],
      );
      assert.strictEqual(report.middleware.length, 0);
    });
  });

  suite("Express middleware detection", () => {
    test("detects app.use with named handler", () => {
      const report = detectMiddleware(
        [],
        [
          makeSnippet({
            content: `app.use(cors);\napp.use(helmet);`,
          }),
        ],
        [],
      );
      assert.ok(report.middleware.some((m) => m.name === "cors"));
      assert.ok(report.middleware.some((m) => m.name === "helmet"));
    });

    test("detects app.use with route pattern", () => {
      const report = detectMiddleware(
        [],
        [
          makeSnippet({
            content: `app.use('/api', authMiddleware)`,
          }),
        ],
        [],
      );
      assert.ok(report.middleware.some((m) => m.appliesTo === "/api"));
    });

    test("marks global app.use without route", () => {
      const report = detectMiddleware(
        [],
        [
          makeSnippet({
            content: `app.use(morgan('combined'))`,
          }),
        ],
        [],
      );
      assert.ok(report.hasGlobalMiddleware);
    });
  });

  suite("NestJS decorator detection", () => {
    test("detects @UseGuards", () => {
      const report = detectMiddleware(
        [],
        [
          makeSnippet({
            content: `@UseGuards(JwtAuthGuard)\n@Controller('users')\nexport class UsersController {}`,
          }),
        ],
        [],
      );
      assert.ok(
        report.middleware.some((m) => m.name === "JwtAuthGuard"),
      );
    });

    test("detects @UseInterceptors", () => {
      const report = detectMiddleware(
        [],
        [
          makeSnippet({
            content: `@UseInterceptors(LoggingInterceptor)\nexport class AppController {}`,
          }),
        ],
        [],
      );
      assert.ok(
        report.middleware.some((m) => m.name === "LoggingInterceptor"),
      );
    });

    test("detects @UsePipes", () => {
      const report = detectMiddleware(
        [],
        [
          makeSnippet({
            content: `@UsePipes(ValidationPipe)\nexport class CreateUserDto {}`,
          }),
        ],
        [],
      );
      assert.ok(
        report.middleware.some(
          (m) => m.name === "ValidationPipe" && m.type === "validation",
        ),
      );
    });

    test("handles multiple guards in one decorator", () => {
      const report = detectMiddleware(
        [],
        [
          makeSnippet({
            content: `@UseGuards(JwtAuthGuard, RolesGuard)`,
          }),
        ],
        [],
      );
      assert.ok(report.middleware.some((m) => m.name === "JwtAuthGuard"));
      assert.ok(report.middleware.some((m) => m.name === "RolesGuard"));
    });
  });

  suite("error handler detection", () => {
    test("detects Express-style error handler (4 params)", () => {
      const report = detectMiddleware(
        [],
        [
          makeSnippet({
            file: "/workspace/src/error-handler.ts",
            content: `function errorHandler(err, req, res, next) { res.status(500).send('Error'); }`,
          }),
        ],
        [],
      );
      assert.strictEqual(report.errorHandlers.length, 1);
      assert.strictEqual(report.errorHandlers[0].type, "error-handler");
    });

    test("no false positive for 3-param middleware", () => {
      const report = detectMiddleware(
        [],
        [
          makeSnippet({
            content: `function handler(req, res, next) { next(); }`,
          }),
        ],
        [],
      );
      assert.strictEqual(report.errorHandlers.length, 0);
    });
  });

  suite("auth strategy detection", () => {
    test("detects JWT from content patterns", () => {
      const report = detectMiddleware(
        [],
        [
          makeSnippet({
            content: `import jwt from 'jsonwebtoken';\nconst token = jwt.sign(payload, secret);`,
          }),
        ],
        [],
      );
      assert.ok(report.authFlows.some((a) => a.strategy === "jwt"));
    });

    test("detects session strategy from file name", () => {
      const report = detectMiddleware(
        ["/workspace/src/auth/session.ts"],
        [],
        [],
      );
      assert.ok(report.authFlows.some((a) => a.strategy === "session"));
    });

    test("detects OAuth from content", () => {
      const report = detectMiddleware(
        [],
        [
          makeSnippet({
            content: `import passport from 'passport';\npassport.use(new OAuth2Strategy(options, verify));`,
          }),
        ],
        [],
      );
      assert.ok(report.authFlows.some((a) => a.strategy === "oauth"));
    });

    test("detects API key from content", () => {
      const report = detectMiddleware(
        [],
        [
          makeSnippet({
            content: `const apiKey = req.headers['x-api-key'];`,
          }),
        ],
        [],
      );
      assert.ok(report.authFlows.some((a) => a.strategy === "api-key"));
    });
  });

  suite("model-based detection", () => {
    test("detects Guard/Middleware class names from models", () => {
      const report = detectMiddleware(
        [],
        [],
        [
          {
            name: "AuthGuard",
            type: "class",
            file: "/workspace/src/guards/auth.guard.ts",
          } as ModelData,
        ],
      );
      assert.ok(
        report.middleware.some((m) => m.name === "AuthGuard"),
      );
    });

    test("ignores models without Guard/Middleware in name", () => {
      const report = detectMiddleware(
        [],
        [],
        [
          {
            name: "UserService",
            type: "class",
            file: "/workspace/src/services/user.service.ts",
          } as ModelData,
        ],
      );
      assert.strictEqual(report.middleware.length, 0);
    });
  });

  suite("deduplication", () => {
    test("deduplicates middleware by name + file", () => {
      const report = detectMiddleware(
        ["/workspace/src/middleware/auth.ts"],
        [],
        [
          {
            name: "auth",
            type: "class",
            file: "/workspace/src/middleware/auth.ts",
          } as ModelData,
        ],
      );
      // Both file-based and model-based detection may find "auth" at same file;
      // model-based won't match because "auth" doesn't have Guard/Middleware etc.
      // But file-based detection will find it
      const authMiddleware = report.middleware.filter(
        (m) => m.name === "auth" && m.file === "/workspace/src/middleware/auth.ts",
      );
      assert.strictEqual(authMiddleware.length, 1);
    });
  });
});
