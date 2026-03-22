/**
 * Input Guard — Validation for browser action parameters.
 *
 * Validates `ref` (element references from page snapshots) and `key`
 * (keyboard key names) before passing them to the Playwright MCP server.
 * Prevents injection attacks via crafted page content that manipulates
 * snapshot-derived ref strings.
 *
 * Ref validation uses a blocklist (block known-bad characters) rather than
 * an allowlist (only known-good) because Playwright's accessibility tree can
 * emit refs with spaces, Unicode, and quotes for internationalized pages.
 */

/** Max ref length — prevents memory abuse in downstream logging/storage */
const MAX_REF_LENGTH = 512;

/** Null bytes, control chars, and shell/template-injection characters */
// eslint-disable-next-line no-control-regex
const BLOCKED_IN_REF = /[\x00-\x1f\x7f;|&`$(){}\\]/;

/** Keyboard key names: Enter, ArrowDown, F5, Shift+A, etc. */
const SAFE_KEY_PATTERN = /^[A-Za-z0-9+\-_]{1,64}$/;

export type InputGuardCode = "INVALID_REF" | "INVALID_KEY";

export class InputGuardError extends Error {
  readonly code: InputGuardCode;
  constructor(message: string, code: InputGuardCode) {
    super(message);
    this.name = "InputGuardError";
    this.code = code;
  }
}

export function assertSafeRef(ref: string, paramName = "ref"): string {
  if (!ref || ref.trim().length === 0) {
    throw new InputGuardError(
      `Invalid ref parameter: ${paramName} must not be empty`,
      "INVALID_REF",
    );
  }
  if (ref.length > MAX_REF_LENGTH) {
    throw new InputGuardError(
      `Invalid ref parameter: ${paramName} exceeds maximum length (${MAX_REF_LENGTH})`,
      "INVALID_REF",
    );
  }
  if (BLOCKED_IN_REF.test(ref)) {
    throw new InputGuardError(
      `Invalid ref parameter: ${paramName} contains disallowed characters: ${ref.slice(0, 40)}`,
      "INVALID_REF",
    );
  }
  return ref;
}

export function assertSafeKey(key: string): string {
  if (!key || key.length === 0) {
    throw new InputGuardError(
      "Invalid key parameter: key must not be empty",
      "INVALID_KEY",
    );
  }
  if (!SAFE_KEY_PATTERN.test(key)) {
    throw new InputGuardError(
      `Invalid key parameter: ${key.slice(0, 40)}`,
      "INVALID_KEY",
    );
  }
  return key;
}
