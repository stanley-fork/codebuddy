import { create } from "zustand";
import { vscode } from "../utils/vscode";

export interface StandupSummary {
  date: string;
  teamName: string;
  commitmentCount: number;
  blockerCount: number;
  participantCount: number;
}

interface StandupState {
  /** Recent standup summaries (most recent first). */
  recentStandups: StandupSummary[];
  /** Whether an ingest operation is in progress. */
  isIngesting: boolean;
  /** Last error message (cleared on next operation). */
  lastError: string | null;
  /** Key of item currently being deleted ("date-teamName"). */
  deletingKey: string | null;

  // ── Actions ──

  /** Ingest raw meeting notes — sends to extension backend. */
  ingestNotes: (notes: string) => void;
  /** Request "my tasks" from the backend. */
  requestMyTasks: (person?: string) => void;
  /** Request blockers from the backend. */
  requestBlockers: () => void;
  /** Request standup history from the backend. */
  requestHistory: (filter?: {
    person?: string;
    dateRange?: string;
    ticketId?: string;
  }) => void;
  /** Add a summary to the recent list (called from message dispatcher). */
  addStandupSummary: (summary: StandupSummary) => void;
  /** Set ingesting state. */
  setIngesting: (val: boolean) => void;
  /** Set error. */
  setError: (err: string | null) => void;
  /** Request deletion — marks item as pending until backend confirms. */
  deleteStandup: (date: string, teamName: string) => void;
  /** Backend confirmed deletion succeeded. */
  confirmDelete: (date: string, teamName: string) => void;
  /** Backend reported deletion failed — rollback. */
  rollbackDelete: (error: string) => void;
  /** Request stored standup summaries from the backend (rehydrate on webview load). */
  hydrate: () => void;
}

export const useStandupStore = create<StandupState>()((set, get) => {
  let ingestTimeout: ReturnType<typeof setTimeout> | null = null;

  const clearIngestTimeout = () => {
    if (ingestTimeout) {
      clearTimeout(ingestTimeout);
      ingestTimeout = null;
    }
  };

  return {
    recentStandups: [],
    isIngesting: false,
    lastError: null,
    deletingKey: null,

    ingestNotes: (notes: string) => {
      clearIngestTimeout();
      set({ isIngesting: true, lastError: null });
      vscode.postMessage({ command: "standup-ingest", notes });

      // Safety-net timeout: reset isIngesting after 90 s
      // (LLM call has its own 45 s timeout; this covers store + prune overhead)
      ingestTimeout = setTimeout(() => {
        if (get().isIngesting) {
          set({
            isIngesting: false,
            lastError: "Standup ingestion timed out — please try again.",
          });
        }
      }, 90_000);
    },

    requestMyTasks: (person?: string) => {
      vscode.postMessage({ command: "standup-my-tasks", person });
    },

    requestBlockers: () => {
      vscode.postMessage({ command: "standup-blockers" });
    },

    requestHistory: (filter) => {
      vscode.postMessage({
        command: "standup-history",
        person: filter?.person,
        dateRange: filter?.dateRange,
        ticketId: filter?.ticketId,
      });
    },

    addStandupSummary: (summary: StandupSummary) => {
      clearIngestTimeout();
      set((s) => ({
        recentStandups: [summary, ...s.recentStandups].slice(0, 10),
        isIngesting: false,
      }));
    },

    setIngesting: (val: boolean) => {
      if (!val) clearIngestTimeout();
      set({ isIngesting: val });
    },
    setError: (err: string | null) => {
      clearIngestTimeout();
      set({ lastError: err, isIngesting: false });
    },
    deleteStandup: (date: string, teamName: string) => {
      const key = `${date}-${teamName}`;
      set({ deletingKey: key, lastError: null });
      vscode.postMessage({ command: "standup-delete", date, teamName });
    },
    confirmDelete: (date: string, teamName: string) => {
      set((s) => ({
        deletingKey: null,
        recentStandups: s.recentStandups.filter(
          (r) => !(r.date === date && r.teamName === teamName),
        ),
      }));
    },
    rollbackDelete: (error: string) => {
      set({ deletingKey: null, lastError: error });
    },
    hydrate: () => {
      vscode.postMessage({ command: "standup-hydrate" });
    },
  };
});
