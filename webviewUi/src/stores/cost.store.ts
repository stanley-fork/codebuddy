import { create } from "zustand";
import { vscode } from "../utils/vscode";

// ── DTOs (mirroring handler output) ────────────────────────────────
export interface CostTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUSD: number;
  requestCount: number;
  conversationCount: number;
}

export interface ProviderBreakdown {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUSD: number;
  requestCount: number;
}

export interface ConversationCostEntry {
  threadId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUSD: number;
  provider: string;
  model: string;
  requestCount: number;
}

// ── Store shape ────────────────────────────────────────────────────
interface CostState {
  totals: CostTotals | null;
  providers: ProviderBreakdown[];
  conversations: ConversationCostEntry[];
  isLoading: boolean;

  // Actions dispatched to extension
  requestSummary: () => void;
  requestReset: () => void;

  // Setters called from dispatcher
  setSummary: (
    totals: CostTotals | null,
    providers: ProviderBreakdown[],
    conversations: ConversationCostEntry[],
  ) => void;
  setLoading: (v: boolean) => void;
}

export const useCostStore = create<CostState>()((set) => ({
  totals: null,
  providers: [],
  conversations: [],
  isLoading: false,

  requestSummary: () => {
    set({ isLoading: true });
    vscode.postMessage({ command: "cost-summary" });
  },

  requestReset: () => {
    vscode.postMessage({ command: "cost-reset" });
  },

  setSummary: (totals, providers, conversations) =>
    set({ totals, providers, conversations, isLoading: false }),

  setLoading: (v) => set({ isLoading: v }),
}));
