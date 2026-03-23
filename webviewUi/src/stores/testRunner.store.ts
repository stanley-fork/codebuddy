import { create } from "zustand";
import { vscode } from "../utils/vscode";

export interface TestFailureInfo {
  testName: string;
  file?: string;
  message: string;
  expected?: string;
  actual?: string;
}

export interface TestRunResult {
  framework: string;
  command: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  duration: string;
  success: boolean;
  failures: TestFailureInfo[];
  parseWarning: string | null;
}

interface TestRunnerState {
  isRunning: boolean;
  result: TestRunResult | null;
  error: string | null;

  // Actions
  runTests: (testPath?: string, testName?: string) => void;

  // Setters ← dispatcher
  setRunning: () => void;
  setResult: (result: TestRunResult) => void;
  setError: (error: string) => void;
  clear: () => void;
}

export const useTestRunnerStore = create<TestRunnerState>()((set) => ({
  isRunning: false,
  result: null,
  error: null,

  runTests: (testPath, testName) => {
    set({ isRunning: true, error: null });
    vscode.postMessage({
      command: "test-run",
      ...(testPath ? { testPath } : {}),
      ...(testName ? { testName } : {}),
    });
  },

  setRunning: () => set({ isRunning: true, error: null }),
  setResult: (result) => set({ result, isRunning: false, error: null }),
  setError: (error) => set({ error, isRunning: false }),
  clear: () => set({ result: null, error: null, isRunning: false }),
}));
