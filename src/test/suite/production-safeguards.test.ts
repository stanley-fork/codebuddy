/**
 * Production Safeguards Service Tests
 *
 * Tests: FORCE_GC is not in RecoveryAction type / strategy array.
 */

import * as assert from "assert";
import * as sinon from "sinon";
import {
  ProductionSafeguards,
  RecoveryAction,
} from "../../services/production-safeguards.service";

suite("ProductionSafeguardsService", () => {
  let service: ProductionSafeguards;

  setup(() => {
    service = new ProductionSafeguards();
  });

  teardown(() => {
    service.dispose();
    sinon.restore();
  });

  test("FORCE_GC is not a valid RecoveryAction", () => {
    // The RecoveryAction type should not include FORCE_GC.
    // We verify this at runtime by checking the recovery strategies.
    const strategies = (service as any).recoveryStrategies as Array<{
      action: string;
    }>;

    const actions = strategies.map((s) => s.action);
    assert.ok(
      !actions.includes("FORCE_GC"),
      "FORCE_GC should not appear in recovery strategies",
    );
  });

  test("valid RecoveryActions are present", () => {
    const validActions: RecoveryAction[] = [
      "CLEAR_CACHE",
      "REDUCE_BATCH_SIZE",
      "PAUSE_INDEXING",
      "RESTART_WORKER",
      "EMERGENCY_STOP",
    ];
    const strategies = (service as any).recoveryStrategies as Array<{
      action: string;
    }>;
    const strategyActions = strategies.map((s) => s.action);

    for (const action of validActions) {
      assert.ok(
        strategyActions.includes(action),
        `${action} should be in recovery strategies`,
      );
    }
  });
});
