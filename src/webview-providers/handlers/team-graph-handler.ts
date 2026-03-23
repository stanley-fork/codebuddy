import { WebviewMessageHandler, HandlerContext } from "./types";
import { TeamGraphStore } from "../../services/team-graph-store";
import type {
  PersonProfile,
  Relationship,
} from "../../services/team-graph-store";

// ── Message types ──────────────────────────────────────────────

type TeamHydrateMessage = { command: "team-hydrate" };
type TeamPersonProfileMessage = {
  command: "team-person-profile";
  name: string;
};
type TeamHealthMessage = { command: "team-health" };
type TeamRelationshipsMessage = {
  command: "team-relationships";
  name?: string;
};
type TeamBlockersMessage = { command: "team-recurring-blockers" };
type TeamCommitmentsMessage = {
  command: "team-commitments";
  name: string;
};

type TeamGraphMessage =
  | TeamHydrateMessage
  | TeamPersonProfileMessage
  | TeamHealthMessage
  | TeamRelationshipsMessage
  | TeamBlockersMessage
  | TeamCommitmentsMessage;

const TEAM_GRAPH_COMMANDS = [
  "team-hydrate",
  "team-person-profile",
  "team-health",
  "team-relationships",
  "team-recurring-blockers",
  "team-commitments",
] as const;

function isTeamGraphMessage(msg: unknown): msg is TeamGraphMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "command" in msg &&
    typeof (msg as Record<string, unknown>).command === "string" &&
    TEAM_GRAPH_COMMANDS.includes(
      (msg as Record<string, unknown>)
        .command as (typeof TEAM_GRAPH_COMMANDS)[number],
    )
  );
}

/** Serializable person for the webview. */
interface TeamMember {
  id: number;
  name: string;
  role: string | null;
  expertise: string[];
  workStyle: string | null;
  standupCount: number;
  commitmentCount: number;
  completionCount: number;
  completionRate: number;
  firstSeen: string;
  lastSeen: string;
}

interface TeamRelationshipEdge {
  sourceName: string;
  targetName: string;
  kind: string;
  weight: number;
}

function personToMember(p: PersonProfile): TeamMember {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    expertise: p.traits.expertise ?? [],
    workStyle: p.traits.workStyle ?? null,
    standupCount: p.standup_count,
    commitmentCount: p.commitment_count,
    completionCount: p.completion_count,
    completionRate:
      p.commitment_count > 0
        ? Math.round((p.completion_count / p.commitment_count) * 100)
        : 0,
    firstSeen: p.first_seen,
    lastSeen: p.last_seen,
  };
}

export class TeamGraphHandler implements WebviewMessageHandler {
  readonly commands = [...TEAM_GRAPH_COMMANDS];

  async handle(message: unknown, ctx: HandlerContext): Promise<void> {
    if (!isTeamGraphMessage(message)) {
      ctx.logger.warn("TeamGraphHandler received invalid message shape");
      return;
    }

    try {
      const store = TeamGraphStore.getInstance();
      await store.ensureInitialized();

      switch (message.command) {
        case "team-hydrate": {
          const people = store.getAllPeople();
          const members = people.map(personToMember);

          // Get all collaboration relationships for the graph
          const edges: TeamRelationshipEdge[] = [];
          const seenEdges = new Set<string>();
          for (const person of people) {
            const rels = store.getRelationshipsFor(person.id);
            for (const rel of rels) {
              const key = [
                Math.min(rel.source_person_id, rel.target_person_id),
                Math.max(rel.source_person_id, rel.target_person_id),
                rel.kind,
              ].join("-");
              if (seenEdges.has(key)) continue;
              seenEdges.add(key);

              const src = people.find((p) => p.id === rel.source_person_id);
              const tgt = people.find((p) => p.id === rel.target_person_id);
              if (src && tgt) {
                edges.push({
                  sourceName: src.name,
                  targetName: tgt.name,
                  kind: rel.kind,
                  weight: rel.weight,
                });
              }
            }
          }

          // Health stats
          const healthMarkdown = store.getTeamHealth();

          await ctx.webview.webview.postMessage({
            command: "team-hydrate-result",
            members,
            edges,
            health: healthMarkdown,
          });
          break;
        }

        case "team-person-profile": {
          if (!message.name || typeof message.name !== "string") {
            await ctx.webview.webview.postMessage({
              command: "team-person-profile-result",
              error: "No person name provided.",
            });
            return;
          }
          const profileMarkdown = store.getPersonProfile(message.name);
          const person = store.getPersonByName(message.name);
          const member = person ? personToMember(person) : null;

          // Get commitments
          let commitments: Array<{
            action: string;
            status: string;
            date: string;
          }> = [];
          if (person) {
            commitments = store.getCommitmentsFor(person.id, 10).map((c) => ({
              action: c.action,
              status: c.status,
              date: c.date,
            }));
          }

          // Get collaborators
          let collaborators: Array<{ name: string; weight: number }> = [];
          if (person) {
            collaborators = store
              .getTopCollaborators(person.id, 5)
              .map((c) => ({
                name: c.person.name,
                weight: c.weight,
              }));
          }

          await ctx.webview.webview.postMessage({
            command: "team-person-profile-result",
            member,
            commitments,
            collaborators,
            profileMarkdown,
          });
          break;
        }

        case "team-health": {
          const healthMarkdown = store.getTeamHealth();
          await ctx.webview.webview.postMessage({
            command: "team-health-result",
            health: healthMarkdown,
          });
          break;
        }

        case "team-relationships": {
          const people = store.getAllPeople();
          const edges: TeamRelationshipEdge[] = [];
          const seenEdges = new Set<string>();

          // If a specific person requested, only their relationships
          const targetPeople = message.name
            ? people.filter(
                (p) => p.name.toLowerCase() === message.name!.toLowerCase(),
              )
            : people;

          for (const person of targetPeople) {
            const rels = store.getRelationshipsFor(person.id);
            for (const rel of rels) {
              const key = [
                Math.min(rel.source_person_id, rel.target_person_id),
                Math.max(rel.source_person_id, rel.target_person_id),
                rel.kind,
              ].join("-");
              if (seenEdges.has(key)) continue;
              seenEdges.add(key);

              const src = people.find((p) => p.id === rel.source_person_id);
              const tgt = people.find((p) => p.id === rel.target_person_id);
              if (src && tgt) {
                edges.push({
                  sourceName: src.name,
                  targetName: tgt.name,
                  kind: rel.kind,
                  weight: rel.weight,
                });
              }
            }
          }

          await ctx.webview.webview.postMessage({
            command: "team-relationships-result",
            edges,
          });
          break;
        }

        case "team-recurring-blockers": {
          const blockersMarkdown = store.getRecurringBlockers();
          await ctx.webview.webview.postMessage({
            command: "team-recurring-blockers-result",
            blockers: blockersMarkdown,
          });
          break;
        }

        case "team-commitments": {
          if (!message.name || typeof message.name !== "string") {
            await ctx.webview.webview.postMessage({
              command: "team-commitments-result",
              error: "No person name provided.",
            });
            return;
          }
          const person = store.getPersonByName(message.name);
          if (!person) {
            await ctx.webview.webview.postMessage({
              command: "team-commitments-result",
              error: `No person found: "${message.name}"`,
            });
            return;
          }
          const commitments = store
            .getCommitmentsFor(person.id, 20)
            .map((c) => ({
              action: c.action,
              status: c.status,
              date: c.date,
              deadline: c.deadline,
            }));

          await ctx.webview.webview.postMessage({
            command: "team-commitments-result",
            name: person.name,
            commitments,
          });
          break;
        }
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      ctx.logger.error(`TeamGraphHandler error: ${msg}`);
      try {
        await ctx.webview.webview.postMessage({
          command: "team-error",
          error: msg,
        });
      } catch {
        // webview may be disposed
      }
    }
  }
}
