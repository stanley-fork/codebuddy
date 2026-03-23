import { create } from "zustand";

interface PanelState {
  isSettingsOpen: boolean;
  isSessionsOpen: boolean;
  isNotificationPanelOpen: boolean;
  isUpdatesPanelOpen: boolean;
  isObservabilityOpen: boolean;
  isCoWorkerOpen: boolean;
  isBrowserPanelOpen: boolean;
  isTeamPanelOpen: boolean;
  isCostDashboardOpen: boolean;
  isTerminalViewerOpen: boolean;
  isTestRunnerOpen: boolean;

  openSettings: () => void;
  closeSettings: () => void;
  openSessions: () => void;
  closeSessions: () => void;
  toggleNotifications: () => void;
  closeNotifications: () => void;
  openUpdates: () => void;
  closeUpdates: () => void;
  openObservability: () => void;
  closeObservability: () => void;
  openCoWorker: () => void;
  closeCoWorker: () => void;
  openBrowserPanel: () => void;
  closeBrowserPanel: () => void;
  openTeamPanel: () => void;
  closeTeamPanel: () => void;
  openCostDashboard: () => void;
  closeCostDashboard: () => void;
  openTerminalViewer: () => void;
  closeTerminalViewer: () => void;
  openTestRunner: () => void;
  closeTestRunner: () => void;
}

export const usePanelStore = create<PanelState>()((set) => ({
  isSettingsOpen: false,
  isSessionsOpen: false,
  isNotificationPanelOpen: false,
  isUpdatesPanelOpen: false,
  isObservabilityOpen: false,
  isCoWorkerOpen: false,
  isBrowserPanelOpen: false,
  isTeamPanelOpen: false,
  isCostDashboardOpen: false,
  isTerminalViewerOpen: false,
  isTestRunnerOpen: false,

  openSettings: () => set({ isSettingsOpen: true }),
  closeSettings: () => set({ isSettingsOpen: false }),
  openSessions: () => set({ isSessionsOpen: true }),
  closeSessions: () => set({ isSessionsOpen: false }),
  toggleNotifications: () =>
    set((s) => ({ isNotificationPanelOpen: !s.isNotificationPanelOpen })),
  closeNotifications: () => set({ isNotificationPanelOpen: false }),
  openUpdates: () => set({ isUpdatesPanelOpen: true }),
  closeUpdates: () => set({ isUpdatesPanelOpen: false }),
  openObservability: () => set({ isObservabilityOpen: true }),
  closeObservability: () => set({ isObservabilityOpen: false }),
  openCoWorker: () => set({ isCoWorkerOpen: true }),
  closeCoWorker: () => set({ isCoWorkerOpen: false }),
  openBrowserPanel: () => set({ isBrowserPanelOpen: true }),
  closeBrowserPanel: () => set({ isBrowserPanelOpen: false }),
  openTeamPanel: () => set({ isTeamPanelOpen: true }),
  closeTeamPanel: () => set({ isTeamPanelOpen: false }),
  openCostDashboard: () => set({ isCostDashboardOpen: true }),
  closeCostDashboard: () => set({ isCostDashboardOpen: false }),
  openTerminalViewer: () => set({ isTerminalViewerOpen: true }),
  closeTerminalViewer: () => set({ isTerminalViewerOpen: false }),
  openTestRunner: () => set({ isTestRunnerOpen: true }),
  closeTestRunner: () => set({ isTestRunnerOpen: false }),
}));
