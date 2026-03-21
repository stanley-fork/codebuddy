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
 */

import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import { WorkspaceIdentityService } from "../../services/workspace-identity.service";

suite("WorkspaceIdentityService", () => {
  teardown(() => {
    WorkspaceIdentityService._resetForTesting();
  });

  test("produces stable hash for same workspace path", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize("/tmp/my-project");
    const id1 = svc.getAgentId();

    WorkspaceIdentityService._resetForTesting();

    const svc2 = WorkspaceIdentityService.getInstance();
    svc2.initialize("/tmp/my-project");
    const id2 = svc2.getAgentId();

    assert.strictEqual(id1, id2, "Same path should produce the same agent ID");
  });

  test("produces different hashes for different workspace paths", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize("/tmp/project-a");
    const idA = svc.getAgentId();

    WorkspaceIdentityService._resetForTesting();

    const svc2 = WorkspaceIdentityService.getInstance();
    svc2.initialize("/tmp/project-b");
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
    svc.initialize("/tmp/workspace");
    const id = svc.getAgentId();
    assert.match(id, /^agentId-[a-f0-9]{12}$/);
  });

  test("getWorkspaceName returns folder basename", () => {
    const svc = WorkspaceIdentityService.getInstance();
    svc.initialize("/Users/dev/projects/my-app");
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
    svc.initialize("/tmp/ws");
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
    a.initialize("/tmp/x");
    WorkspaceIdentityService._resetForTesting();
    const b = WorkspaceIdentityService.getInstance();
    // New instance should not have the old hash
    assert.strictEqual(b.getWorkspaceHash(), undefined);
  });
});
