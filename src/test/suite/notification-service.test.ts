/**
 * NotificationService Tests
 *
 * Tests deduplication within a time window, DB pruning (interval-gated),
 * count coercion, and the DEDUP_MAP_MAX_SIZE threshold.
 */

import * as assert from "assert";
import * as sinon from "sinon";
import {
  NotificationService,
  NotificationSource,
} from "../../services/notification.service";
import { SqliteDatabaseService } from "../../services/sqlite-database.service";

suite("NotificationService", () => {
  let sandbox: sinon.SinonSandbox;
  let dbStub: sinon.SinonStubbedInstance<SqliteDatabaseService>;
  let service: NotificationService;
  let clock: sinon.SinonFakeTimers;

  setup(() => {
    sandbox = sinon.createSandbox();
    clock = sinon.useFakeTimers({ now: Date.now() });

    // Stub the DB service singleton
    dbStub = sandbox.createStubInstance(SqliteDatabaseService);
    dbStub.initialize.resolves();
    dbStub.executeSqlCommand.returns(undefined as any);
    dbStub.executeSql.returns([{ count: 0 }]);
    sandbox.stub(SqliteDatabaseService, "getInstance").returns(dbStub as any);

    // Reset the singleton so it picks up our stub
    (NotificationService as any).instance = undefined;
    service = NotificationService.getInstance();
  });

  teardown(() => {
    (NotificationService as any).instance = undefined;
    clock.restore();
    sandbox.restore();
  });

  // ── Deduplication ─────────────────────────────────────

  test("suppresses duplicate notification within DEDUP_WINDOW_MS", async () => {
    await service.addNotification(
      "error",
      "Test Error",
      "msg",
      NotificationSource.System,
    );
    await service.addNotification(
      "error",
      "Test Error",
      "msg2",
      NotificationSource.System,
    );

    // Only one INSERT should have been executed
    const insertCalls = dbStub.executeSqlCommand
      .getCalls()
      .filter((c) => String(c.args[0]).includes("INSERT"));
    assert.strictEqual(insertCalls.length, 1);
  });

  test("allows same notification after DEDUP_WINDOW_MS expires", async () => {
    await service.addNotification(
      "error",
      "Test Error",
      "msg",
      NotificationSource.System,
    );

    clock.tick(31_000); // past the 30s window

    await service.addNotification(
      "error",
      "Test Error",
      "msg",
      NotificationSource.System,
    );

    const insertCalls = dbStub.executeSqlCommand
      .getCalls()
      .filter((c) => String(c.args[0]).includes("INSERT"));
    assert.strictEqual(insertCalls.length, 2);
  });

  test("allows different notification types within window", async () => {
    await service.addNotification(
      "error",
      "Title A",
      "msg",
      NotificationSource.System,
    );
    await service.addNotification(
      "success",
      "Title B",
      "msg",
      NotificationSource.System,
    );

    const insertCalls = dbStub.executeSqlCommand
      .getCalls()
      .filter((c) => String(c.args[0]).includes("INSERT"));
    assert.strictEqual(insertCalls.length, 2);
  });

  // ── Pruning ───────────────────────────────────────────

  test("does not prune when within PRUNE_INTERVAL_MS", async () => {
    dbStub.executeSql.returns([{ count: 1000 }]);

    await service.addNotification(
      "info",
      "First",
      "msg",
      NotificationSource.System,
    );
    // Immediately add another — within 5min interval
    clock.tick(1000);
    await service.addNotification(
      "info",
      "Second",
      "msg",
      NotificationSource.System,
    );

    // Only one COUNT query (from the first call that triggers prune)
    const countCalls = dbStub.executeSql
      .getCalls()
      .filter((c) => String(c.args[0]).includes("COUNT"));
    assert.strictEqual(countCalls.length, 1);
  });

  test("prunes after PRUNE_INTERVAL_MS with excess rows", async () => {
    dbStub.executeSql.returns([{ count: 600 }]);

    await service.addNotification(
      "info",
      "First",
      "msg",
      NotificationSource.System,
    );

    // Advance past 5 min
    clock.tick(5 * 60 * 1000 + 1);

    await service.addNotification(
      "info",
      "After interval",
      "msg",
      NotificationSource.System,
    );

    // Should have DELETE calls — one for first, one after interval
    const deleteCalls = dbStub.executeSqlCommand
      .getCalls()
      .filter((c) => String(c.args[0]).includes("DELETE"));
    assert.ok(deleteCalls.length >= 1, "Expected at least one DELETE call");

    // Verify the excess is calculated correctly (600 - 500 = 100)
    const lastDelete = deleteCalls[deleteCalls.length - 1];
    assert.strictEqual(lastDelete.args[1]?.[0], 100);
  });

  test("does not prune when table is within cap", async () => {
    dbStub.executeSql.returns([{ count: 400 }]);

    await service.addNotification(
      "info",
      "Under cap",
      "msg",
      NotificationSource.System,
    );

    const deleteCalls = dbStub.executeSqlCommand
      .getCalls()
      .filter((c) => String(c.args[0]).includes("DELETE"));
    assert.strictEqual(deleteCalls.length, 0);
  });

  // ── Count coercion ────────────────────────────────────

  test("handles BigInt-like count value via Number() coercion", async () => {
    // Simulate a driver that returns bigint
    dbStub.executeSql.returns([{ count: BigInt(600) }]);

    await service.addNotification(
      "info",
      "BigInt test",
      "msg",
      NotificationSource.System,
    );

    const deleteCalls = dbStub.executeSqlCommand
      .getCalls()
      .filter((c) => String(c.args[0]).includes("DELETE"));
    assert.ok(deleteCalls.length >= 1);
  });

  // ── Dedup map pruning ─────────────────────────────────

  test("prunes stale dedup entries when map exceeds DEDUP_MAP_MAX_SIZE", async () => {
    // Fill up the dedup map with 201 unique notifications
    for (let i = 0; i < 201; i++) {
      await service.addNotification(
        "info",
        `Title-${i}`,
        "msg",
        NotificationSource.System,
      );
    }

    // Advance past DEDUP_WINDOW_MS so entries become stale
    clock.tick(31_000);

    // Add one more to trigger pruning
    await service.addNotification(
      "info",
      "Trigger Prune",
      "msg",
      NotificationSource.System,
    );

    // The recentNotifications map should be pruned (all stale entries removed)
    // We can verify by checking that old titles are no longer deduplicated
    await service.addNotification(
      "info",
      "Title-0",
      "msg",
      NotificationSource.System,
    );

    // Title-0 should succeed because it was pruned from the dedup map
    const insertCalls = dbStub.executeSqlCommand
      .getCalls()
      .filter((c) => String(c.args[0]).includes("INSERT"));
    // 201 initial + "Trigger Prune" + "Title-0" = 203
    assert.strictEqual(insertCalls.length, 203);
  });
});
