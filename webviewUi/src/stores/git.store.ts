import { create } from "zustand";
import { vscode } from "../utils/vscode";

const GIT_POLL_INTERVAL_MS = 15_000;

interface GitStatusState {
  branch: string | null;
  upstream: string | null;
  changedFiles: number;
  staged: number;
  ahead: number;
  behind: number;

  // Actions
  requestStatus: () => void;
  startPolling: () => void;
  stopPolling: () => void;

  // Setters ← dispatcher
  setStatus: (data: {
    branch: string | null;
    upstream: string | null;
    changedFiles: number;
    staged: number;
    ahead: number;
    behind: number;
  }) => void;

  // Internal
  _pollId: ReturnType<typeof setInterval> | null;
}

export const useGitStore = create<GitStatusState>()((set, get) => ({
  branch: null,
  upstream: null,
  changedFiles: 0,
  staged: 0,
  ahead: 0,
  behind: 0,
  _pollId: null,

  requestStatus: () => {
    vscode.postMessage({ command: "git-status-request" });
  },

  startPolling: () => {
    const { _pollId, requestStatus } = get();
    if (_pollId) return; // already polling
    requestStatus();
    const id = setInterval(requestStatus, GIT_POLL_INTERVAL_MS);
    set({ _pollId: id });
  },

  stopPolling: () => {
    const { _pollId } = get();
    if (_pollId) {
      clearInterval(_pollId);
      set({ _pollId: null });
    }
  },

  setStatus: (data) =>
    set({
      branch: data.branch,
      upstream: data.upstream,
      changedFiles: data.changedFiles,
      staged: data.staged,
      ahead: data.ahead,
      behind: data.behind,
    }),
}));
