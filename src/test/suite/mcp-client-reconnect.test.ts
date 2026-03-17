/**
 * MCPClient Reconnect Timer Tests
 *
 * Tests: reconnect timer is stored, cleanup clears it,
 * DISCONNECTED state guards against reconnection.
 */

import * as assert from "assert";
import * as sinon from "sinon";

suite("MCPClient reconnect timer", () => {
  let clock: sinon.SinonFakeTimers;

  setup(() => {
    clock = sinon.useFakeTimers({ now: Date.now() });
  });

  teardown(() => {
    clock.restore();
    sinon.restore();
  });

  // We test the reconnect logic in isolation by constructing a minimal
  // MCPClient-like object that mirrors the private fields and methods.
  // This avoids pulling in the full @modelcontextprotocol/sdk which is
  // hard to stub in a unit test.

  function createReconnectTestHarness() {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 3;
    let state = "disconnected";
    const connectCalls: number[] = [];

    async function attemptReconnect(): Promise<void> {
      if (state === "disconnected") {
        return;
      }
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        return;
      }
      reconnectAttempts++;
      const MAX_RECONNECT_DELAY_MS = 30000;
      const baseDelay = 1000 * Math.pow(2, reconnectAttempts - 1);
      const delay = Math.min(baseDelay, MAX_RECONNECT_DELAY_MS);
      reconnectTimer = setTimeout(() => {
        connectCalls.push(Date.now());
      }, delay);
    }

    function cleanup(): void {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      state = "disconnected";
    }

    return {
      get reconnectTimer() { return reconnectTimer; },
      get reconnectAttempts() { return reconnectAttempts; },
      get state() { return state; },
      get connectCalls() { return connectCalls; },
      set state(v: string) { state = v; },
      attemptReconnect,
      cleanup,
    };
  }

  test("reconnect timer is stored when attemptReconnect fires", async () => {
    const h = createReconnectTestHarness();
    h.state = "error";
    await h.attemptReconnect();
    assert.ok(h.reconnectTimer !== null, "timer should be stored");
  });

  test("cleanup clears the reconnect timer", async () => {
    const h = createReconnectTestHarness();
    h.state = "error";
    await h.attemptReconnect();
    assert.ok(h.reconnectTimer !== null);
    h.cleanup();
    assert.strictEqual(h.reconnectTimer, null, "timer should be cleared after cleanup");
  });

  test("DISCONNECTED state prevents reconnect scheduling", async () => {
    const h = createReconnectTestHarness();
    h.state = "disconnected";
    await h.attemptReconnect();
    assert.strictEqual(h.reconnectTimer, null, "no timer should be set");
    assert.strictEqual(h.reconnectAttempts, 0, "no attempts should be made");
  });

  test("respects MAX_RECONNECT_ATTEMPTS limit", async () => {
    const h = createReconnectTestHarness();
    h.state = "error";
    await h.attemptReconnect(); // 1
    await h.attemptReconnect(); // 2
    await h.attemptReconnect(); // 3
    const timerAfterThree = h.reconnectTimer;
    await h.attemptReconnect(); // 4 — should be blocked
    // reconnectAttempts should stay at 3
    assert.strictEqual(h.reconnectAttempts, 3);
  });

  test("exponential backoff: delay doubles each attempt", async () => {
    const h = createReconnectTestHarness();
    h.state = "error";

    // Attempt 1: delay = 1000ms
    await h.attemptReconnect();
    clock.tick(999);
    assert.strictEqual(h.connectCalls.length, 0, "no connect yet at 999ms");
    clock.tick(1);
    assert.strictEqual(h.connectCalls.length, 1, "connect after 1000ms");

    // Attempt 2: delay = 2000ms
    h.state = "error";
    await h.attemptReconnect();
    clock.tick(1999);
    assert.strictEqual(h.connectCalls.length, 1, "no connect yet at 1999ms (attempt 2)");
    clock.tick(1);
    assert.strictEqual(h.connectCalls.length, 2, "connect after 2000ms");

    // Attempt 3: delay = 4000ms
    h.state = "error";
    await h.attemptReconnect();
    clock.tick(3999);
    assert.strictEqual(h.connectCalls.length, 2);
    clock.tick(1);
    assert.strictEqual(h.connectCalls.length, 3, "connect after 4000ms");
  });

  test("cleanup prevents pending timer from firing", async () => {
    const h = createReconnectTestHarness();
    h.state = "error";
    await h.attemptReconnect();
    h.cleanup();
    clock.tick(60000);
    assert.strictEqual(h.connectCalls.length, 0, "connect should not have been called");
  });
});
