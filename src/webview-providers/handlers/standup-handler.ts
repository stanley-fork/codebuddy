import { WebviewMessageHandler, HandlerContext } from "./types";
import { MeetingIntelligenceService } from "../../services/meeting-intelligence.service";

// ── Discriminated union for standup messages ───────────────────────
type StandupIngestMessage = { command: "standup-ingest"; notes: string };
type StandupMyTasksMessage = { command: "standup-my-tasks"; person?: string };
type StandupBlockersMessage = { command: "standup-blockers" };
type StandupHistoryMessage = {
  command: "standup-history";
  person?: string;
  dateRange?: string;
  ticketId?: string;
};

type StandupMessage =
  | StandupIngestMessage
  | StandupMyTasksMessage
  | StandupBlockersMessage
  | StandupHistoryMessage;

const STANDUP_COMMANDS = [
  "standup-ingest",
  "standup-my-tasks",
  "standup-blockers",
  "standup-history",
] as const;

function isStandupMessage(msg: unknown): msg is StandupMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "command" in msg &&
    typeof (msg as Record<string, unknown>).command === "string" &&
    STANDUP_COMMANDS.includes(
      (msg as Record<string, unknown>)
        .command as (typeof STANDUP_COMMANDS)[number],
    )
  );
}

export class StandupHandler implements WebviewMessageHandler {
  readonly commands = [...STANDUP_COMMANDS];

  async handle(message: unknown, ctx: HandlerContext): Promise<void> {
    if (!isStandupMessage(message)) {
      ctx.logger.warn("StandupHandler received invalid message shape");
      return;
    }

    try {
      const svc = MeetingIntelligenceService.getInstance();

      switch (message.command) {
        case "standup-ingest": {
          if (
            !message.notes ||
            typeof message.notes !== "string" ||
            !message.notes.trim()
          ) {
            await ctx.sendResponse(
              "Error: No meeting notes provided. Usage: `/standup <paste your meeting notes>`",
            );
            return;
          }
          await ctx.sendResponse("⏳ Parsing standup notes...");
          const { cardJson, record } = await svc.ingestStructured(
            message.notes,
          );
          // Send structured JSON as a chat response — MessageRenderer
          // detects `type: "standup_brief"` and renders a StandupCard.
          await ctx.sendResponse(cardJson);
          // Also notify the standup store in the CoWorker panel.
          try {
            await ctx.webview.webview.postMessage({
              command: "standup-result",
              summary: {
                date: record.date,
                teamName: record.teamName,
                commitmentCount: record.commitments.length,
                blockerCount: record.blockers.length,
                participantCount: record.participants.length,
              },
            });
          } catch {
            // webview may not be ready
          }
          break;
        }

        case "standup-my-tasks": {
          const result = await svc.getMyTasks(message.person);
          await ctx.sendResponse(result);
          break;
        }

        case "standup-blockers": {
          const result = await svc.getBlockers();
          await ctx.sendResponse(result);
          break;
        }

        case "standup-history": {
          const result = await svc.queryHistory({
            person: message.person,
            dateRange: message.dateRange,
            ticketId: message.ticketId,
          });
          await ctx.sendResponse(result);
          break;
        }
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      ctx.logger.error(`StandupHandler error: ${msg}`);
      try {
        await ctx.sendResponse(`Error processing standup command: ${msg}`);
      } catch {
        // webview may be disposed
      }
    }
  }
}
