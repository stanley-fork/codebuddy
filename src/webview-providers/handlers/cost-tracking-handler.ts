import { WebviewMessageHandler, HandlerContext } from "./types";
import { CostTrackingService } from "../../services/cost-tracking.service";

// ── Message types ──────────────────────────────────────────────────
type CostSummaryMessage = { command: "cost-summary" };
type CostResetMessage = { command: "cost-reset" };

type CostMessage = CostSummaryMessage | CostResetMessage;

const COST_COMMANDS = ["cost-summary", "cost-reset"] as const;

function isCostMessage(msg: unknown): msg is CostMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "command" in msg &&
    typeof (msg as Record<string, unknown>).command === "string" &&
    COST_COMMANDS.includes(
      (msg as Record<string, unknown>)
        .command as (typeof COST_COMMANDS)[number],
    )
  );
}

export class CostTrackingHandler implements WebviewMessageHandler {
  readonly commands = [...COST_COMMANDS];

  async handle(
    message: Record<string, unknown>,
    ctx: HandlerContext,
  ): Promise<void> {
    if (!isCostMessage(message)) return;

    const service = CostTrackingService.getInstance();

    switch (message.command) {
      case "cost-summary": {
        const summary = service.getCostSummary();
        await ctx.webview.webview.postMessage({
          type: "cost-summary-result",
          totals: summary.totals,
          providers: summary.providers,
          conversations: summary.conversations,
        });
        break;
      }

      case "cost-reset": {
        service.resetAll();
        await ctx.webview.webview.postMessage({
          type: "cost-summary-result",
          totals: null,
          providers: [],
          conversations: [],
        });
        break;
      }
    }
  }
}
