import { create } from "zustand";
import { vscode } from "../utils/vscode";

// ─── Types ──────────────────────────────────────────────

export interface ProviderInfo {
  id: string;
  name: string;
  configured: boolean;
  isActive: boolean;
}

export interface ProjectInfo {
  name: string;
  languages: string[];
  frameworks: string[];
  hasGit: boolean;
  hasDocker: boolean;
  packageManager: string | null;
}

export interface ProviderTestResult {
  provider: string;
  success: boolean;
  latencyMs: number;
  error?: string;
}

export interface SuggestedTask {
  label: string;
  prompt: string;
}

export type OnboardingStep =
  | "welcome"
  | "provider"
  | "workspace"
  | "security"
  | "firstTask";

export const STEP_ORDER: OnboardingStep[] = [
  "welcome",
  "provider",
  "workspace",
  "security",
  "firstTask",
];

// ─── State ──────────────────────────────────────────────

interface OnboardingState {
  isVisible: boolean;
  currentStep: OnboardingStep;
  providers: ProviderInfo[];
  projectInfo: ProjectInfo | null;
  suggestedTasks: SuggestedTask[];
  isTestingProvider: boolean;
  testResult: ProviderTestResult | null;
  stepCompleting: boolean;

  // Actions
  hydrate: () => void;
  show: () => void;
  dismiss: () => void;
  skip: () => void;
  nextStep: () => void;
  prevStep: () => void;
  goToStep: (step: OnboardingStep) => void;
  completeStep: (step: number, data: Record<string, unknown>) => void;
  submitProviderKey: (provider: string, apiKey: string) => void;
  testProvider: (provider: string) => void;
  detectProject: () => void;
  setVisible: (visible: boolean) => void;
  setProviders: (providers: ProviderInfo[]) => void;
  setProjectInfo: (info: ProjectInfo | null) => void;
  setSuggestedTasks: (tasks: SuggestedTask[]) => void;
  setTestResult: (result: ProviderTestResult | null) => void;
  setTestingProvider: (testing: boolean) => void;
  setStepCompleting: (completing: boolean) => void;
}

// ─── Store ──────────────────────────────────────────────

export const useOnboardingStore = create<OnboardingState>()((set, get) => ({
  isVisible: false,
  currentStep: "welcome",
  providers: [],
  projectInfo: null,
  suggestedTasks: [],
  isTestingProvider: false,
  testResult: null,
  stepCompleting: false,

  hydrate: () => {
    vscode.postMessage({ command: "onboarding-hydrate" });
  },

  show: () => {
    set({ isVisible: true, currentStep: "welcome" });
  },

  dismiss: () => {
    vscode.postMessage({ command: "onboarding-dismiss" });
    set({ isVisible: false });
  },

  skip: () => {
    vscode.postMessage({ command: "onboarding-skip" });
    set({ isVisible: false });
  },

  nextStep: () => {
    const { currentStep } = get();
    const idx = STEP_ORDER.indexOf(currentStep);
    if (idx < STEP_ORDER.length - 1) {
      set({ currentStep: STEP_ORDER[idx + 1], testResult: null });
    } else {
      // Last step — complete the wizard
      vscode.postMessage({ command: "onboarding-dismiss" });
      set({ isVisible: false });
    }
  },

  prevStep: () => {
    const { currentStep } = get();
    const idx = STEP_ORDER.indexOf(currentStep);
    if (idx > 0) {
      set({ currentStep: STEP_ORDER[idx - 1], testResult: null });
    }
  },

  goToStep: (step) => {
    set({ currentStep: step, testResult: null });
  },

  completeStep: (step, data) => {
    set({ stepCompleting: true });
    // Strip secrets — extension host handles key storage via submitProviderKey
    const safeData = { ...data };
    if ("apiKey" in safeData) {
      delete safeData.apiKey;
    }
    vscode.postMessage({
      command: "onboarding-step-complete",
      step,
      data: safeData,
    });
  },

  submitProviderKey: (provider, apiKey) => {
    vscode.postMessage({
      command: "onboarding-store-provider-key",
      provider,
      apiKey,
    });
  },

  testProvider: (provider) => {
    set({ isTestingProvider: true, testResult: null });
    vscode.postMessage({
      command: "onboarding-test-provider",
      provider,
    });
  },

  detectProject: () => {
    vscode.postMessage({ command: "onboarding-detect-project" });
  },

  setVisible: (visible) => set({ isVisible: visible }),
  setProviders: (providers) => set({ providers }),
  setProjectInfo: (info) => set({ projectInfo: info }),
  setSuggestedTasks: (tasks) => set({ suggestedTasks: tasks }),
  setTestResult: (result) =>
    set({ testResult: result, isTestingProvider: false }),
  setTestingProvider: (testing) => set({ isTestingProvider: testing }),
  setStepCompleting: (completing) => set({ stepCompleting: completing }),
}));
