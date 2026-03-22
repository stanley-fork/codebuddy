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

  test("accepts refs with spaces (Playwright accessibility tree)", () => {
    assert.strictEqual(
      assertSafeRef("heading 'Welcome'"),
      "heading 'Welcome'",
    );
    assert.strictEqual(assertSafeRef("button 'Login'"), "button 'Login'");
  });

  test("accepts refs with Unicode characters", () => {
    assert.strictEqual(assertSafeRef("button 'ログイン'"), "button 'ログイン'");
  });

  test("rejects shell injection in ref", () => {
    assert.throws(
      () => assertSafeRef("btn; rm -rf /"),
      InputGuardError,
    );
  });

  test("rejects pipe injection in ref", () => {
    assert.throws(
      () => assertSafeRef("btn | cat /etc/passwd"),
      InputGuardError,
    );
  });

  test("rejects template literals in ref", () => {
    assert.throws(
      () => assertSafeRef("${process.env.SECRET}"),
      InputGuardError,
    );
  });

  test("rejects backtick injection in ref", () => {
    assert.throws(
      () => assertSafeRef("`whoami`"),
      InputGuardError,
    );
  });

  test("rejects empty ref", () => {
    assert.throws(() => assertSafeRef(""), InputGuardError);
  });

  test("rejects whitespace-only ref", () => {
    assert.throws(() => assertSafeRef("   "), InputGuardError);
  });

  test("rejects overlong ref", () => {
    assert.throws(() => assertSafeRef("a".repeat(513)), InputGuardError);
  });

  test("rejects null byte in ref", () => {
    assert.throws(() => assertSafeRef("btn\x00evil"), InputGuardError);
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
    assert.throws(
      () => assertSafeRef(""),
      (err: unknown): err is InputGuardError => {
        assert.ok(err instanceof InputGuardError, "Expected InputGuardError");
        assert.strictEqual(err.code, "INVALID_REF");
        return true;
      },
    );
  });

  test("InputGuardError key code", () => {
    assert.throws(
      () => assertSafeKey(""),
      (err: unknown): err is InputGuardError => {
        assert.ok(err instanceof InputGuardError, "Expected InputGuardError");
        assert.strictEqual(err.code, "INVALID_KEY");
        return true;
      },
    );
  });
});
