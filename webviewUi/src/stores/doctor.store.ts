import { create } from "zustand";
import { vscode } from "../utils/vscode";

export interface DoctorFindingDTO {
  check: string;
  severity: "info" | "warn" | "critical";
  message: string;
  autoFixable: boolean;
}

/** Timeout for scan operations (30 s — generous for slow checks). */
const SCAN_TIMEOUT_MS = 30_000;

interface DoctorState {
  /** Latest findings from a doctor scan. */
  findings: DoctorFindingDTO[];
  /** Timestamp of the last scan (epoch ms), null if never scanned. */
  lastScanTime: number | null;
  /** Whether a scan is currently in progress. */
  isScanning: boolean;
  /** Last error from a failed scan. */
  lastError: string | null;
  /** Number of fixes applied in the most recent auto-fix run. */
  lastFixesApplied: number | null;
  /** @internal timeout handle for scan safety net. */
  _scanTimeoutId: ReturnType<typeof setTimeout> | null;

  // ── Actions ──

  /** Trigger a doctor scan (sends to extension backend). */
  runScan: () => void;
  /** Trigger auto-fix for all fixable findings. */
  runAutoFix: () => void;
  /** Hydrate doctor state from backend (on panel open). */
  hydrate: () => void;
  /** Update findings from backend message. */
  setResults: (
    findings: DoctorFindingDTO[],
    timestamp: number,
    error?: string,
    fixesApplied?: number,
  ) => void;
  /** Mark scanning state. */
  setScanning: (val: boolean) => void;
}

function startScanTimeout(
  set: (partial: Partial<DoctorState>) => void,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    const { isScanning } = useDoctorStore.getState();
    if (isScanning) {
      set({
        isScanning: false,
        lastError: "Doctor scan timed out. The extension may be busy.",
        _scanTimeoutId: null,
      });
    }
  }, SCAN_TIMEOUT_MS);
}

export const useDoctorStore = create<DoctorState>()((set) => ({
  findings: [],
  lastScanTime: null,
  isScanning: false,
  lastError: null,
  lastFixesApplied: null,
  _scanTimeoutId: null,

  runScan: () => {
    set({ isScanning: true, lastError: null, lastFixesApplied: null });
    vscode.postMessage({ command: "doctor-run" });
    const timeoutId = startScanTimeout(set);
    set({ _scanTimeoutId: timeoutId });
  },

  runAutoFix: () => {
    set({ isScanning: true, lastError: null });
    vscode.postMessage({ command: "doctor-auto-fix" });
    const timeoutId = startScanTimeout(set);
    set({ _scanTimeoutId: timeoutId });
  },

  hydrate: () => {
    set({ isScanning: true });
    vscode.postMessage({ command: "doctor-hydrate" });
    const timeoutId = startScanTimeout(set);
    set({ _scanTimeoutId: timeoutId });
  },

  setResults: (findings, timestamp, error, fixesApplied) => {
    const state = useDoctorStore.getState();
    if (state._scanTimeoutId !== null) {
      clearTimeout(state._scanTimeoutId);
    }
    set({
      findings,
      lastScanTime: timestamp,
      isScanning: false,
      lastError: error ?? null,
      lastFixesApplied: fixesApplied ?? null,
      _scanTimeoutId: null,
    });
  },

  setScanning: (val) => set({ isScanning: val }),
}));
