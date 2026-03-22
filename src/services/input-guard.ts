/**
 * Input Guard — Validation for browser action parameters.
 *
 * Validates `ref` (element references from page snapshots) and `key`
 * (keyboard key names) before passing them to the Playwright MCP server.
 * Prevents injection attacks via crafted page content that manipulates
 * snapshot-derived ref strings.
 */

/** Playwright snapshot refs: role[index], stable IDs, CSS-like tokens */
const SAFE_REF_PATTERN = /^[\w\-\[\].:#@]{1,256}$/;

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
  if (!ref || ref.length === 0) {
    throw new InputGuardError(
      `Invalid ref parameter: ${paramName} must not be empty`,
      "INVALID_REF",
    );
  }
  if (!SAFE_REF_PATTERN.test(ref)) {
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
