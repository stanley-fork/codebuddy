import { create } from "zustand";
import { vscode } from "../utils/vscode";

// ── DTOs ───────────────────────────────────────────────────────────
export interface TerminalSessionInfo {
  id: string;
  createdAt: number;
  bufferSize: number;
}

// ── Store shape ────────────────────────────────────────────────────
interface TerminalState {
  sessions: TerminalSessionInfo[];
  selectedSessionId: string | null;
  sessionOutput: string;
  isLoading: boolean;

  // Actions → extension
  requestSessions: () => void;
  requestHistory: (sessionId: string) => void;
  requestNewOutput: (sessionId: string) => void;

  // Setters ← dispatcher
  setSessions: (sessions: TerminalSessionInfo[]) => void;
  setHistory: (sessionId: string, output: string) => void;
  appendOutput: (sessionId: string, output: string) => void;
  selectSession: (sessionId: string | null) => void;
}

export const useTerminalStore = create<TerminalState>()((set, get) => ({
  sessions: [],
  selectedSessionId: null,
  sessionOutput: "",
  isLoading: false,

  requestSessions: () => {
    set({ isLoading: true });
    vscode.postMessage({ command: "terminal-list-sessions" });
  },

  requestHistory: (sessionId: string) => {
    set({ isLoading: true, selectedSessionId: sessionId });
    vscode.postMessage({ command: "terminal-session-history", sessionId });
  },

  requestNewOutput: (sessionId: string) => {
    vscode.postMessage({ command: "terminal-session-output", sessionId });
  },

  setSessions: (sessions) => set({ sessions, isLoading: false }),

  setHistory: (sessionId, output) => {
    if (get().selectedSessionId === sessionId) {
      set({ sessionOutput: output, isLoading: false });
    }
  },

  appendOutput: (sessionId, output) => {
    if (output && get().selectedSessionId === sessionId) {
      set((s) => ({ sessionOutput: s.sessionOutput + output }));
    }
  },

  selectSession: (sessionId) =>
    set({ selectedSessionId: sessionId, sessionOutput: "" }),
}));
