import * as assert from "assert";
import {
  assertSafeRef,
  assertSafeKey,
  InputGuardError,
} from "../../services/input-guard";

suite("InputGuard", () => {
  // ── assertSafeRef ─────────────────────────────────────────────────

  test("accepts valid element refs", () => {
    assert.strictEqual(assertSafeRef("button[0]"), "button[0]");
    assert.strictEqual(assertSafeRef("input#email"), "input#email");
    assert.strictEqual(assertSafeRef("a.nav-link"), "a.nav-link");
    assert.strictEqual(assertSafeRef("div:nth-child"), "div:nth-child");
    assert.strictEqual(assertSafeRef("ref_123"), "ref_123");
    assert.strictEqual(assertSafeRef("el@attr"), "el@attr");
  });

  test("rejects SQL injection in ref", () => {
    assert.throws(
      () => assertSafeRef("'; DROP TABLE users; --"),
      InputGuardError,
    );
  });

  test("rejects XSS in ref", () => {
    assert.throws(
      () => assertSafeRef("<script>alert(1)</script>"),
      InputGuardError,
    );
  });

  test("rejects template literals in ref", () => {
    assert.throws(
      () => assertSafeRef("${process.env.SECRET}"),
      InputGuardError,
    );
  });

  test("rejects empty ref", () => {
    assert.throws(() => assertSafeRef(""), InputGuardError);
  });

  test("rejects overlong ref", () => {
    assert.throws(() => assertSafeRef("a".repeat(257)), InputGuardError);
  });

  // ── assertSafeKey ─────────────────────────────────────────────────

  test("accepts valid keyboard keys", () => {
    assert.strictEqual(assertSafeKey("Enter"), "Enter");
    assert.strictEqual(assertSafeKey("Tab"), "Tab");
    assert.strictEqual(assertSafeKey("ArrowDown"), "ArrowDown");
    assert.strictEqual(assertSafeKey("Control+C"), "Control+C");
    assert.strictEqual(assertSafeKey("Shift-A"), "Shift-A");
    assert.strictEqual(assertSafeKey("F12"), "F12");
  });

  test("rejects injection in key", () => {
    assert.throws(
      () => assertSafeKey("Enter; rm -rf /"),
      InputGuardError,
    );
  });

  test("rejects overlong key", () => {
    assert.throws(() => assertSafeKey("K".repeat(65)), InputGuardError);
  });

  test("rejects empty key", () => {
    assert.throws(() => assertSafeKey(""), InputGuardError);
  });

  test("InputGuardError has correct code property", () => {
    try {
      assertSafeRef("<evil>");
    } catch (err) {
      assert.ok(err instanceof InputGuardError);
      assert.strictEqual(err.code, "INVALID_REF");
    }
  });

  test("InputGuardError key code", () => {
    try {
      assertSafeKey("");
    } catch (err) {
      assert.ok(err instanceof InputGuardError);
      assert.strictEqual(err.code, "INVALID_KEY");
    }
  });
});
