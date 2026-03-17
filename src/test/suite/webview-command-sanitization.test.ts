/**
 * Webview Command Sanitization Tests
 *
 * Tests: the VALID_COMMAND_PATTERN regex that prevents XSS through
 * command name reflection in the base webview provider.
 */

import * as assert from "assert";

suite("Webview command sanitization", () => {
  // Mirror of the regex in base.ts default case
  const VALID_COMMAND_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

  function sanitize(command: unknown): string {
    return typeof command === "string" && VALID_COMMAND_PATTERN.test(command)
      ? command
      : "[invalid]";
  }

  test("allows valid alphanumeric command", () => {
    assert.strictEqual(sanitize("update-model-event"), "update-model-event");
  });

  test("allows underscored command", () => {
    assert.strictEqual(sanitize("some_command_1"), "some_command_1");
  });

  test("rejects command with angle brackets (XSS attempt)", () => {
    assert.strictEqual(sanitize('<script>alert("xss")</script>'), "[invalid]");
  });

  test("rejects command with spaces", () => {
    assert.strictEqual(sanitize("has space"), "[invalid]");
  });

  test("rejects command longer than 64 characters", () => {
    assert.strictEqual(sanitize("a".repeat(65)), "[invalid]");
  });

  test("rejects empty string", () => {
    assert.strictEqual(sanitize(""), "[invalid]");
  });

  test("rejects non-string input", () => {
    assert.strictEqual(sanitize(null), "[invalid]");
    assert.strictEqual(sanitize(undefined), "[invalid]");
    assert.strictEqual(sanitize(42), "[invalid]");
  });

  test("rejects command with dots", () => {
    assert.strictEqual(sanitize("some.command"), "[invalid]");
  });

  test("allows command at exact 64-char boundary", () => {
    assert.strictEqual(sanitize("a".repeat(64)), "a".repeat(64));
  });
});
