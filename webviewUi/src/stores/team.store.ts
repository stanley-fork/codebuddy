import { create } from "zustand";
import { vscode } from "../utils/vscode";

// ── Types ──

export interface TeamMember {
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

export interface TeamRelationshipEdge {
  sourceName: string;
  targetName: string;
  kind: string;
  weight: number;
}

export interface TeamCommitment {
  action: string;
  status: string;
  date: string;
  deadline?: string | null;
}

export interface TeamHealthStats {
  teamSize: number;
  standups: number;
  avgCompletion: number;
  totalBlockers: number;
}

export interface TeamPersonDetail {
  member: TeamMember | null;
  commitments: Array<{ action: string; status: string; date: string }>;
  collaborators: Array<{ name: string; weight: number }>;
  profileMarkdown: string;
}

// ── Store ──

interface TeamState {
  /** All known team members. */
  members: TeamMember[];
  /** Relationship graph edges. */
  edges: TeamRelationshipEdge[];
  /** Team health markdown. */
  healthMarkdown: string | null;
  /** Structured health stats for the dashboard. */
  healthStats: TeamHealthStats | null;
  /** Recurring blockers markdown. */
  blockersMarkdown: string | null;
  /** Selected person detail view. */
  selectedPerson: TeamPersonDetail | null;
  /** Commitments for a specific person. */
  personCommitments: TeamCommitment[];
  /** Loading state. */
  isLoading: boolean;
  /** Error message. */
  lastError: string | null;

  // ── Actions ──
  hydrate: () => void;
  requestPersonProfile: (name: string) => void;
  requestHealth: () => void;
  requestRelationships: (name?: string) => void;
  requestRecurringBlockers: () => void;
  requestCommitments: (name: string) => void;

  // ── Setters (called from dispatcher) ──
  setHydrateResult: (
    members: TeamMember[],
    edges: TeamRelationshipEdge[],
    health: string,
    healthStats?: TeamHealthStats | null,
  ) => void;
  setPersonProfile: (detail: TeamPersonDetail) => void;
  setHealth: (health: string) => void;
  setEdges: (edges: TeamRelationshipEdge[]) => void;
  setBlockers: (blockers: string) => void;
  setCommitments: (name: string, commitments: TeamCommitment[]) => void;
  setError: (error: string | null) => void;
  clearSelectedPerson: () => void;
}

export const useTeamStore = create<TeamState>()((set) => ({
  members: [],
  edges: [],
  healthMarkdown: null,
  healthStats: null,
  blockersMarkdown: null,
  selectedPerson: null,
  personCommitments: [],
  isLoading: false,
  lastError: null,

  hydrate: () => {
    set({ isLoading: true, lastError: null });
    vscode.postMessage({ command: "team-hydrate" });
  },

  requestPersonProfile: (name: string) => {
    set({ isLoading: true, lastError: null });
    vscode.postMessage({ command: "team-person-profile", name });
  },

  requestHealth: () => {
    vscode.postMessage({ command: "team-health" });
  },

  requestRelationships: (name?: string) => {
    vscode.postMessage({ command: "team-relationships", name });
  },

  requestRecurringBlockers: () => {
    vscode.postMessage({ command: "team-recurring-blockers" });
  },

  requestCommitments: (name: string) => {
    vscode.postMessage({ command: "team-commitments", name });
  },

  setHydrateResult: (members, edges, health, healthStats) => {
    set({
      members,
      edges,
      healthMarkdown: health,
      healthStats: healthStats ?? null,
      isLoading: false,
    });
  },

  setPersonProfile: (detail) => {
    set({ selectedPerson: detail, isLoading: false });
  },

  setHealth: (health) => {
    set({ healthMarkdown: health });
  },

  setEdges: (edges) => {
    set({ edges });
  },

  setBlockers: (blockers) => {
    set({ blockersMarkdown: blockers });
  },

  setCommitments: (_name, commitments) => {
    set({ personCommitments: commitments });
  },

  setError: (error) => {
    set({ lastError: error, isLoading: false });
  },

  clearSelectedPerson: () => {
    set({ selectedPerson: null, personCommitments: [] });
  },
}));
