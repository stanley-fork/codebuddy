import { z } from "zod";
import { StructuredTool } from "@langchain/core/tools";
import { Logger, LogLevel } from "../../../infrastructure/logger/logger";
import { MeetingIntelligenceService } from "../../../services/meeting-intelligence.service";

const StandupToolSchema = z.object({
  operation: z
    .enum(["ingest", "my_tasks", "blockers", "history"])
    .describe(
      "The operation: 'ingest' (parse & store notes), 'my_tasks' (get commitments), 'blockers' (list blockers), 'history' (query past standups)",
    ),
  args: z
    .object({
      notes: z
        .string()
        .optional()
        .describe("Raw meeting notes text (required for 'ingest')"),
      person: z
        .string()
        .optional()
        .describe("Person name to filter by (for 'my_tasks' and 'history')"),
      dateRange: z
        .string()
        .optional()
        .describe("Date range like 'last 3 days', 'this week' (for 'history')"),
      ticketId: z
        .string()
        .optional()
        .describe("Ticket/MR ID to filter by (for 'history')"),
    })
    .optional()
    .describe("Arguments for the operation"),
});

type StandupToolInput = z.infer<typeof StandupToolSchema>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- LangChain's StructuredTool generic causes infinite type instantiation with complex Zod schemas
export class LangChainStandupTool extends StructuredTool<any> {
  private readonly logger: Logger;

  constructor() {
    super();
    this.logger = Logger.initialize("LangChainStandupTool", {
      minLevel: LogLevel.DEBUG,
      enableConsole: true,
      enableFile: true,
      enableTelemetry: true,
    });
  }

  name = "standup_intelligence";

  description =
    "Parse and query daily standup / meeting notes. Use 'ingest' to parse new meeting notes. Use 'my_tasks' to get a person's commitments. Use 'blockers' to list dependency chains. Use 'history' to query past standups by person, date, or ticket.";

  schema = StandupToolSchema;

  async _call(input: StandupToolInput): Promise<string> {
    this.logger.info(`Executing standup_intelligence: ${input.operation}`);

    try {
      const svc = MeetingIntelligenceService.getInstance();
      const args = input.args ?? {};

      switch (input.operation) {
        case "ingest": {
          if (!args.notes) {
            return "Error: 'notes' argument is required for the 'ingest' operation.";
          }
          return await svc.ingest(args.notes);
        }
        case "my_tasks": {
          return await svc.getMyTasks(args.person);
        }
        case "blockers": {
          return await svc.getBlockers();
        }
        case "history": {
          return await svc.queryHistory({
            person: args.person,
            dateRange: args.dateRange,
            ticketId: args.ticketId,
          });
        }
        default:
          return `Error: Unknown operation '${input.operation}'. Use 'ingest', 'my_tasks', 'blockers', or 'history'.`;
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      this.logger.error(`standup_intelligence error: ${msg}`);
      return `Error: ${msg}`;
    }
  }
}
