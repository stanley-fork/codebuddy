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
  // Octal/decimal encoding of 0.0.0.0 — URL parser may normalise these
  /^0+$/,
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

/**
 * Parse the hostname as an IPv4 address and check against private ranges.
 * Catches octal (0177.0.0.1), decimal (2130706433), and hex (0x7f000001)
 * representations that the regex-based patterns would miss.
 */
function isPrivateIPv4Numeric(hostname: string): boolean {
  // Attempt to detect numeric-encoded IPs by checking if the hostname
  // consists only of digits, dots, 'x', octal digits, or hex chars
  if (!/^[0-9a-fA-Fx.]+$/.test(hostname)) return false;

  // Try to interpret as a numeric IP (decimal, octal, hex) by parsing
  // each dotted component or the whole number
  let ip: number;
  if (hostname.includes(".")) {
    const parts = hostname.split(".");
    if (parts.length !== 4) return false;
    const octets = parts.map((p) => {
      if (p.startsWith("0x") || p.startsWith("0X")) return parseInt(p, 16);
      if (p.startsWith("0") && p.length > 1) return parseInt(p, 8);
      return parseInt(p, 10);
    });
    if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) return false;
    ip =
      ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>>
      0;
  } else {
    // Single number — decimal or hex (e.g. 2130706433 = 127.0.0.1)
    ip =
      hostname.startsWith("0x") || hostname.startsWith("0X")
        ? parseInt(hostname, 16)
        : parseInt(hostname, 10);
    if (isNaN(ip) || ip < 0 || ip > 0xffffffff) return false;
    ip = ip >>> 0;
  }

  // Check against private/reserved ranges
  const a = (ip >>> 24) & 0xff;
  const b = (ip >>> 16) & 0xff;
  // 0.0.0.0
  if (ip === 0) return true;
  // 127.0.0.0/8
  if (a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16
  if (a === 169 && b === 254) return true;

  return false;
}

function isBlockedHostname(hostname: string): boolean {
  if (BLOCKED_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname))) {
    return true;
  }
  return isPrivateIPv4Numeric(hostname);
}

const MAX_HOSTNAME_LENGTH = 253;
const MAX_PATHNAME_LENGTH = 2048;
const MAX_TOTAL_URL_LENGTH = 8192;

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
  // Check total length before parsing — avoids ReDoS on huge inputs
  if (rawUrl.length > MAX_TOTAL_URL_LENGTH) {
    throw new NavigationGuardError(
      `URL exceeds maximum total length (${MAX_TOTAL_URL_LENGTH})`,
      "URL_TOO_LONG",
    );
  }

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
