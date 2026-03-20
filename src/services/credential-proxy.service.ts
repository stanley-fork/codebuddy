import * as http from "node:http";
import * as https from "node:https";
import * as url from "node:url";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../infrastructure/logger/logger";
import type { SecretStorageService } from "./secret-storage";
import { APP_CONFIG } from "../application/constant";

// ─── Types ───────────────────────────────────────────────────────────

interface ProviderRoute {
  /** Real upstream base URL (no trailing slash). */
  target: string;
  /** Config key in APP_CONFIG for the API key. */
  configKey: string;
  /** Header name for the credential. */
  authHeader: string;
  /** Header value format — `%s` is replaced with the API key. */
  authFormat: string;
  /** Extra headers to inject (e.g. anthropic-version). */
  extraHeaders?: Record<string, string>;
}

export interface ProxyAuditEntry {
  timestamp: number;
  provider: string;
  method: string;
  path: string;
  statusCode: number;
  latencyMs: number;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  maxTokens: number;
  refillRate: number; // tokens per ms
}

// ─── Provider routing table ──────────────────────────────────────────

const PROVIDER_ROUTES: Record<string, ProviderRoute> = {
  anthropic: {
    target: "https://api.anthropic.com",
    configKey: APP_CONFIG.anthropicApiKey,
    authHeader: "x-api-key",
    authFormat: "%s",
    extraHeaders: { "anthropic-version": "2023-06-01" },
  },
  openai: {
    target: "https://api.openai.com",
    configKey: APP_CONFIG.openaiApiKey,
    authHeader: "authorization",
    authFormat: "Bearer %s",
  },
  groq: {
    target: "https://api.groq.com/openai",
    configKey: APP_CONFIG.groqApiKey,
    authHeader: "authorization",
    authFormat: "Bearer %s",
  },
  deepseek: {
    target: "https://api.deepseek.com",
    configKey: APP_CONFIG.deepseekApiKey,
    authHeader: "authorization",
    authFormat: "Bearer %s",
  },
  qwen: {
    target: "https://dashscope-intl.aliyuncs.com/compatible-mode",
    configKey: APP_CONFIG.qwenApiKey,
    authHeader: "authorization",
    authFormat: "Bearer %s",
  },
  glm: {
    target: "https://open.bigmodel.cn/api/paas",
    configKey: APP_CONFIG.glmApiKey,
    authHeader: "authorization",
    authFormat: "Bearer %s",
  },
  grok: {
    target: "https://api.x.ai",
    configKey: APP_CONFIG.grokApiKey,
    authHeader: "authorization",
    authFormat: "Bearer %s",
  },
  tavily: {
    target: "https://api.tavily.com",
    configKey: APP_CONFIG.tavilyApiKey,
    authHeader: "authorization",
    authFormat: "Bearer %s",
  },
  local: {
    target: "http://localhost:11434",
    configKey: APP_CONFIG.localApiKey,
    authHeader: "authorization",
    authFormat: "Bearer %s",
  },
};

/** Headers that must never be forwarded from the client. */
const STRIPPED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
]);

const MAX_AUDIT_ENTRIES = 1000;

// ─── Service ─────────────────────────────────────────────────────────

export class CredentialProxyService implements vscode.Disposable {
  private static instance: CredentialProxyService | undefined;
  private readonly logger: Logger;
  private server: http.Server | undefined;
  private port = 0;
  private secretStorage: SecretStorageService | undefined;
  private readonly auditLog: ProxyAuditEntry[] = [];
  private readonly rateBuckets = new Map<string, TokenBucket>();

  private constructor() {
    this.logger = Logger.initialize("CredentialProxy", {
      minLevel: LogLevel.DEBUG,
      enableConsole: true,
      enableFile: true,
      enableTelemetry: true,
    });
  }

  public static getInstance(): CredentialProxyService {
    if (!CredentialProxyService.instance) {
      CredentialProxyService.instance = new CredentialProxyService();
    }
    return CredentialProxyService.instance;
  }

  /** Start the proxy server. Resolves once listening. */
  public async start(secretStorage: SecretStorageService): Promise<void> {
    if (this.server) return; // already running
    this.secretStorage = secretStorage;

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this.handleRequest(req, res));

      srv.on("error", (err) => {
        this.logger.error(`Credential proxy server error: ${err.message}`);
        reject(err);
      });

      // Bind to localhost only — never expose to network
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        this.server = srv;
        this.logger.info(
          `Credential proxy listening on 127.0.0.1:${this.port}`,
        );
        resolve();
      });
    });
  }

  /** The port the proxy is listening on (0 if not started). */
  public getPort(): number {
    return this.port;
  }

  /** Whether the proxy server is currently running. */
  public isRunning(): boolean {
    return this.server !== undefined && this.server.listening;
  }

  /** Build the proxy base URL for a given provider. */
  public getProxyUrl(provider: string): string {
    return `http://127.0.0.1:${this.port}/${provider}`;
  }

  /** Get the audit log (read-only snapshot). */
  public getAuditLog(): readonly ProxyAuditEntry[] {
    return this.auditLog;
  }

  public dispose(): void {
    if (this.server) {
      this.server.close();
      this.server = undefined;
      this.port = 0;
      this.logger.info("Credential proxy stopped");
    }
    CredentialProxyService.instance = undefined;
  }

  // ── Request handling ─────────────────────────────────────────────

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const startTime = Date.now();
    const reqUrl = req.url ?? "/";

    // Parse /<provider>/rest/of/path
    const slashIdx = reqUrl.indexOf("/", 1);
    const provider =
      slashIdx > 0 ? reqUrl.substring(1, slashIdx) : reqUrl.substring(1);
    const remainingPath = slashIdx > 0 ? reqUrl.substring(slashIdx) : "/";

    const route = PROVIDER_ROUTES[provider];
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown provider: ${provider}` }));
      return;
    }

    // Rate limiting
    if (!this.checkRateLimit(provider)) {
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "1",
      });
      res.end(JSON.stringify({ error: "Rate limit exceeded", provider }));
      this.recordAudit(
        provider,
        req.method ?? "?",
        remainingPath,
        429,
        startTime,
      );
      return;
    }

    // Resolve API key
    const apiKey = this.secretStorage?.getApiKey(route.configKey);
    if (!apiKey && provider !== "local") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: `No API key configured for ${provider}`,
        }),
      );
      this.recordAudit(
        provider,
        req.method ?? "?",
        remainingPath,
        401,
        startTime,
      );
      return;
    }

    // Build upstream URL
    const targetUrl = new url.URL(remainingPath, route.target);

    // Build headers — strip any client-sent auth, inject real credentials
    const headers: Record<string, string | string[]> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (val === undefined) continue;
      if (STRIPPED_HEADERS.has(key.toLowerCase())) continue;
      // Skip host — will be set by the upstream request
      if (key.toLowerCase() === "host") continue;
      headers[key] = val as string | string[];
    }

    // Inject credential
    if (apiKey) {
      headers[route.authHeader] = route.authFormat.replace("%s", apiKey);
    }

    // Inject extra headers (e.g. anthropic-version)
    if (route.extraHeaders) {
      for (const [k, v] of Object.entries(route.extraHeaders)) {
        headers[k] = v;
      }
    }

    // Forward the request
    const transport = targetUrl.protocol === "https:" ? https : http;
    const proxyReq = transport.request(
      targetUrl,
      {
        method: req.method,
        headers,
      },
      (proxyRes) => {
        const statusCode = proxyRes.statusCode ?? 502;
        // Forward response headers and status
        res.writeHead(statusCode, proxyRes.headers);
        // Stream response body (supports SSE)
        proxyRes.pipe(res, { end: true });

        this.recordAudit(
          provider,
          req.method ?? "?",
          remainingPath,
          statusCode,
          startTime,
        );
      },
    );

    proxyReq.on("error", (err) => {
      this.logger.error(`Proxy upstream error for ${provider}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Upstream connection failed",
            provider,
            detail: err.message,
          }),
        );
      }
      this.recordAudit(
        provider,
        req.method ?? "?",
        remainingPath,
        502,
        startTime,
      );
    });

    // Pipe request body to upstream
    req.pipe(proxyReq, { end: true });
  }

  // ── Rate limiting (token bucket) ─────────────────────────────────

  private checkRateLimit(provider: string): boolean {
    const limits = vscode.workspace
      .getConfiguration("codebuddy.credentialProxy")
      .get<Record<string, number>>("rateLimits");

    const maxRpm = limits?.[provider] ?? 60; // default: 60 requests/min
    const maxTokens = maxRpm;
    const refillRate = maxRpm / 60_000; // tokens per ms

    let bucket = this.rateBuckets.get(provider);
    if (!bucket) {
      bucket = {
        tokens: maxTokens,
        lastRefill: Date.now(),
        maxTokens,
        refillRate,
      };
      this.rateBuckets.set(provider, bucket);
    }

    // Refill
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(
      bucket.maxTokens,
      bucket.tokens + elapsed * bucket.refillRate,
    );
    bucket.lastRefill = now;

    // Update limits in case config changed
    bucket.maxTokens = maxTokens;
    bucket.refillRate = refillRate;

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  // ── Audit log ────────────────────────────────────────────────────

  private recordAudit(
    provider: string,
    method: string,
    path: string,
    statusCode: number,
    startTime: number,
  ): void {
    if (this.auditLog.length >= MAX_AUDIT_ENTRIES) {
      this.auditLog.shift();
    }
    this.auditLog.push({
      timestamp: Date.now(),
      provider,
      method,
      path,
      statusCode,
      latencyMs: Date.now() - startTime,
    });
  }
}
