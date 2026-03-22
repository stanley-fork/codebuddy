import * as assert from "assert";
import {
  assertNavigationAllowed,
  NavigationGuardError,
} from "../../services/navigation-guard";

suite("NavigationGuard", () => {
  suite("assertNavigationAllowed", () => {
    test("allows valid HTTP URLs", () => {
      const result = assertNavigationAllowed("http://example.com");
      assert.strictEqual(result, "http://example.com/");
    });

    test("allows valid HTTPS URLs", () => {
      const result = assertNavigationAllowed("https://example.com/path?q=1");
      assert.strictEqual(result, "https://example.com/path?q=1");
    });

    test("returns normalised URL", () => {
      const result = assertNavigationAllowed("HTTP://EXAMPLE.COM/Path");
      assert.strictEqual(result, "http://example.com/Path");
    });

    // ── Protocol blocking ───────────────────────────────────────────────

    test("blocks file: protocol", () => {
      assert.throws(
        () => assertNavigationAllowed("file:///etc/passwd"),
        (err: NavigationGuardError) =>
          err.code === "BLOCKED_PROTOCOL" && /file:/i.test(err.message),
      );
    });

    test("blocks javascript: protocol", () => {
      assert.throws(
        // eslint-disable-next-line no-script-url
        () => assertNavigationAllowed("javascript:alert(1)"),
        (err: NavigationGuardError) => err.code === "BLOCKED_PROTOCOL",
      );
    });

    test("blocks data: protocol", () => {
      assert.throws(
        () => assertNavigationAllowed("data:text/html,<h1>hi</h1>"),
        (err: NavigationGuardError) => err.code === "BLOCKED_PROTOCOL",
      );
    });

    test("blocks ftp: protocol", () => {
      assert.throws(
        () => assertNavigationAllowed("ftp://evil.com/payload"),
        (err: NavigationGuardError) => err.code === "BLOCKED_PROTOCOL",
      );
    });

    // ── SSRF hostname blocking ──────────────────────────────────────────

    test("blocks localhost", () => {
      assert.throws(
        () => assertNavigationAllowed("http://localhost:8080"),
        (err: NavigationGuardError) =>
          err.code === "BLOCKED_HOST" && /localhost/i.test(err.message),
      );
    });

    test("blocks 127.0.0.1", () => {
      assert.throws(
        () => assertNavigationAllowed("http://127.0.0.1"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
    });

    test("blocks 10.x.x.x (RFC 1918 Class A)", () => {
      assert.throws(
        () => assertNavigationAllowed("http://10.0.0.1"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
    });

    test("blocks 172.16-31.x.x (RFC 1918 Class B)", () => {
      assert.throws(
        () => assertNavigationAllowed("http://172.16.0.1"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
      assert.throws(
        () => assertNavigationAllowed("http://172.31.255.255"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
    });

    test("allows 172.32.x.x (outside RFC 1918 Class B)", () => {
      const result = assertNavigationAllowed("http://172.32.0.1");
      assert.ok(result);
    });

    test("blocks 192.168.x.x (RFC 1918 Class C)", () => {
      assert.throws(
        () => assertNavigationAllowed("http://192.168.1.1"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
    });

    test("blocks 169.254.x.x (link-local)", () => {
      assert.throws(
        () => assertNavigationAllowed("http://169.254.169.254"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
    });

    test("blocks ::1 (IPv6 loopback)", () => {
      assert.throws(
        () => assertNavigationAllowed("http://[::1]:3000"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
    });

    test("blocks 0.0.0.0", () => {
      assert.throws(
        () => assertNavigationAllowed("http://0.0.0.0"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
    });

    // ── Octal/decimal IP bypass vectors ─────────────────────────────────

    test("blocks octal-encoded 127.0.0.1 (0177.0.0.1)", () => {
      assert.throws(
        () => assertNavigationAllowed("http://0177.0.0.1"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
    });

    test("blocks decimal-encoded 127.0.0.1 (2130706433)", () => {
      assert.throws(
        () => assertNavigationAllowed("http://2130706433"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
    });

    test("blocks hex-encoded 127.0.0.1 (0x7f000001)", () => {
      assert.throws(
        () => assertNavigationAllowed("http://0x7f000001"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
    });

    test("blocks 127.1.2.3 (127.x.x.x loopback range)", () => {
      assert.throws(
        () => assertNavigationAllowed("http://127.1.2.3"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
    });

    test("blocks octal-encoded 10.0.0.1 (012.0.0.1)", () => {
      assert.throws(
        () => assertNavigationAllowed("http://012.0.0.1"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
    });

    // ── IPv6 bypass vectors ─────────────────────────────────────────────

    test("blocks [::] (unspecified IPv6)", () => {
      assert.throws(
        () => assertNavigationAllowed("http://[::]:8080"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
    });

    test("blocks fe80:: (IPv6 link-local)", () => {
      assert.throws(
        () => assertNavigationAllowed("http://[fe80::1]"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
    });

    test("blocks fc00::/fd00:: (IPv6 unique-local)", () => {
      assert.throws(
        () => assertNavigationAllowed("http://[fc00::1]"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
      assert.throws(
        () => assertNavigationAllowed("http://[fd12::1]"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
    });

    test("blocks ::ffff:192.168.x.x (IPv6-mapped private)", () => {
      assert.throws(
        () => assertNavigationAllowed("http://[::ffff:192.168.1.1]"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
    });

    test("blocks ::ffff:10.x.x.x (IPv6-mapped Class A)", () => {
      assert.throws(
        () => assertNavigationAllowed("http://[::ffff:10.0.0.1]"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
    });

    test("blocks ::ffff:127.0.0.1 (IPv6-mapped loopback)", () => {
      assert.throws(
        () => assertNavigationAllowed("http://[::ffff:127.0.0.1]"),
        (err: NavigationGuardError) => err.code === "BLOCKED_HOST",
      );
    });

    // ── Invalid URLs ────────────────────────────────────────────────────

    test("rejects invalid URL", () => {
      assert.throws(
        () => assertNavigationAllowed("not-a-url"),
        (err: NavigationGuardError) => err.code === "INVALID_URL",
      );
    });

    test("rejects empty string", () => {
      assert.throws(
        () => assertNavigationAllowed(""),
        (err: NavigationGuardError) => err.code === "INVALID_URL",
      );
    });

    // ── Length limits ───────────────────────────────────────────────────

    test("rejects overly long hostname", () => {
      const longHost = "a".repeat(254) + ".com";
      assert.throws(
        () => assertNavigationAllowed(`http://${longHost}`),
        (err: NavigationGuardError) => err.code === "URL_TOO_LONG",
      );
    });

    test("rejects overly long pathname", () => {
      const longPath = "/" + "a".repeat(2049);
      assert.throws(
        () => assertNavigationAllowed(`http://example.com${longPath}`),
        (err: NavigationGuardError) => err.code === "URL_TOO_LONG",
      );
    });

    test("rejects URL exceeding total length limit", () => {
      const longQuery = "?" + "q=".padEnd(9000, "a");
      assert.throws(
        () => assertNavigationAllowed(`http://example.com/${longQuery}`),
        (err: NavigationGuardError) => err.code === "URL_TOO_LONG",
      );
    });

    // ── Error type ──────────────────────────────────────────────────────

    test("throws NavigationGuardError with correct name", () => {
      try {
        assertNavigationAllowed("file:///etc/passwd");
        assert.fail("Should have thrown");
      } catch (err) {
        assert.ok(err instanceof NavigationGuardError);
        assert.strictEqual(err.name, "NavigationGuardError");
      }
    });
  });
});
