import { WebviewMessageHandler, HandlerContext } from "./types";
import { DeepTerminalService } from "../../services/deep-terminal.service";

// ── Message types ──────────────────────────────────────────────────
type TerminalListMessage = { command: "terminal-list-sessions" };
type TerminalHistoryMessage = {
  command: "terminal-session-history";
  sessionId: string;
};
type TerminalReadMessage = {
  command: "terminal-session-output";
  sessionId: string;
};

type TerminalViewerMessage =
  | TerminalListMessage
  | TerminalHistoryMessage
  | TerminalReadMessage;

const TERMINAL_COMMANDS = [
  "terminal-list-sessions",
  "terminal-session-history",
  "terminal-session-output",
] as const;

function isTerminalViewerMessage(msg: unknown): msg is TerminalViewerMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "command" in msg &&
    typeof (msg as Record<string, unknown>).command === "string" &&
    TERMINAL_COMMANDS.includes(
      (msg as Record<string, unknown>)
        .command as (typeof TERMINAL_COMMANDS)[number],
    )
  );
}

export class TerminalViewerHandler implements WebviewMessageHandler {
  readonly commands = [...TERMINAL_COMMANDS];

  async handle(
    message: Record<string, unknown>,
    ctx: HandlerContext,
  ): Promise<void> {
    if (!isTerminalViewerMessage(message)) return;

    const service = DeepTerminalService.getInstance();

    switch (message.command) {
      case "terminal-list-sessions": {
        const list = service.listSessions();
        await ctx.webview.webview.postMessage({
          type: "terminal-list-sessions-result",
          sessions: list,
        });
        break;
      }

      case "terminal-session-history": {
        const sessionId = message.sessionId;
        if (typeof sessionId !== "string" || sessionId.trim() === "") {
          await ctx.webview.webview.postMessage({
            type: "terminal-error",
            sessionId: null,
            error: "Invalid session ID provided.",
          });
          return;
        }
        const history = service.getFullHistory(sessionId);
        if (history === null) {
          await ctx.webview.webview.postMessage({
            type: "terminal-error",
            sessionId,
            error: `Terminal session '${sessionId}' not found.`,
          });
          return;
        }
        await ctx.webview.webview.postMessage({
          type: "terminal-session-history-result",
          sessionId,
          output: history,
        });
        break;
      }

      case "terminal-session-output": {
        const sessionId = message.sessionId;
        if (typeof sessionId !== "string" || sessionId.trim() === "") {
          await ctx.webview.webview.postMessage({
            type: "terminal-error",
            sessionId: null,
            error: "Invalid session ID provided.",
          });
          return;
        }
        const output = service.readOutput(sessionId);
        if (output === null) {
          await ctx.webview.webview.postMessage({
            type: "terminal-error",
            sessionId,
            error: `Terminal session '${sessionId}' not found.`,
          });
          return;
        }
        await ctx.webview.webview.postMessage({
          type: "terminal-session-output-result",
          sessionId,
          output,
        });
        break;
      }
    }
  }
}
