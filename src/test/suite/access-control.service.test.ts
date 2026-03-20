/**
 * AccessControlService tests.
 *
 * Covers:
 * - Default mode (open)
 * - Mode-based access (open, allow, deny)
 * - Admin bypass
 * - Unknown user handling
 * - Config loading from access.json
 * - Audit logging
 * - Mode switching + no-fire-when-unchanged
 * - Diagnostics reporting
 * - Doctor check module integration
 */

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as sinon from "sinon";
import * as vscode from "vscode";
import {
  AccessControlService,
  type AccessControlMode,
} from "../../services/access-control.service";
import { accessControlCheck } from "../../services/doctor-checks/access-control.check";
import type { DoctorCheckContext } from "../../services/doctor-checks/types";

// ── Helpers ────────────────────────────────────────────────────────

let tmpDir: string;

function setupTmpWorkspace(
  config?: Record<string, unknown>,
): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "access-ctrl-test-"));
  if (config) {
    const dir = path.join(tmpDir, ".codebuddy");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "access.json"),
      JSON.stringify(config),
    );
  }
  return tmpDir;
}

function cleanupTmpWorkspace(): void {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function mockContext(): DoctorCheckContext {
  return {
    workspacePath: tmpDir ?? "/tmp/test",
    secretStorage: {} as DoctorCheckContext["secretStorage"],
    securityConfig: {} as DoctorCheckContext["securityConfig"],
    logger: {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
      debug: sinon.stub(),
    } as unknown as DoctorCheckContext["logger"],
  };
}

// ── Tests ──────────────────────────────────────────────────────────

suite("AccessControlService", () => {
  let configStub: sinon.SinonStub;
  let authStub: sinon.SinonStub;

  setup(() => {
    process.env.NODE_ENV = "test";
    AccessControlService._resetForTesting();
    // Stub VS Code config to return "open" by default
    configStub = sinon
      .stub(vscode.workspace, "getConfiguration")
      .returns({
        get: (_key: string, defaultVal?: unknown) => defaultVal,
      } as unknown as vscode.WorkspaceConfiguration);
    // Stub GitHub auth to return no session
    authStub = sinon
      .stub(vscode.authentication, "getSession")
      .resolves(undefined);
  });

  teardown(() => {
    AccessControlService._resetForTesting();
    configStub?.restore();
    authStub?.restore();
    cleanupTmpWorkspace();
  });

  // ── Default Behaviour ────────────────────────────────────────────

  test("defaults to open mode", async () => {
    const svc = AccessControlService.getInstance();
    await svc.initialize();
    assert.strictEqual(svc.getMode(), "open");
  });

  test("open mode allows everyone", async () => {
    const svc = AccessControlService.getInstance();
    await svc.initialize();
    assert.strictEqual(svc.isCurrentUserAllowed(), true);
    assert.strictEqual(svc.isUserAllowed("anyone@example.com"), true);
    assert.strictEqual(svc.isUserAllowed(undefined), true);
  });

  // ── Allow Mode ───────────────────────────────────────────────────

  test("allow mode blocks unlisted users", async () => {
    const ws = setupTmpWorkspace({
      mode: "allow",
      users: ["alice@example.com", "bob@example.com"],
    });
    const svc = AccessControlService.getInstance();
    await svc.initialize(ws);

    assert.strictEqual(svc.getMode(), "allow");
    assert.strictEqual(svc.isUserAllowed("alice@example.com"), true);
    assert.strictEqual(svc.isUserAllowed("bob@example.com"), true);
    assert.strictEqual(svc.isUserAllowed("eve@example.com"), false);
  });

  test("allow mode is case-insensitive", async () => {
    const ws = setupTmpWorkspace({
      mode: "allow",
      users: ["Alice@Example.com"],
    });
    const svc = AccessControlService.getInstance();
    await svc.initialize(ws);

    assert.strictEqual(svc.isUserAllowed("alice@example.com"), true);
    assert.strictEqual(svc.isUserAllowed("ALICE@EXAMPLE.COM"), true);
  });

  test("allow mode with unknown user denies for safety", async () => {
    const ws = setupTmpWorkspace({
      mode: "allow",
      users: ["alice@example.com"],
    });
    const svc = AccessControlService.getInstance();
    await svc.initialize(ws);

    assert.strictEqual(svc.isUserAllowed(undefined), false);
  });

  // ── Deny Mode ────────────────────────────────────────────────────

  test("deny mode blocks listed users", async () => {
    const ws = setupTmpWorkspace({
      mode: "deny",
      users: ["eve@example.com"],
    });
    const svc = AccessControlService.getInstance();
    await svc.initialize(ws);

    assert.strictEqual(svc.getMode(), "deny");
    assert.strictEqual(svc.isUserAllowed("alice@example.com"), true);
    assert.strictEqual(svc.isUserAllowed("eve@example.com"), false);
  });

  test("deny mode with unknown user denies for safety", async () => {
    const ws = setupTmpWorkspace({
      mode: "deny",
      users: ["eve@example.com"],
    });
    const svc = AccessControlService.getInstance();
    await svc.initialize(ws);

    assert.strictEqual(svc.isUserAllowed(undefined), false);
  });

  // ── Admin Bypass ─────────────────────────────────────────────────

  test("admins always allowed even in allow mode", async () => {
    const ws = setupTmpWorkspace({
      mode: "allow",
      users: ["alice@example.com"],
      admins: ["admin@example.com"],
    });
    const svc = AccessControlService.getInstance();
    await svc.initialize(ws);

    // admin is NOT in users list but IS in admins
    assert.strictEqual(svc.isUserAllowed("admin@example.com"), true);
    // non-admin, non-user is blocked
    assert.strictEqual(svc.isUserAllowed("eve@example.com"), false);
  });

  test("admins always allowed even in deny mode", async () => {
    const ws = setupTmpWorkspace({
      mode: "deny",
      users: ["admin@example.com"], // even on the deny list
      admins: ["admin@example.com"],
    });
    const svc = AccessControlService.getInstance();
    await svc.initialize(ws);

    // Admin overrides deny list
    assert.strictEqual(svc.isUserAllowed("admin@example.com"), true);
  });

  // ── Audit Log ────────────────────────────────────────────────────

  test("checkAccess records audit entries", async () => {
    const ws = setupTmpWorkspace({
      mode: "allow",
      users: ["alice@example.com"],
    });
    const svc = AccessControlService.getInstance();
    await svc.initialize(ws);

    svc.checkAccess("user-input");
    svc.checkAccess("send-message");

    const log = svc.getAuditLog();
    assert.strictEqual(log.length, 2);
    assert.strictEqual(log[0].action, "user-input");
    assert.strictEqual(log[1].action, "send-message");
  });

  test("getRecentDenied filters denied entries", async () => {
    const ws = setupTmpWorkspace({
      mode: "allow",
      users: [], // nobody allowed
    });
    const svc = AccessControlService.getInstance();
    await svc.initialize(ws);

    svc.checkAccess("action1");
    svc.checkAccess("action2");

    const denied = svc.getRecentDenied();
    assert.strictEqual(denied.length, 2);
    assert.ok(denied.every((e) => !e.allowed));
  });

  // ── Config Parsing ───────────────────────────────────────────────

  test("ignores invalid JSON gracefully", async () => {
    const ws = setupTmpWorkspace();
    const dir = path.join(ws, ".codebuddy");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "access.json"),
      "NOT VALID JSON",
    );

    const svc = AccessControlService.getInstance();
    await svc.initialize(ws);
    assert.strictEqual(svc.getMode(), "open");
  });

  test("ignores unknown mode in config", async () => {
    const ws = setupTmpWorkspace({ mode: "superadmin" });
    const svc = AccessControlService.getInstance();
    await svc.initialize(ws);
    assert.strictEqual(svc.getMode(), "open");
  });

  test("rejects oversized config file gracefully", async () => {
    const ws = setupTmpWorkspace();
    const dir = path.join(ws, ".codebuddy");
    fs.mkdirSync(dir, { recursive: true });
    const bigPayload = JSON.stringify({
      mode: "allow",
      users: Array(5000).fill("x".repeat(100)),
    });
    fs.writeFileSync(path.join(dir, "access.json"), bigPayload);

    const svc = AccessControlService.getInstance();
    await svc.initialize(ws);
    assert.strictEqual(svc.getMode(), "open");
  });

  // ── Mode Switching ───────────────────────────────────────────────

  test("setMode fires onAccessChanged", async () => {
    const svc = AccessControlService.getInstance();
    await svc.initialize();

    let firedMode: AccessControlMode | undefined;
    svc.onAccessChanged((m) => {
      firedMode = m;
    });

    svc.setMode("allow", "command", false);
    assert.strictEqual(svc.getMode(), "allow");
    assert.strictEqual(firedMode, "allow");
  });

  test("setMode does not fire when mode unchanged", async () => {
    const svc = AccessControlService.getInstance();
    await svc.initialize();

    let fireCount = 0;
    svc.onAccessChanged(() => { fireCount++; });

    svc.setMode("open", "command", false); // same as default
    assert.strictEqual(fireCount, 0);
  });

  test("setMode ignores invalid mode", async () => {
    const svc = AccessControlService.getInstance();
    await svc.initialize();
    svc.setMode("nonsense" as AccessControlMode, "command", false);
    assert.strictEqual(svc.getMode(), "open");
  });

  // ── Diagnostics ──────────────────────────────────────────────────

  test("diagnostics report no-config when file missing", async () => {
    const ws = setupTmpWorkspace();
    const svc = AccessControlService.getInstance();
    await svc.initialize(ws);

    const diags = svc.getDiagnostics();
    assert.ok(diags.some((d) => d.code === "no-config"));
  });

  test("diagnostics report config-loaded when file present", async () => {
    const ws = setupTmpWorkspace({ mode: "open" });
    const svc = AccessControlService.getInstance();
    await svc.initialize(ws);

    const diags = svc.getDiagnostics();
    assert.ok(diags.some((d) => d.code === "config-loaded"));
  });

  test("diagnostics flag empty user list in allow mode", async () => {
    const ws = setupTmpWorkspace({ mode: "allow", users: [] });
    const svc = AccessControlService.getInstance();
    await svc.initialize(ws);

    const diags = svc.getDiagnostics();
    assert.ok(diags.some((d) => d.code === "empty-user-list"));
  });

  // ── Doctor Check Module ──────────────────────────────────────────

  test("doctor check returns findings from diagnostics", async () => {
    const ws = setupTmpWorkspace({ mode: "allow", users: [] });
    const svc = AccessControlService.getInstance();
    await svc.initialize(ws);

    const findings = await accessControlCheck.run(mockContext());
    assert.ok(findings.length > 0);
    assert.ok(findings.every((f) => f.check === "access-control"));
  });

  // ── Service Lifecycle ────────────────────────────────────────────

  test("isServiceInitialized returns false before initialize", () => {
    const svc = AccessControlService.getInstance();
    assert.strictEqual(svc.isServiceInitialized(), false);
  });

  test("isServiceInitialized returns true after initialize", async () => {
    const svc = AccessControlService.getInstance();
    await svc.initialize();
    assert.strictEqual(svc.isServiceInitialized(), true);
  });

  test("diagnostics surface config source (VS Code setting)", async () => {
    const ws = setupTmpWorkspace();
    const svc = AccessControlService.getInstance();
    await svc.initialize(ws);

    const diags = svc.getDiagnostics();
    const noConfig = diags.find((d) => d.code === "no-config");
    assert.ok(noConfig);
    assert.ok(noConfig.message.includes("VS Code setting"));
  });

  test("diagnostics surface config source (access.json)", async () => {
    const ws = setupTmpWorkspace({ mode: "allow", users: ["alice@test.com"] });
    const svc = AccessControlService.getInstance();
    await svc.initialize(ws);

    const diags = svc.getDiagnostics();
    const loaded = diags.find((d) => d.code === "config-loaded");
    assert.ok(loaded);
    assert.ok(loaded.message.includes(".codebuddy/access.json"));
    assert.ok(loaded.message.includes("highest priority"));
  });

  test("checkAccess always records audit but throttles logger.warn", async () => {
    const svc = AccessControlService.getInstance();
    await svc.initialize();

    // Rapid-fire calls — all should be audit-logged (logger.warn is throttled, not audit)
    svc.checkAccess("action1");
    svc.checkAccess("action2");
    svc.checkAccess("action3");

    const log = svc.getAuditLog();
    // Every call must produce an audit entry — completeness is non-negotiable
    assert.strictEqual(log.length, 3);
    assert.strictEqual(log[0].action, "action1");
    assert.strictEqual(log[1].action, "action2");
    assert.strictEqual(log[2].action, "action3");
  });
});
