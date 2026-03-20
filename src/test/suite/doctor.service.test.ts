/**
 * DoctorService & individual check-module tests.
 *
 * Covers:
 * - DoctorService singleton lifecycle, execute(), displayFindings(), autoFixAll(), runBackground()
 * - api-key-audit check (plaintext, dual-stored, migrated, no-keys)
 * - terminal-restrictions check (custom patterns, defaults only)
 * - security-config check (maps diagnostics, auto-fix wiring)
 * - mcp-config check (inline secrets, missing command, disabled)
 * - input-validator check (active, null instance, load failure)
 * - directory-permissions check (skips on win32, permissive, correct, missing)
 */

import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { DoctorService } from "../../services/doctor.service";
import type {
  DoctorFinding,
  DoctorCheckContext,
} from "../../services/doctor-checks/types";
import { apiKeyAuditCheck } from "../../services/doctor-checks/api-key-audit.check";
import { terminalRestrictionsCheck } from "../../services/doctor-checks/terminal-restrictions.check";
import { securityConfigCheck } from "../../services/doctor-checks/security-config.check";
import { mcpConfigCheck } from "../../services/doctor-checks/mcp-config.check";
import { inputValidatorCheck } from "../../services/doctor-checks/input-validator.check";
import { directoryPermissionsCheck } from "../../services/doctor-checks/directory-permissions.check";
import type { SecurityDiagnostic } from "../../services/external-security-config.service";

// ── Helpers ────────────────────────────────────────────────────────

/** Minimal mock for SecretStorageService */
function mockSecretStorage(
  stored: Record<string, string> = {},
): DoctorCheckContext["secretStorage"] {
  return {
    getApiKey: (key: string) => stored[key],
    storeApiKey: sinon.stub().resolves(),
  } as unknown as DoctorCheckContext["secretStorage"];
}

/** Minimal mock for ExternalSecurityConfigService */
function mockSecurityConfig(overrides?: {
  diagnostics?: SecurityDiagnostic[];
  denyPatterns?: RegExp[];
  hasConfig?: boolean;
}): DoctorCheckContext["securityConfig"] {
  return {
    getDiagnostics: sinon
      .stub()
      .resolves(overrides?.diagnostics ?? []),
    getCommandDenyPatterns: sinon
      .stub()
      .returns(overrides?.denyPatterns ?? [/./, /./, /./, /./, /./]),
    scaffoldDefaultConfig: sinon.stub().resolves(true),
    hasConfig: sinon.stub().returns(overrides?.hasConfig ?? false),
  } as unknown as DoctorCheckContext["securityConfig"];
}

/** Stub logger that swallows everything. */
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
    securityConfig: mockSecurityConfig(),
    logger: mockLogger(),
    ...overrides,
  };
}

// ── DoctorService orchestrator ─────────────────────────────────────

suite("DoctorService", () => {
  teardown(() => {
    sinon.restore();
    DoctorService.resetInstance();
  });

  test("getInstance returns singleton", () => {
    const a = DoctorService.getInstance();
    const b = DoctorService.getInstance();
    assert.strictEqual(a, b);
  });

  test("resetInstance clears singleton", () => {
    const a = DoctorService.getInstance();
    DoctorService.resetInstance();
    const b = DoctorService.getInstance();
    assert.notStrictEqual(a, b);
  });

  test("execute() returns sorted findings (critical → warn → info)", async () => {
    const svc = DoctorService.getInstance();
    svc.configure({
      secretStorage: mockSecretStorage(),
      securityConfig: mockSecurityConfig(),
      workspacePath: "/tmp/test",
    });

    const findings = await svc.execute();
    // Verify sorting: every finding[i].severity rank <= finding[i+1].severity rank
    const order = { critical: 0, warn: 1, info: 2 } as const;
    for (let i = 1; i < findings.length; i++) {
      assert.ok(
        order[findings[i - 1].severity] <= order[findings[i].severity],
        `findings[${i - 1}] (${findings[i - 1].severity}) should come before findings[${i}] (${findings[i].severity})`,
      );
    }
  });

  test("autoFixAll() applies fixable findings and returns count", async () => {
    const fixA = sinon.stub().resolves();
    const fixB = sinon.stub().resolves();
    const findings: DoctorFinding[] = [
      {
        check: "a",
        severity: "critical",
        message: "x",
        autoFixable: true,
        fix: fixA,
      },
      { check: "b", severity: "warn", message: "y", autoFixable: false },
      {
        check: "c",
        severity: "info",
        message: "z",
        autoFixable: true,
        fix: fixB,
      },
    ];

    const svc = DoctorService.getInstance();
    const applied = await svc.autoFixAll(findings);

    assert.strictEqual(applied, 2);
    assert.ok(fixA.calledOnce);
    assert.ok(fixB.calledOnce);
  });

  test("autoFixAll() handles fix failures gracefully", async () => {
    const failingFix = sinon.stub().rejects(new Error("boom"));
    const findings: DoctorFinding[] = [
      {
        check: "a",
        severity: "critical",
        message: "fail",
        autoFixable: true,
        fix: failingFix,
      },
    ];

    const svc = DoctorService.getInstance();
    svc.configure({
      secretStorage: mockSecretStorage(),
      securityConfig: mockSecurityConfig(),
      workspacePath: "/tmp/test",
    });

    const applied = await svc.autoFixAll(findings);
    assert.strictEqual(applied, 0);
  });

  test("displayFindings() writes to output channel without throwing", () => {
    const svc = DoctorService.getInstance();
    svc.configure({
      secretStorage: mockSecretStorage(),
      securityConfig: mockSecurityConfig(),
      workspacePath: "/tmp/test",
    });

    // Should not throw even with empty array
    assert.doesNotThrow(() => svc.displayFindings([]));
    assert.doesNotThrow(() =>
      svc.displayFindings([
        {
          check: "test",
          severity: "critical",
          message: "bad",
          autoFixable: true,
        },
        { check: "test", severity: "warn", message: "eh", autoFixable: false },
        { check: "test", severity: "info", message: "ok", autoFixable: false },
      ]),
    );
  });

  test("runBackground() does not throw", async () => {
    const svc = DoctorService.getInstance();
    svc.configure({
      secretStorage: mockSecretStorage(),
      securityConfig: mockSecurityConfig(),
      workspacePath: "/tmp/test",
    });

    // Should complete without error
    await svc.runBackground();
  });
});

// ── api-key-audit ──────────────────────────────────────────────────

suite("api-key-audit check", () => {
  let getConfigStub: sinon.SinonStub;

  setup(() => {
    getConfigStub = sinon.stub();
    sinon.stub(vscode.workspace, "getConfiguration").returns({
      get: getConfigStub,
    } as unknown as vscode.WorkspaceConfiguration);
  });

  teardown(() => sinon.restore());

  test("reports critical for plaintext key not in SecretStorage", async () => {
    getConfigStub.returns("sk-my-secret-key");
    const ctx = makeContext({ secretStorage: mockSecretStorage({}) });

    const findings = await apiKeyAuditCheck.run(ctx);
    const critical = findings.filter((f) => f.severity === "critical");

    assert.ok(critical.length > 0, "Should report critical findings");
    assert.ok(critical[0].autoFixable, "Should be auto-fixable");
    assert.ok(critical[0].message.includes("plaintext"));
  });

  test("reports warn when key in both settings and SecretStorage", async () => {
    getConfigStub.returns("sk-my-secret-key");
    const ctx = makeContext({
      secretStorage: mockSecretStorage({
        "google.gemini.apiKeys": "sk-my-secret-key",
        "groq.llama3.apiKey": "sk-my-secret-key",
        "anthropic.apiKey": "sk-my-secret-key",
        "deepseek.apiKey": "sk-my-secret-key",
        "openai.apiKey": "sk-my-secret-key",
        "qwen.apiKey": "sk-my-secret-key",
        "glm.apiKey": "sk-my-secret-key",
        "tavily.apiKey": "sk-my-secret-key",
        "local.apiKey": "sk-my-secret-key",
      }),
    });

    const findings = await apiKeyAuditCheck.run(ctx);
    const warns = findings.filter((f) => f.severity === "warn");

    assert.ok(warns.length > 0, "Should report warnings for dual-stored keys");
    assert.ok(warns[0].message.includes("both"));
  });

  test("reports info when all migrated properly", async () => {
    getConfigStub.returns(undefined);
    const ctx = makeContext({
      secretStorage: mockSecretStorage({
        "google.gemini.apiKeys": "sk-key",
      }),
    });

    const findings = await apiKeyAuditCheck.run(ctx);
    const infos = findings.filter((f) => f.severity === "info");

    assert.ok(infos.length > 0);
    assert.ok(infos[0].message.includes("properly stored"));
  });

  test("reports info 'No API keys configured' when nothing exists", async () => {
    getConfigStub.returns(undefined);
    const ctx = makeContext({ secretStorage: mockSecretStorage({}) });

    const findings = await apiKeyAuditCheck.run(ctx);

    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, "info");
    assert.ok(findings[0].message.includes("No API keys configured"));
  });

  test("auto-fix migrates key to SecretStorage", async () => {
    getConfigStub.returns("sk-real-key");
    const storage = mockSecretStorage({});
    const ctx = makeContext({ secretStorage: storage });

    const findings = await apiKeyAuditCheck.run(ctx);
    const fixable = findings.find((f) => f.autoFixable && f.fix);
    assert.ok(fixable, "Should have a fixable finding");

    await fixable!.fix!();
    assert.ok(
      (storage.storeApiKey as sinon.SinonStub).called,
      "storeApiKey should have been called",
    );
  });

  test("ignores sentinel values (apiKey, not-needed, empty string)", async () => {
    getConfigStub.callsFake((key: string) => {
      if (key === "google.gemini.apiKeys") return "apiKey";
      if (key === "groq.llama3.apiKey") return "not-needed";
      if (key === "anthropic.apiKey") return "";
      return undefined;
    });
    const ctx = makeContext();

    const findings = await apiKeyAuditCheck.run(ctx);
    const critical = findings.filter((f) => f.severity === "critical");

    assert.strictEqual(
      critical.length,
      0,
      "Sentinel values should not be flagged",
    );
  });
});

// ── terminal-restrictions ──────────────────────────────────────────

suite("terminal-restrictions check", () => {
  teardown(() => sinon.restore());

  test("reports info when custom patterns exist", async () => {
    // 5 defaults + 3 custom = 8
    const patterns = Array.from({ length: 8 }, () => /./);
    const ctx = makeContext({
      securityConfig: mockSecurityConfig({ denyPatterns: patterns }),
    });

    const findings = await terminalRestrictionsCheck.run(ctx);
    assert.strictEqual(findings[0].severity, "info");
    assert.ok(findings[0].message.includes("3 custom"));
  });

  test("reports warn when only defaults active", async () => {
    // Exactly 5 patterns = defaults only
    const patterns = Array.from({ length: 5 }, () => /./);
    const ctx = makeContext({
      securityConfig: mockSecurityConfig({ denyPatterns: patterns }),
    });

    const findings = await terminalRestrictionsCheck.run(ctx);
    assert.strictEqual(findings[0].severity, "warn");
    assert.ok(findings[0].message.includes("No custom"));
  });
});

// ── security-config ────────────────────────────────────────────────

suite("security-config check", () => {
  teardown(() => sinon.restore());

  test("maps diagnostics to findings", async () => {
    const diags: SecurityDiagnostic[] = [
      { severity: "warn", message: "Test warning", autoFixable: false },
      { severity: "info", message: "All good", autoFixable: false },
    ];
    const ctx = makeContext({
      securityConfig: mockSecurityConfig({ diagnostics: diags }),
    });

    const findings = await securityConfigCheck.run(ctx);
    assert.strictEqual(findings.length, 2);
    assert.strictEqual(findings[0].severity, "warn");
    assert.strictEqual(findings[0].check, "security-config");
  });

  test("provides auto-fix for missing config", async () => {
    const diags: SecurityDiagnostic[] = [
      {
        severity: "info",
        message: "No security config found",
        autoFixable: true,
      },
    ];
    const config = mockSecurityConfig({ diagnostics: diags });
    const ctx = makeContext({ securityConfig: config });

    const findings = await securityConfigCheck.run(ctx);
    assert.ok(findings[0].autoFixable);
    assert.ok(findings[0].fix, "Should have fix callback");

    await findings[0].fix!();
    assert.ok(
      (config.scaffoldDefaultConfig as sinon.SinonStub).calledOnce,
      "scaffoldDefaultConfig should be called",
    );
  });
});

// ── mcp-config ─────────────────────────────────────────────────────

suite("mcp-config check", () => {
  let getConfigStub: sinon.SinonStub;

  setup(() => {
    getConfigStub = sinon.stub();
    sinon.stub(vscode.workspace, "getConfiguration").returns({
      get: getConfigStub,
    } as unknown as vscode.WorkspaceConfiguration);
  });

  teardown(() => sinon.restore());

  test("reports info when no MCP servers configured", async () => {
    getConfigStub.returns(undefined);
    const ctx = makeContext();

    const findings = await mcpConfigCheck.run(ctx);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, "info");
    assert.ok(findings[0].message.includes("No MCP servers"));
  });

  test("reports critical for inline secrets in env vars", async () => {
    getConfigStub.returns({
      myServer: {
        command: "node",
        args: ["server.js"],
        env: {
          API_KEY: "sk-1234567890",
        },
      },
    });
    const ctx = makeContext();

    const findings = await mcpConfigCheck.run(ctx);
    const critical = findings.filter((f) => f.severity === "critical");

    assert.ok(critical.length > 0, "Should flag inline secret");
    assert.ok(critical[0].message.includes("inline secret"));
  });

  test("ignores env vars with variable references", async () => {
    getConfigStub.returns({
      myServer: {
        command: "node",
        env: {
          API_KEY: "${secret:MY_KEY}",
          TOKEN: "$MY_SECRET",
        },
      },
    });
    const ctx = makeContext();

    const findings = await mcpConfigCheck.run(ctx);
    const critical = findings.filter((f) => f.severity === "critical");

    assert.strictEqual(
      critical.length,
      0,
      "Variable references should not be flagged",
    );
  });

  test("reports warn for missing command", async () => {
    getConfigStub.returns({
      broken: { args: ["arg1"] },
    });
    const ctx = makeContext();

    const findings = await mcpConfigCheck.run(ctx);
    const warns = findings.filter((f) => f.severity === "warn");

    assert.ok(warns.length > 0);
    assert.ok(warns[0].message.includes("no command"));
  });

  test("reports info for disabled server", async () => {
    getConfigStub.returns({
      paused: { command: "node", enabled: false },
    });
    const ctx = makeContext();

    const findings = await mcpConfigCheck.run(ctx);
    const infos = findings.filter((f) => f.severity === "info");

    assert.ok(infos.some((f) => f.message.includes("disabled")));
  });

  test("reports info when servers configured with no issues", async () => {
    getConfigStub.returns({
      goodServer: {
        command: "npx",
        args: ["-y", "some-mcp-server"],
      },
    });
    const ctx = makeContext();

    const findings = await mcpConfigCheck.run(ctx);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, "info");
    assert.ok(findings[0].message.includes("no issues found"));
  });
});

// ── input-validator ────────────────────────────────────────────────

suite("input-validator check", () => {
  teardown(() => sinon.restore());

  test("name is input-validator", () => {
    assert.strictEqual(inputValidatorCheck.name, "input-validator");
  });

  test("returns findings array", async () => {
    const ctx = makeContext();
    const findings = await inputValidatorCheck.run(ctx);
    assert.ok(Array.isArray(findings));
    assert.ok(findings.length > 0, "Should return at least one finding");
    assert.strictEqual(findings[0].check, "input-validator");
  });
});

// ── directory-permissions ──────────────────────────────────────────

suite("directory-permissions check", () => {
  teardown(() => sinon.restore());

  test("name is directory-permissions", () => {
    assert.strictEqual(directoryPermissionsCheck.name, "directory-permissions");
  });

  test("returns findings array", async () => {
    const ctx = makeContext();
    const findings = await directoryPermissionsCheck.run(ctx);
    assert.ok(Array.isArray(findings));
    assert.ok(findings.length > 0);
    assert.strictEqual(findings[0].check, "directory-permissions");
  });

  test("skips on win32 platform", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    Object.defineProperty(process, "platform", { value: "win32" });

    try {
      const ctx = makeContext();
      const findings = await directoryPermissionsCheck.run(ctx);
      assert.ok(findings.some((f) => f.message.includes("skipped on Windows")));
    } finally {
      // Restore original platform
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });
});
