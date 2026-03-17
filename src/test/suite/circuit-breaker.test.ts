/**
 * CircuitBreaker Tests
 *
 * Tests the three-state FSM (CLOSED → OPEN → HALF_OPEN),
 * failure counting, probe token serialization, and reset behavior.
 */

import * as assert from "assert";
import * as sinon from "sinon";
import {
  CircuitBreaker,
  CircuitState,
} from "../../MCP/circuit-breaker";

suite("CircuitBreaker", () => {
  let clock: sinon.SinonFakeTimers;

  setup(() => {
    clock = sinon.useFakeTimers({ now: Date.now() });
  });

  teardown(() => {
    clock.restore();
  });

  // ── Initial state ─────────────────────────────────────

  test("starts in CLOSED state", () => {
    const cb = new CircuitBreaker("test-server");
    assert.strictEqual(cb.getState(), CircuitState.CLOSED);
  });

  test("canAttempt returns true when CLOSED", () => {
    const cb = new CircuitBreaker("test-server");
    assert.strictEqual(cb.canAttempt(), true);
  });

  test("getName returns the server name", () => {
    const cb = new CircuitBreaker("my-server");
    assert.strictEqual(cb.getName(), "my-server");
  });

  // ── Failure counting → OPEN ───────────────────────────

  test("stays CLOSED below failure threshold", () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    assert.strictEqual(cb.getState(), CircuitState.CLOSED);
    assert.strictEqual(cb.canAttempt(), true);
  });

  test("transitions to OPEN at failure threshold", () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    assert.strictEqual(cb.getState(), CircuitState.OPEN);
  });

  test("canAttempt returns false when OPEN and within cooldown", () => {
    const cb = new CircuitBreaker("test", {
      failureThreshold: 2,
      resetTimeoutMs: 10_000,
    });
    cb.recordFailure();
    cb.recordFailure();
    assert.strictEqual(cb.getState(), CircuitState.OPEN);
    assert.strictEqual(cb.canAttempt(), false);
  });

  // ── OPEN → HALF_OPEN transition ───────────────────────

  test("transitions to HALF_OPEN after cooldown expires", () => {
    const cb = new CircuitBreaker("test", {
      failureThreshold: 2,
      resetTimeoutMs: 5_000,
    });
    cb.recordFailure();
    cb.recordFailure();
    assert.strictEqual(cb.getState(), CircuitState.OPEN);

    clock.tick(5_001);
    assert.strictEqual(cb.getState(), CircuitState.HALF_OPEN);
  });

  test("canAttempt grants probe token once in HALF_OPEN", () => {
    const cb = new CircuitBreaker("test", {
      failureThreshold: 1,
      resetTimeoutMs: 1_000,
    });
    cb.recordFailure();
    clock.tick(1_001);

    // First caller gets the probe
    assert.strictEqual(cb.canAttempt(), true);
    // Second caller is blocked
    assert.strictEqual(cb.canAttempt(), false);
  });

  // ── Success recovery ──────────────────────────────────

  test("recordSuccess resets to CLOSED from HALF_OPEN", () => {
    const cb = new CircuitBreaker("test", {
      failureThreshold: 1,
      resetTimeoutMs: 1_000,
    });
    cb.recordFailure();
    clock.tick(1_001);
    cb.canAttempt(); // transition to HALF_OPEN
    cb.recordSuccess();
    assert.strictEqual(cb.getState(), CircuitState.CLOSED);
    assert.strictEqual(cb.canAttempt(), true);
  });

  test("recordSuccess resets consecutive failure count", () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    // One more failure should not trip the breaker (counter was reset)
    cb.recordFailure();
    assert.strictEqual(cb.getState(), CircuitState.CLOSED);
  });

  // ── Failure in HALF_OPEN → back to OPEN ──────────────

  test("recordFailure in HALF_OPEN returns to OPEN", () => {
    const cb = new CircuitBreaker("test", {
      failureThreshold: 1,
      resetTimeoutMs: 1_000,
    });
    cb.recordFailure(); // → OPEN
    clock.tick(1_001);
    cb.canAttempt(); // → HALF_OPEN, probe claimed
    cb.recordFailure(); // → OPEN again
    assert.strictEqual(cb.getState(), CircuitState.OPEN);
  });

  // ── Manual reset ──────────────────────────────────────

  test("reset() returns to CLOSED from any state", () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1 });
    cb.recordFailure(); // → OPEN
    assert.strictEqual(cb.getState(), CircuitState.OPEN);

    cb.reset();
    assert.strictEqual(cb.getState(), CircuitState.CLOSED);
    assert.strictEqual(cb.canAttempt(), true);
  });

  // ── Cooldown calculation ──────────────────────────────

  test("getRemainingCooldownMs returns 0 when CLOSED", () => {
    const cb = new CircuitBreaker("test");
    assert.strictEqual(cb.getRemainingCooldownMs(), 0);
  });

  test("getRemainingCooldownMs returns remaining time when OPEN", () => {
    const cb = new CircuitBreaker("test", {
      failureThreshold: 1,
      resetTimeoutMs: 10_000,
    });
    cb.recordFailure();
    clock.tick(3_000);
    const remaining = cb.getRemainingCooldownMs();
    assert.ok(remaining > 6_000 && remaining <= 7_000);
  });

  test("getRemainingCooldownMs returns 0 after cooldown expires", () => {
    const cb = new CircuitBreaker("test", {
      failureThreshold: 1,
      resetTimeoutMs: 5_000,
    });
    cb.recordFailure();
    clock.tick(5_001);
    assert.strictEqual(cb.getRemainingCooldownMs(), 0);
  });

  // ── Custom options ────────────────────────────────────

  test("respects custom failureThreshold", () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 5 });
    for (let i = 0; i < 4; i++) cb.recordFailure();
    assert.strictEqual(cb.getState(), CircuitState.CLOSED);
    cb.recordFailure();
    assert.strictEqual(cb.getState(), CircuitState.OPEN);
  });

  test("uses default options when none provided", () => {
    const cb = new CircuitBreaker("test");
    // Default threshold is 3
    cb.recordFailure();
    cb.recordFailure();
    assert.strictEqual(cb.getState(), CircuitState.CLOSED);
    cb.recordFailure();
    assert.strictEqual(cb.getState(), CircuitState.OPEN);
  });
});
