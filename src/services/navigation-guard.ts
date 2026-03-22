/**
 * Navigation Guard — Shared SSRF prevention for browser automation.
 *
 * Validates URLs before allowing browser navigation, blocking:
 *  - Non-HTTP(S) protocols (file:, javascript:, data:, etc.)
 *  - Private/internal IP ranges (RFC 1918, loopback, link-local)
 *  - IPv6 loopback, unspecified, unique-local, link-local, and mapped addresses
 *  - Excessively long hostnames/paths
 *
 * Used by BrowserService (agent tool) and BrowserHandler (webview scraping).
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Individual patterns for blocked hostnames — split for readability and testability.
 * Each pattern is tested against the `hostname` property of the parsed URL
 * (which strips brackets from IPv6 literals).
 */
const BLOCKED_HOSTNAME_PATTERNS: RegExp[] = [
  // Loopback
  /^localhost$/i,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^::1$/,
  // Unspecified address
  /^0\.0\.0\.0$/,
  /^::$/,
  // RFC 1918 private ranges
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  // Link-local (IPv4)
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
  // Link-local (IPv6 — fe80::/10)
  /^fe80:/i,
  // IPv6 unique-local (fc00::/7 — covers fc00:: and fd00::)
  /^f[cd][0-9a-f]{2}:/i,
  // IPv6-mapped IPv4 private addresses (::ffff:10.x, ::ffff:127.x, etc.)
  /^::ffff:(10\.|127\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/i,
];

function isBlockedHostname(hostname: string): boolean {
  return BLOCKED_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname));
}

const MAX_HOSTNAME_LENGTH = 253;
const MAX_PATHNAME_LENGTH = 2048;

export class NavigationGuardError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_URL"
      | "BLOCKED_PROTOCOL"
      | "BLOCKED_HOST"
      | "URL_TOO_LONG",
  ) {
    super(message);
    this.name = "NavigationGuardError";
  }
}

/**
 * Validate a URL for safe browser navigation.
 * Throws {@link NavigationGuardError} if the URL is not allowed.
 * Returns a normalised URL string on success.
 */
export function assertNavigationAllowed(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new NavigationGuardError(`Invalid URL: ${rawUrl}`, "INVALID_URL");
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new NavigationGuardError(
      `Disallowed protocol: ${parsed.protocol}`,
      "BLOCKED_PROTOCOL",
    );
  }

  if (isBlockedHostname(parsed.hostname)) {
    throw new NavigationGuardError(
      `Blocked hostname (SSRF protection): ${parsed.hostname}`,
      "BLOCKED_HOST",
    );
  }

  if (parsed.hostname.length > MAX_HOSTNAME_LENGTH) {
    throw new NavigationGuardError(
      `Hostname exceeds maximum length (${MAX_HOSTNAME_LENGTH})`,
      "URL_TOO_LONG",
    );
  }

  if (parsed.pathname.length > MAX_PATHNAME_LENGTH) {
    throw new NavigationGuardError(
      `Path exceeds maximum length (${MAX_PATHNAME_LENGTH})`,
      "URL_TOO_LONG",
    );
  }

  // Return the normalised href to prevent encoding-bypass attacks
  return parsed.href;
}
