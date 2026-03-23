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

// ── Serialisable DTOs ──────────────────────────────────────────────
interface ConversationCostEntry {
  threadId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUSD: number;
  provider: string;
  model: string;
  requestCount: number;
}

interface ProviderBreakdown {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUSD: number;
  requestCount: number;
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
        const conversations = (service as any).conversations as Map<
          string,
          any
        >;
        const entries: ConversationCostEntry[] = [];
        const providerMap = new Map<string, ProviderBreakdown>();

        let totalInput = 0;
        let totalOutput = 0;
        let totalCost = 0;
        let totalRequests = 0;

        for (const [threadId, cost] of conversations) {
          entries.push({
            threadId,
            inputTokens: cost.inputTokens,
            outputTokens: cost.outputTokens,
            totalTokens: cost.totalTokens,
            estimatedCostUSD: cost.estimatedCostUSD,
            provider: cost.provider,
            model: cost.model,
            requestCount: cost.requestCount,
          });

          totalInput += cost.inputTokens;
          totalOutput += cost.outputTokens;
          totalCost += cost.estimatedCostUSD;
          totalRequests += cost.requestCount;

          const existing = providerMap.get(cost.provider);
          if (existing) {
            existing.inputTokens += cost.inputTokens;
            existing.outputTokens += cost.outputTokens;
            existing.totalTokens += cost.totalTokens;
            existing.estimatedCostUSD += cost.estimatedCostUSD;
            existing.requestCount += cost.requestCount;
          } else {
            providerMap.set(cost.provider, {
              provider: cost.provider,
              inputTokens: cost.inputTokens,
              outputTokens: cost.outputTokens,
              totalTokens: cost.totalTokens,
              estimatedCostUSD: cost.estimatedCostUSD,
              requestCount: cost.requestCount,
            });
          }
        }

        await ctx.webview.webview.postMessage({
          type: "cost-summary-result",
          totals: {
            inputTokens: totalInput,
            outputTokens: totalOutput,
            totalTokens: totalInput + totalOutput,
            estimatedCostUSD: Math.round(totalCost * 1_000_000) / 1_000_000,
            requestCount: totalRequests,
            conversationCount: entries.length,
          },
          providers: [...providerMap.values()],
          conversations: entries,
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
