import * as http from "node:http";
import * as https from "node:https";
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

/** Set of provider names that have proxy routes. */
export const PROXY_PROVIDERS = new Set(Object.keys(PROVIDER_ROUTES));

/** Headers that must never be forwarded from the client. */
const STRIPPED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
]);

const MAX_AUDIT_ENTRIES = 1000;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

// ─── Service ─────────────────────────────────────────────────────────

export class CredentialProxyService implements vscode.Disposable {
  private static instance: CredentialProxyService | undefined;
  private readonly logger: Logger;
  private server: http.Server | undefined;
  private port = 0;
  private disposed = false;
  private secretStorage: SecretStorageService | undefined;
  private readonly rateBuckets = new Map<string, TokenBucket>();
  private configWatcher: vscode.Disposable | undefined;
  private cachedRateLimits: Record<string, number> | undefined;

  // Ring buffer for audit log — O(1) writes
  private readonly auditBuffer: (ProxyAuditEntry | undefined)[] = new Array(
    MAX_AUDIT_ENTRIES,
  ).fill(undefined);
  private auditHead = 0;
  private auditCount = 0;

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

  /** For tests that need a truly fresh instance. */
  public static resetForTesting(): void {
    CredentialProxyService.instance?.dispose();
    CredentialProxyService.instance = undefined;
  }

  /** Start the proxy server. Resolves once listening. */
  public async start(secretStorage: SecretStorageService): Promise<void> {
    if (this.disposed) {
      this.disposed = false;
    }
    if (this.server) return; // already running
    this.secretStorage = secretStorage;

    // Cache rate limit config and listen for changes
    this.refreshConfigCache();
    this.configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codebuddy.credentialProxy.rateLimits")) {
        this.refreshConfigCache();
        this.rateBuckets.clear();
        this.logger.info("Rate limit config updated — buckets reset");
      }
    });

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

  /** Check whether a provider name has a proxy route. */
  public static hasRoute(provider: string): boolean {
    return provider in PROVIDER_ROUTES;
  }

  /** Build the proxy base URL for a given provider. */
  public getProxyUrl(provider: string): string {
    return `http://127.0.0.1:${this.port}/${provider}`;
  }

  /** Get the audit log (defensive frozen copy). */
  public getAuditLog(): readonly ProxyAuditEntry[] {
    const result: ProxyAuditEntry[] = [];
    const start = this.auditCount < MAX_AUDIT_ENTRIES ? 0 : this.auditHead;
    for (let i = 0; i < this.auditCount; i++) {
      const entry = this.auditBuffer[(start + i) % MAX_AUDIT_ENTRIES];
      if (entry) result.push({ ...entry });
    }
    return Object.freeze(result);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.configWatcher?.dispose();
    this.configWatcher = undefined;

    if (this.server) {
      this.server.close(() => {
        this.logger.info("Credential proxy stopped — all connections drained");
      });
      this.server = undefined;
      this.port = 0;
    }
    // Do NOT null instance — callers should check isRunning()
  }

  // ── Config cache ─────────────────────────────────────────────────

  private refreshConfigCache(): void {
    this.cachedRateLimits = vscode.workspace
      .getConfiguration("codebuddy.credentialProxy")
      .get<Record<string, number>>("rateLimits");
  }

  // ── Request handling ─────────────────────────────────────────────

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const startTime = Date.now();
    const reqUrl = req.url ?? "/";

    // Handle incoming request errors to prevent unhandled exceptions
    req.on("error", (err) => {
      this.logger.warn(`Incoming request error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Client connection error" }));
      }
    });

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

    // Rate limiting (uses cached config)
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

    // Build upstream URL — guard against malformed paths
    const targetUrl = this.buildTargetUrl(remainingPath, route.target);
    if (!targetUrl) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request path" }));
      this.recordAudit(
        provider,
        req.method ?? "?",
        remainingPath,
        400,
        startTime,
      );
      return;
    }

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

    // Pipe request body with size limit enforcement
    this.pipeWithLimit(req, proxyReq, res, provider, remainingPath, startTime);
  }

  // ── URL construction ─────────────────────────────────────────────

  private buildTargetUrl(remainingPath: string, target: string): URL | null {
    try {
      const safePath = remainingPath
        .replace(/\0/g, "") // strip null bytes
        .split("#")[0]; // strip fragments
      return new URL(safePath, target);
    } catch {
      return null;
    }
  }

  // ── Body piping with size limit ──────────────────────────────────

  private pipeWithLimit(
    req: http.IncomingMessage,
    proxyReq: http.ClientRequest,
    res: http.ServerResponse,
    provider: string,
    remainingPath: string,
    startTime: number,
  ): void {
    let received = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES && !aborted) {
        aborted = true;
        req.destroy();
        proxyReq.destroy();
        if (!res.headersSent) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
        }
        this.recordAudit(
          provider,
          req.method ?? "?",
          remainingPath,
          413,
          startTime,
        );
      }
    });

    // Pipe with end:false — we handle end via the aborted guard
    req.pipe(proxyReq, { end: false });
    req.on("end", () => {
      if (!aborted) proxyReq.end();
    });
  }

  // ── Rate limiting (token bucket, cached config) ──────────────────

  private checkRateLimit(provider: string): boolean {
    const limits = this.cachedRateLimits;
    const maxRpm = limits?.[provider] ?? 60;
    const refillRate = maxRpm / 60_000;

    let bucket = this.rateBuckets.get(provider);
    if (!bucket) {
      bucket = {
        tokens: maxRpm,
        lastRefill: Date.now(),
        maxTokens: maxRpm,
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

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  // ── Audit log (ring buffer — O(1) writes) ────────────────────────

  private recordAudit(
    provider: string,
    method: string,
    path: string,
    statusCode: number,
    startTime: number,
  ): void {
    const endTime = Date.now();
    this.auditBuffer[this.auditHead] = {
      timestamp: startTime,
      provider,
      method,
      path,
      statusCode,
      latencyMs: endTime - startTime,
    };
    this.auditHead = (this.auditHead + 1) % MAX_AUDIT_ENTRIES;
    if (this.auditCount < MAX_AUDIT_ENTRIES) this.auditCount++;
  }
}
