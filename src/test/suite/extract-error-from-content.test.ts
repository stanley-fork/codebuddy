/**
 * extractErrorFromContent Tests
 *
 * Tests: JSON with .message, JSON with .error, non-JSON strings,
 * length cap at 200 chars, non-string inputs.
 */

import * as assert from "assert";

/**
 * Mirror of WebViewProviderManager.extractErrorFromContent — extracted
 * verbatim so we can test the logic without wiring up the full provider
 * graph & vscode extension host.
 */
function extractErrorFromContent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.message === "string" && obj.message.length < 200) {
        return obj.message;
      }
      if (typeof obj.error === "string" && obj.error.length < 200) {
        return obj.error;
      }
    }
  } catch {
    // Not JSON — do not reflect raw string content
  }
  return undefined;
}

suite("extractErrorFromContent", () => {

  test("returns undefined for non-string input", () => {
    assert.strictEqual(extractErrorFromContent(undefined), undefined);
    assert.strictEqual(extractErrorFromContent(null), undefined);
    assert.strictEqual(extractErrorFromContent(42), undefined);
    assert.strictEqual(extractErrorFromContent({}), undefined);
  });

  test("extracts .message from valid JSON", () => {
    const json = JSON.stringify({ message: "connection timeout" });
    assert.strictEqual(extractErrorFromContent(json), "connection timeout");
  });

  test("extracts .error from valid JSON", () => {
    const json = JSON.stringify({ error: "rate limited" });
    assert.strictEqual(extractErrorFromContent(json), "rate limited");
  });

  test("prefers .message over .error", () => {
    const json = JSON.stringify({ message: "msg1", error: "err1" });
    assert.strictEqual(extractErrorFromContent(json), "msg1");
  });

  test("rejects .message longer than 200 chars, falls through to .error", () => {
    const longMsg = "x".repeat(201);
    const json = JSON.stringify({ message: longMsg, error: "short" });
    assert.strictEqual(extractErrorFromContent(json), "short");
  });

  test("rejects both when both exceed 200 chars", () => {
    const longMsg = "x".repeat(201);
    const json = JSON.stringify({ message: longMsg, error: longMsg });
    assert.strictEqual(extractErrorFromContent(json), undefined);
  });

  test("returns undefined for raw non-JSON string (no PII leak)", () => {
    assert.strictEqual(
      extractErrorFromContent("Error: something went wrong for user@example.com"),
      undefined,
    );
  });

  test("returns undefined for JSON array", () => {
    assert.strictEqual(extractErrorFromContent("[1,2,3]"), undefined);
  });

  test("returns undefined for JSON object without message or error", () => {
    assert.strictEqual(
      extractErrorFromContent(JSON.stringify({ code: 500, details: "oops" })),
      undefined,
    );
  });

  test("returns undefined for JSON null", () => {
    assert.strictEqual(extractErrorFromContent("null"), undefined);
  });

  test("handles numeric .message (non-string) by falling through", () => {
    assert.strictEqual(
      extractErrorFromContent(JSON.stringify({ message: 42 })),
      undefined,
    );
  });
});
