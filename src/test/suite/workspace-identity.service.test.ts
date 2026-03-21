/**
 * WorkspaceIdentityService tests.
 *
 * Covers:
 * - Hash stability (same path → same hash)
 * - Different paths produce different IDs
 * - No-workspace fallback to "agentId"
 * - Agent ID format validation
 * - Global paths are correct
 * - Reset for testing
 * - Path traversal guards (lexical + symlink)
 * - Idempotent initialization
 * - getWorkspaceAgentId facade function
 */

import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import {
  WorkspaceIdentityService,
  getWorkspaceAgentId,
} from "../../services/workspace-identity.service";

/** OS-agnostic temp-based workspace path */
const tmpWs = (...segments: string[]) =>
  path.join(os.tmpdir(), ...segments);

suite("WorkspaceIdentityService", () => {
  teardown(() => {
    WorkspaceIdentityService._resetForTesting();
  });

  test("produces stable hash for same workspace path", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize(tmpWs("my-project"));
    const id1 = svc.getAgentId();

    WorkspaceIdentityService._resetForTesting();

    const svc2 = WorkspaceIdentityService.getInstance();
    svc2.initialize(tmpWs("my-project"));
    const id2 = svc2.getAgentId();

    assert.strictEqual(id1, id2, "Same path should produce the same agent ID");
  });

  test("produces different hashes for different workspace paths", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize(tmpWs("project-a"));
    const idA = svc.getAgentId();

    WorkspaceIdentityService._resetForTesting();

    const svc2 = WorkspaceIdentityService.getInstance();
    svc2.initialize(tmpWs("project-b"));
    const idB = svc2.getAgentId();

    assert.notStrictEqual(
      idA,
      idB,
      "Different paths should produce different agent IDs",
    );
  });

  test("falls back to 'agentId' when no workspace is open", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize(undefined);
    assert.strictEqual(svc.getAgentId(), "agentId");
  });

  test("agent ID format is agentId-<12 hex chars>", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize(tmpWs("workspace"));
    const id = svc.getAgentId();
    assert.match(id, /^agentId-[a-f0-9]{12}$/);
  });

  test("getWorkspaceName returns folder basename", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize(path.join(os.homedir(), "projects", "my-app"));
    assert.strictEqual(svc.getWorkspaceName(), "my-app");
  });

  test("getWorkspaceName returns 'No Workspace' when uninitialised", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize(undefined);
    assert.strictEqual(svc.getWorkspaceName(), "No Workspace");
  });

  test("getWorkspaceHash returns undefined with no workspace", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize(undefined);
    assert.strictEqual(svc.getWorkspaceHash(), undefined);
  });

  test("getWorkspaceHash returns 12-char hex when workspace is set", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize(tmpWs("ws"));
    const hash = svc.getWorkspaceHash();
    assert.ok(hash);
    assert.strictEqual(hash!.length, 12);
    assert.match(hash!, /^[a-f0-9]{12}$/);
  });

  test("global rules path points to ~/.codebuddy/rules.md", () => {
    const expected = path.join(os.homedir(), ".codebuddy", "rules.md");
    assert.strictEqual(
      WorkspaceIdentityService.getGlobalRulesPath(),
      expected,
    );
  });

  test("global dir points to ~/.codebuddy/", () => {
    const expected = path.join(os.homedir(), ".codebuddy");
    assert.strictEqual(WorkspaceIdentityService.getGlobalDir(), expected);
  });

  test("singleton returns the same instance", () => {
    const a = WorkspaceIdentityService.getInstance();
    const b = WorkspaceIdentityService.getInstance();
    assert.strictEqual(a, b);
  });

  test("_resetForTesting clears the singleton", () => {
    const a = WorkspaceIdentityService.getInstance();
    a.initialize(tmpWs("x"));
    WorkspaceIdentityService._resetForTesting();
    const b = WorkspaceIdentityService.getInstance();
    assert.strictEqual(b.getWorkspaceHash(), undefined);
  });

  // ── Idempotent initialization guard ──

  test("second initialize() call is ignored", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize(tmpWs("first"));
    const id1 = svc.getAgentId();
    // Second call should be a no-op
    svc.initialize(tmpWs("second"));
    assert.strictEqual(svc.getAgentId(), id1, "ID should not change on double init");
  });

  test("reinitialize() allows intentional workspace change", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize(tmpWs("first"));
    const id1 = svc.getAgentId();
    svc.reinitialize(tmpWs("second"));
    assert.notStrictEqual(svc.getAgentId(), id1, "ID should change after reinitialize");
  });

  // ── getWorkspaceAgentId facade ──

  test("getWorkspaceAgentId() returns same value as getInstance().getAgentId()", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize(tmpWs("facade-test"));
    assert.strictEqual(getWorkspaceAgentId(), svc.getAgentId());
  });

  // ── Path traversal guard (inspired by nanoclaw/src/group-folder.ts) ──

  test("resolveWorkspacePath resolves safe relative paths", () => {
    const svc = WorkspaceIdentityService.getInstance();
    const ws = tmpWs("workspace");
    svc.initialize(ws);
    const resolved = svc.resolveWorkspacePath("src/index.ts");
    assert.strictEqual(resolved, path.join(ws, "src", "index.ts"));
  });

  test("resolveWorkspacePath blocks path traversal with ..", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize(tmpWs("workspace"));
    assert.throws(
      () => svc.resolveWorkspacePath("../../etc/passwd"),
      /Path escapes workspace root/,
    );
  });

  test("resolveWorkspacePath blocks absolute paths outside workspace", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize(tmpWs("workspace"));
    assert.throws(
      () => svc.resolveWorkspacePath(path.join(os.homedir(), ".ssh", "id_rsa")),
      /Path escapes workspace root/,
    );
  });

  test("resolveWorkspacePath throws when no workspace is open", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize(undefined);
    assert.throws(
      () => svc.resolveWorkspacePath("src/foo.ts"),
      /No workspace root/,
    );
  });

  // ── validatePathWithinWorkspace (non-throwing variant for LLM tools) ──

  test("validatePathWithinWorkspace returns resolved path for safe relative path", () => {
    const svc = WorkspaceIdentityService.getInstance();
    const ws = tmpWs("workspace");
    svc.initialize(ws);
    assert.strictEqual(
      svc.validatePathWithinWorkspace("src/index.ts"),
      path.join(ws, "src", "index.ts"),
    );
  });

  test("validatePathWithinWorkspace returns resolved path for safe absolute path", () => {
    const svc = WorkspaceIdentityService.getInstance();
    const ws = tmpWs("workspace");
    svc.initialize(ws);
    const abs = path.join(ws, "src", "index.ts");
    assert.strictEqual(svc.validatePathWithinWorkspace(abs), abs);
  });

  test("validatePathWithinWorkspace returns undefined for traversal", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize(tmpWs("workspace"));
    assert.strictEqual(
      svc.validatePathWithinWorkspace("../../etc/passwd"),
      undefined,
    );
  });

  test("validatePathWithinWorkspace returns undefined for out-of-workspace absolute path", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize(tmpWs("workspace"));
    assert.strictEqual(
      svc.validatePathWithinWorkspace(path.join(os.homedir(), ".ssh", "id_rsa")),
      undefined,
    );
  });

  test("validatePathWithinWorkspace returns undefined when no workspace", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize(undefined);
    assert.strictEqual(
      svc.validatePathWithinWorkspace("src/foo.ts"),
      undefined,
    );
  });
});
