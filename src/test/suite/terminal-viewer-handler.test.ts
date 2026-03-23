import * as assert from "assert";
import * as sinon from "sinon";
import { TerminalViewerHandler } from "../../webview-providers/handlers/terminal-viewer-handler";
import { HandlerContext } from "../../webview-providers/handlers/types";
import { DeepTerminalService } from "../../services/deep-terminal.service";

suite("TerminalViewerHandler", () => {
  let handler: TerminalViewerHandler;
  let ctx: HandlerContext;
  let postMessageStub: sinon.SinonStub;
  let serviceStub: sinon.SinonStubbedInstance<DeepTerminalService>;

  setup(() => {
    handler = new TerminalViewerHandler();

    postMessageStub = sinon.stub().resolves(true);
    ctx = {
      webview: { webview: { postMessage: postMessageStub } },
      logger: { warn: sinon.stub(), info: sinon.stub(), error: sinon.stub() },
      extensionUri: {} as any,
      sendResponse: sinon.stub(),
    } as unknown as HandlerContext;

    serviceStub = sinon.createStubInstance(DeepTerminalService);
    sinon.stub(DeepTerminalService, "getInstance").returns(serviceStub as any);
  });

  teardown(() => {
    sinon.restore();
  });

  // ── commands ────────────────────────────────────────────────────

  test("registers all three terminal commands", () => {
    assert.ok(handler.commands.includes("terminal-list-sessions"));
    assert.ok(handler.commands.includes("terminal-session-history"));
    assert.ok(handler.commands.includes("terminal-session-output"));
    assert.strictEqual(handler.commands.length, 3);
  });

  // ── terminal-list-sessions ─────────────────────────────────────

  test("list-sessions posts empty array when no sessions", async () => {
    serviceStub.listSessions.returns([]);

    await handler.handle({ command: "terminal-list-sessions" }, ctx);

    assert.ok(postMessageStub.calledOnce);
    const msg = postMessageStub.firstCall.args[0];
    assert.strictEqual(msg.type, "terminal-list-sessions-result");
    assert.deepStrictEqual(msg.sessions, []);
  });

  test("list-sessions posts session array", async () => {
    const sessions = [
      { id: "s1", createdAt: 1000, bufferSize: 100 },
      { id: "s2", createdAt: 2000, bufferSize: 200 },
    ];
    serviceStub.listSessions.returns(sessions);

    await handler.handle({ command: "terminal-list-sessions" }, ctx);

    assert.ok(postMessageStub.calledOnce);
    const msg = postMessageStub.firstCall.args[0];
    assert.strictEqual(msg.type, "terminal-list-sessions-result");
    assert.deepStrictEqual(msg.sessions, sessions);
  });

  // ── terminal-session-history ───────────────────────────────────

  test("history returns full output for valid session", async () => {
    serviceStub.getFullHistory.returns("$ echo hello\nhello\n");

    await handler.handle(
      { command: "terminal-session-history", sessionId: "s1" },
      ctx,
    );

    assert.ok(postMessageStub.calledOnce);
    const msg = postMessageStub.firstCall.args[0];
    assert.strictEqual(msg.type, "terminal-session-history-result");
    assert.strictEqual(msg.sessionId, "s1");
    assert.strictEqual(msg.output, "$ echo hello\nhello\n");
  });

  test("history returns error for missing session", async () => {
    serviceStub.getFullHistory.returns(null);

    await handler.handle(
      { command: "terminal-session-history", sessionId: "missing" },
      ctx,
    );

    assert.ok(postMessageStub.calledOnce);
    const msg = postMessageStub.firstCall.args[0];
    assert.strictEqual(msg.type, "terminal-error");
    assert.strictEqual(msg.sessionId, "missing");
    assert.ok(msg.error.includes("not found"));
  });

  test("history returns error for empty sessionId", async () => {
    await handler.handle(
      { command: "terminal-session-history", sessionId: "  " },
      ctx,
    );

    assert.ok(postMessageStub.calledOnce);
    const msg = postMessageStub.firstCall.args[0];
    assert.strictEqual(msg.type, "terminal-error");
    assert.strictEqual(msg.sessionId, null);
    assert.ok(msg.error.includes("Invalid"));
  });

  test("history returns error for non-string sessionId", async () => {
    await handler.handle(
      { command: "terminal-session-history", sessionId: 123 } as any,
      ctx,
    );

    assert.ok(postMessageStub.calledOnce);
    const msg = postMessageStub.firstCall.args[0];
    assert.strictEqual(msg.type, "terminal-error");
  });

  // ── terminal-session-output ────────────────────────────────────

  test("output returns new data for valid session", async () => {
    serviceStub.readOutput.returns("new chunk");

    await handler.handle(
      { command: "terminal-session-output", sessionId: "s1" },
      ctx,
    );

    assert.ok(postMessageStub.calledOnce);
    const msg = postMessageStub.firstCall.args[0];
    assert.strictEqual(msg.type, "terminal-session-output-result");
    assert.strictEqual(msg.sessionId, "s1");
    assert.strictEqual(msg.output, "new chunk");
  });

  test("output returns error for missing session", async () => {
    serviceStub.readOutput.returns(null);

    await handler.handle(
      { command: "terminal-session-output", sessionId: "gone" },
      ctx,
    );

    assert.ok(postMessageStub.calledOnce);
    const msg = postMessageStub.firstCall.args[0];
    assert.strictEqual(msg.type, "terminal-error");
    assert.strictEqual(msg.sessionId, "gone");
    assert.ok(msg.error.includes("not found"));
  });

  test("output returns error for empty sessionId", async () => {
    await handler.handle(
      { command: "terminal-session-output", sessionId: "" },
      ctx,
    );

    assert.ok(postMessageStub.calledOnce);
    const msg = postMessageStub.firstCall.args[0];
    assert.strictEqual(msg.type, "terminal-error");
    assert.strictEqual(msg.sessionId, null);
  });

  // ── unknown / malformed ────────────────────────────────────────

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
