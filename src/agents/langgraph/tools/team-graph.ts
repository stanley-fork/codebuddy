import { z } from "zod";
import { StructuredTool } from "@langchain/core/tools";
import { Logger, LogLevel } from "../../../infrastructure/logger/logger";
import { TeamGraphStore } from "../../../services/team-graph-store";

const TeamGraphToolSchema = z.object({
  operation: z
    .enum([
      "person_profile",
      "top_collaborators",
      "recurring_blockers",
      "completion_trends",
      "ticket_history",
      "team_health",
      "team_summary",
    ])
    .describe(
      "The operation: 'person_profile' (detailed profile for a person), " +
        "'top_collaborators' (who collaborates most with a person), " +
        "'recurring_blockers' (people/tickets that repeatedly block progress), " +
        "'completion_trends' (weekly commitment completion rates for a person), " +
        "'ticket_history' (full history of a ticket across standups), " +
        "'team_health' (aggregate team health dashboard), " +
        "'team_summary' (brief overview of all team members)",
    ),
  args: z
    .object({
      person: z
        .string()
        .optional()
        .describe(
          "Person name (required for 'person_profile', 'top_collaborators', 'completion_trends')",
        ),
      ticketId: z
        .string()
        .optional()
        .describe("Ticket/MR ID (required for 'ticket_history')"),
      limit: z
        .number()
        .optional()
        .describe(
          "Max results to return (for 'top_collaborators': default 5, 'completion_trends': default 8 weeks)",
        ),
      minCount: z
        .number()
        .optional()
        .describe(
          "Minimum occurrence count (for 'recurring_blockers': default 2)",
        ),
    })
    .optional()
    .describe("Arguments for the operation"),
});

type TeamGraphToolInput = z.infer<typeof TeamGraphToolSchema>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- LangChain's StructuredTool generic causes infinite type instantiation with complex Zod schemas
export class LangChainTeamGraphTool extends StructuredTool<any> {
  private readonly logger: Logger;

  constructor() {
    super();
    this.logger = Logger.initialize("LangChainTeamGraphTool", {
      minLevel: LogLevel.DEBUG,
      enableConsole: true,
      enableFile: true,
      enableTelemetry: true,
    });
  }

  name = "team_graph";

  description =
    "Query the team knowledge graph built from standup meetings. " +
    "Use 'person_profile' to get detailed info about a team member. " +
    "Use 'top_collaborators' to find who works closely with someone. " +
    "Use 'recurring_blockers' to identify persistent obstacles. " +
    "Use 'completion_trends' to see a person's delivery consistency over time. " +
    "Use 'ticket_history' to trace a ticket's journey across standups. " +
    "Use 'team_health' for an aggregate team health dashboard. " +
    "Use 'team_summary' for a brief overview of all team members.";

  schema = TeamGraphToolSchema;

  async _call(rawInput: unknown): Promise<string> {
    // Always validate — don't trust that LangChain ran our schema
    const parseResult = TeamGraphToolSchema.safeParse(rawInput);
    if (!parseResult.success) {
      this.logger.warn(`Invalid tool input: ${parseResult.error.message}`);
      return `Error: Invalid input format. ${parseResult.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(", ")}`;
    }
    const input = parseResult.data;

    this.logger.info(`Executing team_graph: ${input.operation}`);

    try {
      const store = TeamGraphStore.getInstance();
      if (!store.isReady()) {
        return "Error: Team graph is not yet initialized. Standup data must be ingested first.";
      }

      const args = input.args ?? {};

      switch (input.operation) {
        case "person_profile": {
          if (!args.person) {
            return "Error: 'person' argument is required for the 'person_profile' operation.";
          }
          return store.getPersonProfile(args.person);
        }
        case "top_collaborators": {
          if (!args.person) {
            return "Error: 'person' argument is required for the 'top_collaborators' operation.";
          }
          const person = store.getPersonByName(args.person);
          if (!person) return `No profile found for "${args.person}".`;
          const collabs = store.getTopCollaborators(person.id, args.limit ?? 5);
          if (!collabs.length)
            return `No collaborators found for "${args.person}".`;
          let out = `## Top Collaborators for ${person.name}\n\n`;
          for (const { person: p, weight } of collabs) {
            out += `- ${p.name} (${weight} meetings together)\n`;
          }
          return out;
        }
        case "recurring_blockers": {
          return store.getRecurringBlockers(args.minCount ?? 2);
        }
        case "completion_trends": {
          if (!args.person) {
            return "Error: 'person' argument is required for the 'completion_trends' operation.";
          }
          const person = store.getPersonByName(args.person);
          if (!person) return `No profile found for "${args.person}".`;
          return store.getCompletionTrends(person.id, args.limit ?? 8);
        }
        case "ticket_history": {
          if (!args.ticketId) {
            return "Error: 'ticketId' argument is required for the 'ticket_history' operation.";
          }
          return store.getTicketHistory(args.ticketId);
        }
        case "team_health": {
          return store.getTeamHealth();
        }
        case "team_summary": {
          return store.getTeamSummary();
        }
        default:
          return `Error: Unknown operation '${input.operation}'.`;
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      this.logger.error(`team_graph error: ${msg}`);
      return `Error: ${msg}`;
    }
  }
}
