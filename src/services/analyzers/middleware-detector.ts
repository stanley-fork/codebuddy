/**
 * Middleware & Auth Flow Detector
 *
 * Detects middleware chains, auth guards, error handlers,
 * and request lifecycle hooks from code structure and endpoints.
 */

import type {
  EndpointData,
  ModelData,
  CodeSnippet,
} from "../../interfaces/analysis.interface";
import type { ExtractedFunction, ExtractedClass } from "./tree-sitter-analyzer";

// ─── Types ───────────────────────────────────────────────────────

export interface MiddlewareInfo {
  name: string;
  type: MiddlewareType;
  file: string;
  line?: number;
  appliesTo?: string; // route pattern or "global"
}

export type MiddlewareType =
  | "auth"
  | "validation"
  | "logging"
  | "error-handler"
  | "cors"
  | "rate-limit"
  | "general";

export interface AuthFlow {
  strategy: string; // "jwt", "session", "oauth", "api-key", "basic"
  indicators: string[];
  files: string[];
}

export interface MiddlewareReport {
  middleware: MiddlewareInfo[];
  authFlows: AuthFlow[];
  errorHandlers: MiddlewareInfo[];
  hasGlobalMiddleware: boolean;
}

// ─── Constants ───────────────────────────────────────────────────

// Auth-related patterns appear near the top of files (imports, decorators, middleware setup).
// Scanning beyond this limit adds cost with negligible detection benefit.
const MAX_SNIPPET_SCAN_CHARS = 5000;

const AUTH_PATTERNS: Record<
  string,
  { filePatterns: RegExp[]; contentPatterns: RegExp[] }
> = {
  jwt: {
    filePatterns: [/jwt/i, /token/i],
    contentPatterns: [
      /jsonwebtoken|jwt\.sign|jwt\.verify|JwtStrategy|JwtAuthGuard|@UseGuards.*Jwt/i,
    ],
  },
  session: {
    filePatterns: [/session/i],
    contentPatterns: [/express-session|cookie-session|req\.session/i],
  },
  oauth: {
    filePatterns: [/oauth/i, /passport/i],
    contentPatterns: [/passport|OAuth2Strategy|oauth2|@nestjs\/passport/i],
  },
  "api-key": {
    filePatterns: [/api-?key/i],
    contentPatterns: [/x-api-key|apiKey|api_key/i],
  },
  basic: {
    filePatterns: [/basic-?auth/i],
    contentPatterns: [/basic-auth|BasicAuthGuard|Authorization.*Basic/i],
  },
};

const MIDDLEWARE_NAME_PATTERNS: Record<MiddlewareType, RegExp> = {
  auth: /auth|guard|protect|verify|jwt|token|passport|session/i,
  validation: /validat(?:e|or|ion)|sanitiz|schema|zod|joi|yup|class-validator/i,
  logging: /log(?:ger|ging)?|morgan|winston|pino|request-log/i,
  "error-handler": /error|exception|fallback|catch|notFound|404/i,
  cors: /cors/i,
  "rate-limit": /rate-?limit|throttl/i,
  general: /./,
};

// Express-style error handler: (err, req, res, next)
const ERROR_HANDLER_PATTERN =
  /\(\s*(?:err|error)\s*,\s*(?:req|request)\s*,\s*(?:res|response)\s*,\s*(?:next)\s*\)/;

// app.use / router.use patterns — bounded quantifier to prevent ReDoS
// Defined as source string; each call site constructs a fresh RegExp to avoid lastIndex state
const MIDDLEWARE_USE_SOURCE =
  /(?:app|router|server)\.use\(\s*(?:['"`]([^'"`]{1,200})['"`]\s*,\s*)?([^(),]{1,80})/
    .source;

// NestJS decorator sources — constructed fresh per call to avoid stateful global regex
const NESTJS_DECORATOR_SOURCES: {
  source: string;
  defaultType: MiddlewareType;
}[] = [
  { source: /@UseGuards\s*\(\s*([^)]+)\s*\)/.source, defaultType: "auth" },
  {
    source: /@UseInterceptors\s*\(\s*([^)]+)\s*\)/.source,
    defaultType: "general",
  },
  {
    source: /@UsePipes\s*\(\s*([^)]+)\s*\)/.source,
    defaultType: "validation",
  },
];

// ─── Detector ────────────────────────────────────────────────────

export function detectMiddleware(
  files: string[],
  codeSnippets: CodeSnippet[],
  dataModels: ModelData[],
): MiddlewareReport {
  const middleware: MiddlewareInfo[] = [];
  const errorHandlers: MiddlewareInfo[] = [];
  const authFlows: AuthFlow[] = [];

  // 1. Detect middleware from file names and directory structure
  detectMiddlewareFromFiles(files, middleware);

  // 2. Detect middleware/guards from code snippets
  for (const snippet of codeSnippets) {
    detectExpressMiddleware(snippet, middleware);
    detectNestJSDecorators(snippet, middleware);
    detectErrorHandlers(snippet, errorHandlers);
  }

  // 3. Detect auth strategies from files + snippets
  detectAuthStrategies(files, codeSnippets, authFlows);

  // 4. Detect middleware from class names / types
  detectMiddlewareFromModels(dataModels, middleware);

  // Deduplicate by name + file
  const seen = new Set<string>();
  const deduped = middleware.filter((m) => {
    const key = `${m.name}:${m.file}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const hasGlobalMiddleware = deduped.some(
    (m) => m.appliesTo === "global" || !m.appliesTo,
  );

  return {
    middleware: deduped,
    authFlows,
    errorHandlers,
    hasGlobalMiddleware,
  };
}

// ─── File-based Detection ────────────────────────────────────────

function detectMiddlewareFromFiles(
  files: string[],
  middleware: MiddlewareInfo[],
): void {
  const middlewareDir =
    /(?:^|[\\/])(?:middlewar(?:e|es)|guards?|interceptors?|pipes?|filters?)[\\/]/i;

  for (const file of files) {
    if (!middlewareDir.test(file)) continue;

    const baseName =
      file
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? "";
    const type = classifyMiddleware(baseName);

    middleware.push({
      name: baseName,
      type,
      file,
    });
  }
}

// ─── Express Middleware Detection ─────────────────────────────────

function detectExpressMiddleware(
  snippet: CodeSnippet,
  middleware: MiddlewareInfo[],
): void {
  const content = snippet.content;

  for (const match of content.matchAll(
    new RegExp(MIDDLEWARE_USE_SOURCE, "g"),
  )) {
    const route = match[1] || undefined;
    const handler = match[2]?.trim();
    if (!handler) continue;

    // Extract handler name (strip function call parens)
    const name = handler.replace(/\(.*\)$/, "").trim();
    if (!name || name.length > 60) continue; // skip inline functions

    const type = classifyMiddleware(name);
    middleware.push({
      name,
      type,
      file: snippet.file,
      appliesTo: route ?? "global",
    });
  }
}

// ─── NestJS Decorator Detection ──────────────────────────────────

function detectNestJSDecorators(
  snippet: CodeSnippet,
  middleware: MiddlewareInfo[],
): void {
  const content = snippet.content;

  for (const { source, defaultType } of NESTJS_DECORATOR_SOURCES) {
    for (const match of content.matchAll(new RegExp(source, "g"))) {
      const names = match[1]
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      for (const name of names) {
        const classified = classifyMiddleware(name);
        middleware.push({
          name,
          type: classified === "general" ? defaultType : classified,
          file: snippet.file,
        });
      }
    }
  }
}

// ─── Error Handler Detection ─────────────────────────────────────

function detectErrorHandlers(
  snippet: CodeSnippet,
  errorHandlers: MiddlewareInfo[],
): void {
  if (ERROR_HANDLER_PATTERN.test(snippet.content)) {
    const baseName =
      snippet.file
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? "unknown";
    errorHandlers.push({
      name: baseName,
      type: "error-handler",
      file: snippet.file,
    });
  }
}

// ─── Auth Strategy Detection ─────────────────────────────────────

function detectAuthStrategies(
  files: string[],
  snippets: CodeSnippet[],
  authFlows: AuthFlow[],
): void {
  for (const [strategy, patterns] of Object.entries(AUTH_PATTERNS)) {
    const indicators: string[] = [];
    const authFileSet = new Set<string>();

    // Check file names
    for (const file of files) {
      const basename = file.split(/[\\/]/).pop() ?? "";
      if (patterns.filePatterns.some((p) => p.test(basename))) {
        indicators.push(`File: ${basename}`);
        authFileSet.add(file);
      }
    }

    // Check snippet content (bounded to MAX_SNIPPET_SCAN_CHARS)
    for (const snippet of snippets) {
      const content =
        snippet.content.length > MAX_SNIPPET_SCAN_CHARS
          ? snippet.content.slice(0, MAX_SNIPPET_SCAN_CHARS)
          : snippet.content;
      if (patterns.contentPatterns.some((p) => p.test(content))) {
        indicators.push(`Code pattern in ${snippet.file.split(/[\\/]/).pop()}`);
        authFileSet.add(snippet.file);
      }
    }

    if (indicators.length > 0) {
      authFlows.push({ strategy, indicators, files: [...authFileSet] });
    }
  }
}

// ─── Model-based Detection ───────────────────────────────────────

function detectMiddlewareFromModels(
  models: ModelData[],
  middleware: MiddlewareInfo[],
): void {
  const guardPattern = /Guard|Middleware|Interceptor|Filter|Pipe|Strategy/i;

  for (const model of models) {
    if (!guardPattern.test(model.name)) continue;

    const type = classifyMiddleware(model.name);
    middleware.push({
      name: model.name,
      type,
      file: model.file ?? "unknown",
      line: model.startLine,
    });
  }
}

// ─── Classification ──────────────────────────────────────────────

function classifyMiddleware(name: string): MiddlewareType {
  for (const [type, pattern] of Object.entries(MIDDLEWARE_NAME_PATTERNS)) {
    if (type === "general") continue; // skip fallback
    if (pattern.test(name)) return type as MiddlewareType;
  }
  return "general";
}
