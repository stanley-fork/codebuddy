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

type StandupDeleteMessage = {
  command: "standup-delete";
  date: string;
  teamName: string;
};

type StandupMessage =
  | StandupIngestMessage
  | StandupMyTasksMessage
  | StandupBlockersMessage
  | StandupHistoryMessage
  | StandupDeleteMessage;

const STANDUP_COMMANDS = [
  "standup-ingest",
  "standup-my-tasks",
  "standup-blockers",
  "standup-history",
  "standup-delete",
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
          const posted = await ctx.webview.webview
            .postMessage({
              command: "standup-result",
              summary: {
                date: record.date,
                teamName: record.teamName,
                commitmentCount: record.commitments.length,
                blockerCount: record.blockers.length,
                participantCount: record.participants.length,
              },
            })
            .then(
              () => true,
              (err: unknown) => {
                // Non-critical — card is already rendered via sendResponse
                ctx.logger.warn(
                  "standup-result postMessage failed (webview may be disposed)",
                  err instanceof Error ? err.message : String(err),
                );
                return false;
              },
            );

          if (!posted) {
            ctx.logger.info(
              "standup-result not delivered to store — UI may show stale state",
            );
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

        case "standup-delete": {
          if (!message.date || typeof message.date !== "string") {
            await ctx.sendResponse("Error: No date provided for deletion.");
            return;
          }
          const deleted = await svc.deleteStandup(
            message.date,
            message.teamName,
          );
          if (deleted) {
            await ctx.sendResponse(
              `Deleted standup for ${message.date} — ${message.teamName || "Unknown Team"}.`,
            );
          } else {
            await ctx.sendResponse(
              `No standup found for ${message.date} to delete.`,
            );
          }
          break;
        }
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      ctx.logger.error(`StandupHandler error: ${msg}`);
      try {
        await ctx.sendResponse(`Error processing standup command: ${msg}`);
        // Notify webview store so isIngesting spinner resets (Issue 1)
        await ctx.webview.webview.postMessage({
          command: "standup-error",
          error: msg,
        });
      } catch {
        // webview may be disposed
      }
    }
  }
}
