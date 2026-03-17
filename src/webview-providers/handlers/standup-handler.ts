import { WebviewMessageHandler, HandlerContext } from "./types";
import { MeetingIntelligenceService } from "../../services/meeting-intelligence.service";

export class StandupHandler implements WebviewMessageHandler {
  readonly commands = [
    "standup-ingest",
    "standup-my-tasks",
    "standup-blockers",
    "standup-history",
  ];

  async handle(message: any, ctx: HandlerContext): Promise<void> {
    try {
      const svc = MeetingIntelligenceService.getInstance();

      switch (message.command) {
        case "standup-ingest": {
          const notes = message.notes;
          if (!notes || typeof notes !== "string") {
            await ctx.sendResponse(
              "Error: No meeting notes provided. Usage: `/standup <paste your meeting notes>`",
            );
            return;
          }
          await ctx.sendResponse("⏳ Parsing standup notes...");
          const brief = await svc.ingest(notes);
          await ctx.sendResponse(brief);
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
