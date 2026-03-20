import { create } from "zustand";
import { vscode } from "../utils/vscode";

export interface DoctorFindingDTO {
  id: string;
  check: string;
  severity: "info" | "warn" | "critical";
  message: string;
  autoFixable: boolean;
}

/** Timeout for scan operations (30 s — generous for slow checks). */
const SCAN_TIMEOUT_MS = 30_000;

// Module-level timeout handle — not part of observable state
let scanTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

function clearScanTimeout() {
  if (scanTimeoutHandle !== null) {
    clearTimeout(scanTimeoutHandle);
    scanTimeoutHandle = null;
  }
}

function startScanTimeout(set: (partial: Partial<DoctorState>) => void) {
  clearScanTimeout();
  scanTimeoutHandle = setTimeout(() => {
    const { isScanning } = useDoctorStore.getState();
    if (isScanning) {
      set({
        isScanning: false,
        lastError: "Doctor scan timed out. The extension may be busy.",
      });
    }
    scanTimeoutHandle = null;
  }, SCAN_TIMEOUT_MS);
}

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

export const useDoctorStore = create<DoctorState>()((set) => ({
  findings: [],
  lastScanTime: null,
  isScanning: false,
  lastError: null,
  lastFixesApplied: null,

  runScan: () => {
    set({ isScanning: true, lastError: null, lastFixesApplied: null });
    vscode.postMessage({ command: "doctor-run" });
    startScanTimeout(set);
  },

  runAutoFix: () => {
    set({ isScanning: true, lastError: null });
    vscode.postMessage({ command: "doctor-auto-fix" });
    startScanTimeout(set);
  },

  hydrate: () => {
    set({ isScanning: true });
    vscode.postMessage({ command: "doctor-hydrate" });
    startScanTimeout(set);
  },

  setResults: (findings, timestamp, error, fixesApplied) => {
    clearScanTimeout();
    set({
      findings,
      lastScanTime: timestamp,
      isScanning: false,
      lastError: error ?? null,
      lastFixesApplied: fixesApplied ?? null,
    });
  },

  setScanning: (val) => set({ isScanning: val }),
}));
