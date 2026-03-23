import * as assert from "assert";
import * as sinon from "sinon";
import { CostTrackingHandler } from "../../webview-providers/handlers/cost-tracking-handler";
import { HandlerContext } from "../../webview-providers/handlers/types";
import { CostTrackingService } from "../../services/cost-tracking.service";

suite("CostTrackingHandler", () => {
  let handler: CostTrackingHandler;
  let ctx: HandlerContext;
  let postMessageStub: sinon.SinonStub;
  let service: CostTrackingService;

  setup(() => {
    service = CostTrackingService.getInstance();
    service.resetAll();

    handler = new CostTrackingHandler();

    postMessageStub = sinon.stub().resolves(true);
    ctx = {
      webview: { webview: { postMessage: postMessageStub } },
      logger: { warn: sinon.stub(), info: sinon.stub(), error: sinon.stub() },
      extensionUri: {} as any,
      sendResponse: sinon.stub(),
    } as unknown as HandlerContext;
  });

  teardown(() => {
    service.resetAll();
    sinon.restore();
  });

  // ── commands ────────────────────────────────────────────────────

  test("registers cost-summary and cost-reset commands", () => {
    assert.ok(handler.commands.includes("cost-summary"));
    assert.ok(handler.commands.includes("cost-reset"));
    assert.strictEqual(handler.commands.length, 2);
  });

  // ── cost-summary ───────────────────────────────────────────────

  test("cost-summary posts empty result when no data", async () => {
    await handler.handle({ command: "cost-summary" }, ctx);

    assert.ok(postMessageStub.calledOnce);
    const msg = postMessageStub.firstCall.args[0];
    assert.strictEqual(msg.type, "cost-summary-result");
    assert.strictEqual(msg.totals.conversationCount, 0);
    assert.strictEqual(msg.totals.totalTokens, 0);
    assert.deepStrictEqual(msg.providers, []);
    assert.deepStrictEqual(msg.conversations, []);
  });

  test("cost-summary returns aggregated data", async () => {
    service.recordUsage("t1", "anthropic", "claude-sonnet-4-6", 1000, 500);
    service.recordUsage("t2", "openai", "gpt-4o", 2000, 1000);

    await handler.handle({ command: "cost-summary" }, ctx);

    assert.ok(postMessageStub.calledOnce);
    const msg = postMessageStub.firstCall.args[0];
    assert.strictEqual(msg.type, "cost-summary-result");
    assert.strictEqual(msg.totals.conversationCount, 2);
    assert.strictEqual(msg.totals.inputTokens, 3000);
    assert.strictEqual(msg.totals.outputTokens, 1500);
    assert.strictEqual(msg.totals.requestCount, 2);
    assert.strictEqual(msg.providers.length, 2);
    assert.strictEqual(msg.conversations.length, 2);
  });

  // ── cost-reset ─────────────────────────────────────────────────

  test("cost-reset clears data and posts null totals", async () => {
    service.recordUsage("t1", "anthropic", "claude-sonnet-4-6", 1000, 500);

    await handler.handle({ command: "cost-reset" }, ctx);

    assert.ok(postMessageStub.calledOnce);
    const msg = postMessageStub.firstCall.args[0];
    assert.strictEqual(msg.type, "cost-summary-result");
    assert.strictEqual(msg.totals, null);
    assert.deepStrictEqual(msg.providers, []);
    assert.deepStrictEqual(msg.conversations, []);

    // Service should be cleared
    assert.strictEqual(service.getConversationCost("t1"), null);
  });

  // ── unknown messages ───────────────────────────────────────────

  test("ignores unrelated commands", async () => {
    await handler.handle({ command: "some-other-command" }, ctx);
    assert.ok(postMessageStub.notCalled);
  });

  test("ignores malformed messages", async () => {
    await handler.handle({} as any, ctx);
    assert.ok(postMessageStub.notCalled);

    await handler.handle({ command: 123 } as any, ctx);
    assert.ok(postMessageStub.notCalled);
  });
});
