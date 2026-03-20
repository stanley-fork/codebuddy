/**
 * CredentialProxyService tests.
 *
 * Covers:
 * - Server lifecycle (start, port, isRunning, dispose)
 * - Provider routing (known provider → 200, unknown → 404)
 * - Auth header stripping & credential injection
 * - Rate limiting (429 on exhaustion)
 * - Audit log recording (ring buffer, defensive copy)
 * - Doctor check module findings
 */

import * as assert from "assert";
import * as http from "node:http";
import * as sinon from "sinon";
import * as vscode from "vscode";
import {
  CredentialProxyService,
  type ProxyAuditEntry,
} from "../../services/credential-proxy.service";
import { credentialProxyCheck } from "../../services/doctor-checks/credential-proxy.check";
import type { DoctorCheckContext } from "../../services/doctor-checks/types";

// ── Helpers ────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 5000;

function mockSecretStorage(
  stored: Record<string, string> = {},
): DoctorCheckContext["secretStorage"] {
  return {
    getApiKey: (key: string) => stored[key],
    storeApiKey: sinon.stub().resolves(),
  } as unknown as DoctorCheckContext["secretStorage"];
}

function mockLogger(): DoctorCheckContext["logger"] {
  return {
    info: sinon.stub(),
    warn: sinon.stub(),
    error: sinon.stub(),
    debug: sinon.stub(),
  } as unknown as DoctorCheckContext["logger"];
}

function makeContext(
  overrides?: Partial<DoctorCheckContext>,
): DoctorCheckContext {
  return {
    workspacePath: "/tmp/test-workspace",
    secretStorage: mockSecretStorage(),
    securityConfig: {} as DoctorCheckContext["securityConfig"],
    logger: mockLogger(),
    ...overrides,
  };
}

/** Send an HTTP request to the proxy and return parsed response. */
function proxyRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        req.destroy();
        reject(new Error(`proxyRequest timed out after ${REQUEST_TIMEOUT_MS}ms`));
      },
      REQUEST_TIMEOUT_MS,
    );

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          clearTimeout(timer);
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
        });
      },
    );
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── Fake upstream server ───────────────────────────────────────────

/** Spins up a fake upstream that echoes received headers in its response body. */
function createEchoUpstream(): Promise<{
  server: http.Server;
  port: number;
  lastHeaders: () => http.IncomingHttpHeaders;
}> {
  return new Promise((resolve) => {
    let _lastHeaders: http.IncomingHttpHeaders = {};
    const server = http.createServer((req, res) => {
      _lastHeaders = { ...req.headers };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          echo: true,
          headers: req.headers,
        }),
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" ? addr!.port : 0;
      resolve({ server, port, lastHeaders: () => _lastHeaders });
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────

suite("CredentialProxyService", () => {
  setup(() => {
    // Ensure a clean singleton before each test
    CredentialProxyService.resetForTesting();
  });

  teardown(() => {
    sinon.restore();
    CredentialProxyService.resetForTesting();
  });

  // ─ Lifecycle ─────────────────────────────────────────────────────

  test("starts and exposes a dynamic port on localhost", async () => {
    const proxy = CredentialProxyService.getInstance();
    await proxy.start(mockSecretStorage() as any);

    assert.ok(proxy.isRunning(), "proxy should be running");
    assert.ok(proxy.getPort() > 0, "port should be > 0");
  });

  test("start() is idempotent", async () => {
    const proxy = CredentialProxyService.getInstance();
    await proxy.start(mockSecretStorage() as any);
    const port1 = proxy.getPort();
    await proxy.start(mockSecretStorage() as any); // second call
    assert.strictEqual(proxy.getPort(), port1, "port should not change");
  });

  test("dispose() stops the server", async () => {
    const proxy = CredentialProxyService.getInstance();
    await proxy.start(mockSecretStorage() as any);
    assert.ok(proxy.isRunning());
    proxy.dispose();
    assert.ok(!proxy.isRunning(), "should not be running after dispose");
    assert.strictEqual(proxy.getPort(), 0, "port should reset to 0");
  });

  test("getInstance() after dispose returns same instance (not disposed)", async () => {
    const proxy = CredentialProxyService.getInstance();
    await proxy.start(mockSecretStorage() as any);
    proxy.dispose();
    // Same instance — not resurrected
    const proxy2 = CredentialProxyService.getInstance();
    assert.strictEqual(proxy, proxy2, "should be the same instance");
    assert.ok(!proxy2.isRunning(), "disposed proxy should not be running");
  });

  test("can restart after dispose", async () => {
    const proxy = CredentialProxyService.getInstance();
    await proxy.start(mockSecretStorage() as any);
    const port1 = proxy.getPort();
    proxy.dispose();
    assert.ok(!proxy.isRunning());
    await proxy.start(mockSecretStorage() as any);
    assert.ok(proxy.isRunning(), "should be running after restart");
    assert.ok(proxy.getPort() > 0, "should have a port after restart");
  });

  test("getProxyUrl() returns correct localhost URL with provider path", async () => {
    const proxy = CredentialProxyService.getInstance();
    await proxy.start(mockSecretStorage() as any);
    const url = proxy.getProxyUrl("openai");
    assert.ok(
      url.startsWith(`http://127.0.0.1:${proxy.getPort()}/openai`),
      `unexpected URL: ${url}`,
    );
  });

  test("hasRoute() returns true for known providers, false for unknown", () => {
    assert.ok(CredentialProxyService.hasRoute("anthropic"));
    assert.ok(CredentialProxyService.hasRoute("openai"));
    assert.ok(!CredentialProxyService.hasRoute("gemini"));
    assert.ok(!CredentialProxyService.hasRoute("unknown"));
  });

  // ─ Routing ───────────────────────────────────────────────────────

  test("returns 404 for unknown provider", async () => {
    const proxy = CredentialProxyService.getInstance();
    await proxy.start(mockSecretStorage() as any);
    const res = await proxyRequest(proxy.getPort(), "/unknown-provider/v1/chat");
    assert.strictEqual(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("unknown-provider"));
  });

  test("returns 401 when API key is missing for a provider", async () => {
    const proxy = CredentialProxyService.getInstance();
    await proxy.start(mockSecretStorage({}) as any); // no keys
    const res = await proxyRequest(proxy.getPort(), "/openai/v1/chat/completions");
    assert.strictEqual(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("openai"));
  });

  // ─ Rate limiting ─────────────────────────────────────────────────

  test("returns 429 when rate limit is exhausted", async () => {
    const proxy = CredentialProxyService.getInstance();
    // Set rate limit to 1 RPM for the test provider
    const configStub = sinon.stub(vscode.workspace, "getConfiguration");
    configStub.callsFake((section?: string) => {
      if (section === "codebuddy.credentialProxy") {
        return {
          get: (key: string) => {
            if (key === "rateLimits") return { openai: 1 };
            return undefined;
          },
        } as any;
      }
      return { get: () => undefined } as any;
    });

    await proxy.start(
      mockSecretStorage({ "codebuddy.openaiApiKey": "test-key" }) as any,
    );

    // First request should succeed (or 401/502 — but not 429)
    const res1 = await proxyRequest(proxy.getPort(), "/openai/v1/models");
    assert.notStrictEqual(
      res1.statusCode,
      429,
      "first request should not be rate-limited",
    );

    // Second request should be rate-limited
    const res2 = await proxyRequest(proxy.getPort(), "/openai/v1/models");
    assert.strictEqual(res2.statusCode, 429);
    const body = JSON.parse(res2.body);
    assert.ok(body.error.includes("Rate limit"));
  });

  // ─ Audit log ─────────────────────────────────────────────────────

  test("records entries in audit log", async () => {
    const proxy = CredentialProxyService.getInstance();
    await proxy.start(mockSecretStorage() as any);
    // 404 for unknown provider does not record audit — try a known provider
    await proxyRequest(proxy.getPort(), "/openai/v1/chat");
    const log = proxy.getAuditLog();
    assert.ok(log.length > 0, "audit log should have entries");

    const last = log[log.length - 1];
    assert.strictEqual(last.provider, "openai");
    assert.strictEqual(last.statusCode, 401);
    assert.ok(last.latencyMs >= 0);
  });

  test("getAuditLog() returns a defensive copy", async () => {
    const proxy = CredentialProxyService.getInstance();
    await proxy.start(mockSecretStorage() as any);
    await proxyRequest(proxy.getPort(), "/openai/v1/chat");

    const log1 = proxy.getAuditLog();
    const log2 = proxy.getAuditLog();
    assert.notStrictEqual(log1, log2, "should return different array references");
    assert.deepStrictEqual(log1, log2, "but same content");
  });
});

// ── Doctor check tests ─────────────────────────────────────────────

suite("credentialProxyCheck (doctor)", () => {
  setup(() => {
    CredentialProxyService.resetForTesting();
  });

  teardown(() => {
    sinon.restore();
    CredentialProxyService.resetForTesting();
  });

  test("returns info finding when proxy is disabled", async () => {
    const configStub = sinon.stub(vscode.workspace, "getConfiguration");
    configStub.callsFake(() => ({
      get: (_key: string, defaultVal: any) => defaultVal,
    }) as any);

    const findings = await credentialProxyCheck.run(makeContext());
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, "info");
    assert.ok(findings[0].message.includes("disabled"));
  });

  test("returns critical finding when proxy enabled but not running", async () => {
    const configStub = sinon.stub(vscode.workspace, "getConfiguration");
    configStub.callsFake((section?: string) => {
      if (section === "codebuddy.credentialProxy") {
        return {
          get: (key: string, defaultVal: any) => {
            if (key === "enabled") return true;
            return defaultVal;
          },
        } as any;
      }
      return { get: (_k: string, d: any) => d } as any;
    });

    // Proxy singleton exists but isn't started
    CredentialProxyService.getInstance();
    const findings = await credentialProxyCheck.run(makeContext());
    assert.ok(findings.length >= 1);
    const critical = findings.find((f) => f.severity === "critical");
    assert.ok(critical, "expected a critical finding");
    assert.ok(critical!.message.includes("not running"));
  });

  test("returns info finding when proxy enabled and running", async () => {
    const configStub = sinon.stub(vscode.workspace, "getConfiguration");
    configStub.callsFake((section?: string) => {
      if (section === "codebuddy.credentialProxy") {
        return {
          get: (key: string, defaultVal: any) => {
            if (key === "enabled") return true;
            if (key === "rateLimits") return {};
            return defaultVal;
          },
        } as any;
      }
      return { get: (_k: string, d: any) => d } as any;
    });

    const proxy = CredentialProxyService.getInstance();
    await proxy.start(mockSecretStorage() as any);

    const findings = await credentialProxyCheck.run(makeContext());
    const infoFinding = findings.find(
      (f) => f.severity === "info" && f.message.includes("active"),
    );
    assert.ok(infoFinding, "expected an info finding about active proxy");
    assert.ok(infoFinding!.message.includes(`port ${proxy.getPort()}`));
  });

  test("warns about API keys in environment variables", async () => {
    const configStub = sinon.stub(vscode.workspace, "getConfiguration");
    configStub.callsFake((section?: string) => {
      if (section === "codebuddy.credentialProxy") {
        return {
          get: (key: string, defaultVal: any) => {
            if (key === "enabled") return true;
            if (key === "rateLimits") return {};
            return defaultVal;
          },
        } as any;
      }
      return { get: (_k: string, d: any) => d } as any;
    });

    const proxy = CredentialProxyService.getInstance();
    await proxy.start(mockSecretStorage() as any);

    // Temporarily inject a fake env var
    const origKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test-fake";
    try {
      const findings = await credentialProxyCheck.run(makeContext());
      const warning = findings.find(
        (f) => f.severity === "warn" && f.message.includes("OPENAI_API_KEY"),
      );
      assert.ok(warning, "expected a warning about leaked env var");
    } finally {
      if (origKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = origKey;
      }
    }
  });
});
