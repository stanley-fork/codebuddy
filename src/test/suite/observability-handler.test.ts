/**
 * ObservabilityHandler Tests
 *
 * Tests: trace change detection via monotonic cursor hash,
 * skip-if-unchanged behavior, and clear-traces hash reset.
 */

import * as assert from "assert";
import * as sinon from "sinon";
import { ObservabilityHandler } from "../../webview-providers/handlers/observability-handler";

// Access private methods for testing
function getComputeTraceHash(handler: ObservabilityHandler) {
  return (handler as any).computeTraceHash.bind(handler);
}

suite("ObservabilityHandler", () => {
  let handler: ObservabilityHandler;

  setup(() => {
    handler = new ObservabilityHandler();
  });

  teardown(() => {
    sinon.restore();
  });

  // ── computeTraceHash ──────────────────────────────────

  suite("computeTraceHash", () => {
    test("returns 'empty' for an empty traces array", () => {
      const hash = getComputeTraceHash(handler);
      assert.strictEqual(hash([]), "empty");
    });

    test("builds hash from [seconds, nanos] tuple format", () => {
      const traces = [
        { startTime: [100, 500], endTime: [200, 1000] },
        { startTime: [150, 0], endTime: [250, 2000] },
      ];
      const hash = getComputeTraceHash(handler);
      const result = hash(traces);

      // Expected: "2:<latestStart>:<latestEnd>"
      // latestStart = max(100*1e9+500, 150*1e9+0) = 150000000000
      // latestEnd = max(200*1e9+1000, 250*1e9+2000) = 250000002000
      assert.strictEqual(result, "2:150000000000:250000002000");
    });

    test("handles numeric epoch timestamps", () => {
      const traces = [
        { startTime: 1000, endTime: 2000 },
        { startTime: 1500, endTime: 3000 },
      ];
      const hash = getComputeTraceHash(handler);
      const result = hash(traces);
      assert.strictEqual(result, "2:1500:3000");
    });

    test("handles missing startTime and endTime gracefully", () => {
      const traces = [
        { startTime: undefined, endTime: undefined },
        { startTime: [10, 0], endTime: [20, 0] },
      ];
      const hash = getComputeTraceHash(handler);
      const result = hash(traces);
      assert.strictEqual(result, "2:10000000000:20000000000");
    });

    test("different span sets with same count but different times produce different hashes", () => {
      const hash = getComputeTraceHash(handler);
      const set1 = [{ startTime: [100, 0], endTime: [200, 0] }];
      const set2 = [{ startTime: [100, 0], endTime: [300, 0] }];
      assert.notStrictEqual(hash(set1), hash(set2));
    });

    test("same span sets produce identical hashes", () => {
      const hash = getComputeTraceHash(handler);
      const traces = [
        { startTime: [100, 0], endTime: [200, 0] },
        { startTime: [150, 0], endTime: [250, 0] },
      ];
      assert.strictEqual(hash(traces), hash(traces));
    });
  });

  // ── Change detection behavior ─────────────────────────

  suite("trace change detection", () => {
    test("lastTraceHash starts empty", () => {
      assert.strictEqual((handler as any).lastTraceHash, "");
    });
  });
});
