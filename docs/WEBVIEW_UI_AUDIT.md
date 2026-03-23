# WebviewUI Deep-Dive Audit

> Generated from a full cross-reference of `webviewUi/src/` (React + Zustand) and `src/webview-providers/` (extension handlers).

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Unwired / Orphaned UI Components](#2-unwired--orphaned-ui-components)
3. [Extension Services Not Exposed in WebviewUI](#3-extension-services-not-exposed-in-webviewui)
4. [Partially Wired Features](#4-partially-wired-features)
5. [Display & Arrangement Improvements](#5-display--arrangement-improvements)
6. [New Functionality to Expose](#6-new-functionality-to-expose)
7. [Dead Code & Cleanup Candidates](#7-dead-code--cleanup-candidates)
8. [Appendix: Full Wiring Map](#appendix-full-wiring-map)

---

## 1. Architecture Overview

### Stack
- **WebviewUI**: React 18 + Zustand (8 stores) + styled-components + `@vscode/webview-ui-toolkit`
- **Communication**: `vscode.postMessage()` ↔ `webview.onDidReceiveMessage()`, 55+ message types
- **Entry**: `WebviewUI` component in `webview.tsx` → orchestrates all panels, settings, sidebar nav
- **Extension-side**: `BaseWebViewProvider` with 18 registered `WebviewMessageHandler`s + inline core commands

### Message Flow
```
WebviewUI (React)
   │ vscode.postMessage({ command, ... })
   ▼
BaseWebViewProvider.setupMessageHandler()
   │ handlerRegistry.dispatch(message)
   ▼
18 Registered Handlers (settings, browser, sessions, etc.)
   │ ctx.sendResponse() / webview.postMessage()
   ▼
useMessageDispatcher (React hook)
   │ routes 55+ message types → Zustand stores
   ▼
Components re-render via store selectors
```

### Panel System
The UI uses `usePanelStore` to toggle 7 sidebar panels:
| Panel | Toggle | Store | Handler |
|-------|--------|-------|---------|
| Settings | `isSettingsOpen` | `useSettingsStore` | `SettingsHandler` |
| Sessions | `isSessionsOpen` | `useSessionsStore` | `SessionHandler` |
| Notifications | `isNotificationPanelOpen` | `useNotificationsStore` | `NotificationHandler` |
| Updates/News | `isUpdatesPanelOpen` | `useContentStore` | `NewsHandler` |
| Observability | `isObservabilityOpen` | `useContentStore` | `ObservabilityHandler` |
| Browser/Reader | `isBrowserPanelOpen` | `useContentStore` | `BrowserHandler` |
| CoWorker | `isCoWorkerOpen` | `useStandupStore` + `useDoctorStore` | `StandupHandler` + `DoctorHandler` |

Plus 3 collapsible inline panels: PendingChanges, Composer, Checkpoint.

---

## 2. Unwired / Orphaned UI Components

These components exist in `webviewUi/src/components/` but are **never rendered** in the active UI:

### 2a. `AgentActivityFeed.tsx` — NOT IMPORTED
- **What**: A detailed timeline view showing tool calls with timing, action types (thinking/planning/working/tool_call), expandable details, and formatted elapsed time.
- **Status**: Fully coded (~380 lines) with i18n strings in all 7 locale files, but **never imported** in `webview.tsx`. The similar `AgentTimeline.tsx` is used instead.
- **Gap**: `AgentTimeline` appears to be the successor but `AgentActivityFeed` has some unique features (grouped action types, timing badges) that could be valuable.

### 2b. `futureFeatures.tsx` — NOT IMPORTED
- **What**: A "Coming Soon" features showcase panel with filterable cards (coming-soon / beta / experimental status badges), category filters, and styled feature cards.
- **Status**: Fully coded (~200+ lines), i18n strings present, but never rendered.
- **Opportunity**: Could be wired into Settings → About section or a dedicated "What's New" panel to show roadmap.

### 2c. `extensions.tsx` — NOT IMPORTED
- **What**: An "Extensions" management panel for custom MCP servers and custom agents. Shows hardcoded sample data (Docker Agent, GitHub Copilot, etc.) with add/toggle/configure actions.
- **Status**: UI shell exists but uses mock data. No postMessage integration. Never rendered.
- **Opportunity**: Could become a real MCP server + custom agent management UI, overlapping with `MCPSettings.tsx` in settings.

### 2d. `settings.tsx` (root-level) — SUPERSEDED
- **What**: An older, monolithic settings component with inline theme/model/mode/streaming controls.
- **Status**: Superseded by the modular `settings/SettingsPanel.tsx` with 15 section components. Dead code.

### 2e. `visualizer/VisualizerPanel.tsx`
- **What**: Workspace dependency graph visualizer using Mermaid diagrams.
- **Previous Status**: Tab and view were commented out.
- **Resolution**: Uncommented and promoted to a dedicated VISUALIZER tab. Added `dependencyGraph` state to `useContentStore` and `dependency-graph` message case to `useMessageDispatcher`.

### 2f. Test/Example Components — NOT IMPORTED
| File | Purpose |
|------|---------|
| `userMessageTest.tsx` | Visual test harness for `UserMessage` component |
| `thinkingExample.tsx` | Example usage of `ThinkingComponent` with test data |
| `thinkingTest.tsx` | Test data/scenarios for thinking states |

---

## 3. Extension Services Not Exposed in WebviewUI

These services exist in `src/services/` with **no corresponding handler or UI surface**:

### 3a. HIGH VALUE — Should Be Exposed

| Service | What It Does | Why Expose |
|---------|-------------|------------|
| **`cost-tracking.service.ts`** | Tracks token usage & USD cost per conversation per provider. Has pricing tables for all models. | The webview `CostDisplay` only shows data from the streaming hook (current turn). A session-level / cumulative cost dashboard would give users budget visibility. |
| **`debugger.service.ts`** | Wraps VS Code debug sessions: threads, stack traces, variables, breakpoints, expression evaluation. | A "Debug" panel in the webview could show active debug state, let users ask the agent to analyze variables/stack traces in context. |
| **`test-runner.service.ts`** | Detects test frameworks (jest/vitest/pytest/go/etc.), runs tests, parses pass/fail/skip output. | A "Tests" panel showing run results, failure details, and "fix this test" actions would be very valuable. |
| **`git.service.ts`** + **`git-actions.ts`** | Full git operations: diffs, branch info, commit history, workspace root detection. | Git status/branch info in the sidebar or header. Quick actions like "show diff", "create branch", "commit staged". |
| **`deep-terminal.service.ts`** | Advanced PTY terminal with persistent shell sessions, command history, output buffering. | A terminal output viewer in the webview showing agent terminal activity with history. |
| **`team-graph-store.ts`** | SQLite-backed graph: people, standups, commitments, blockers, decisions, ticket mentions, relationships. | A "Team" panel showing the relationship graph, commitment tracking, and blocker visibility. Complements the existing CoWorker/Standup panel. |

### 3b. MEDIUM VALUE — Nice to Have

| Service | What It Does | Why Expose |
|---------|-------------|------------|
| **`codebase-understanding.service.ts`** | Finds API endpoints, data models, DB schemas, domain relationships via TypeScript AST. | A read-only "Codebase Insights" view showing discovered structures. |
| **`dependency-graph.service.ts`** | Builds workspace dependency graph. | ✅ Now wired — Visualizer tab uses it end-to-end. |
| **`scheduler.service.ts`** | Cron-like: CodeHealth, DependencyCheck, GitWatchdog, EndOfDaySummary, Standup on intervals. | A "Scheduled Tasks" status indicator showing next run times, last results, enable/disable toggles. Already partially in CoWorker settings. |
| **`inline-review.service.ts`** | Creates in-editor `CommentThread`s with severity-based decoration. | Review findings could be surfaced in a "Reviews" panel alongside the diff review. |
| **`workspace-service.ts`** | File/folder listing, context info, exclude patterns. | Workspace file tree with search in the webview (currently only sent on bootstrap). |
| **`credential-proxy.service.ts`** | Local HTTPS proxy injecting API keys into LLM requests. HMAC tokens, rate limiting. | A "Proxy Status" indicator showing active routes, rate limit status, audit trail. |

### 3c. LOW VALUE — Internal Infrastructure

| Service | Reason to Keep Internal |
|---------|------------------------|
| `access-control.service.ts` | Gate logic, no direct user interaction needed |
| `agent-running-guard.service.ts` | Concurrency guard — internal |
| `ast-indexing.service.ts` | Worker thread indexing — internal |
| `chat-history-pruning.service.ts` | Automatic pruning — internal |
| `code-indexing.ts` | Internal indexing utilities |
| `embedding.ts` / `embedding-configuration.ts` | Embedding generation — internal |
| `external-security-config.service.ts` | Reads config files — internal |
| `input-guard.ts` / `input-validator.ts` / `navigation-guard.ts` | Security validation — internal |
| `llm-safety.ts` | Safety checks — internal |
| `pattern-extraction.service.ts` | Code patterns — internal |
| `smart-context-selector.service.ts` | Context selection — internal |
| `sqlite-database.service.ts` / `sqlite-vector-store.ts` | Database layer — internal |
| `web-search-service.ts` | Used by agent tools — internal |
| `question-classifier.service.ts` | Routing classifier — internal |

---

## 4. Partially Wired Features

### 4a. Browser Automation (Agent-only)
- **UI Surface**: `BrowserPanel` exposes reader mode, bookmarks, browsing history, article scraping.
- **Missing**: The full Playwright automation API (`navigate`, `click`, `type`, `screenshot`, `evaluate`, `scroll`, `hover`, `selectOption`, `dragAndDrop`) is available only to the agent via `BrowserService` + `BrowserTool`.
- **Gap**: Users can't manually trigger browser actions from the webview. A "Browser Automation" sub-panel with URL navigation + screenshot preview would make the feature discoverable.

### 4b. Docker / Local Models
- **UI Surface**: `ModelsSettings.tsx` has Docker Model Runner toggle, local model management.
- **Handler**: `DockerHandler` supports 10 commands (enable runner, pull/delete/use models, check status).
- **Gap**: The Docker model management is buried in Settings → Models. A dedicated "Local Models" panel or better surfacing in the model selector would help discovery.

### 4c. Cost Tracking
- **UI Surface**: `CostDisplay` shows per-turn token counts and estimated cost.
- **Handler**: None dedicated — cost data comes from streaming metadata.
- **Gap**: `cost-tracking.service.ts` maintains cumulative per-session, per-provider cost data that is never sent to the webview. Users can't see total session cost or historical spending.

### 4d. Performance/Profiler
- **UI Surface**: None — only available via `PerformanceHandler` commands (showPerformanceReport, clearCache, etc.) which send text responses to chat.
- **Gap**: A "Performance" section in Observability panel showing cache hit rates, indexing throughput, memory usage, and search latency would be more useful than raw text output.

### 4e. Dependency Graph Visualizer
- **Previous Status**: Tab and view were commented out.
- **Resolution**: Uncommented, promoted to VISUALIZER tab, wired `dependencyGraph` through content store + message dispatcher.

---

## 5. Display & Arrangement Improvements

### 5a. Panel Overcrowding
- **Previous Problem**: 7 floating toggle buttons in the top-left corner.
- **Resolution**: Replaced with VS Code activity-bar-style `ActivityRail` — full-height, 36px docked rail with `$active` state indicators, `RailBadge` for notification count, `RailDivider` between groups, `RailSpacer` pushing font controls to bottom. Added `toggleX()` methods to all panels in `usePanelStore`. Keyboard shortcuts `Ctrl+Shift+1..6`.

### 5b. Tab System Underutilized
- **Previous Problem**: Only 2 tabs (CHAT, FAQ). VISUALIZER tab commented out.
- **Resolution**: Restructured to **CHAT | FILES | OBSERVABILITY | VISUALIZER**.
  - FILES tab: PendingChanges, Composer, Checkpoint panels (moved from below chat)
  - OBSERVABILITY tab: Inline `ObservabilityPanel` (added `inline` prop to skip overlay wrapper)
  - VISUALIZER tab: Uncommented `VisualizerPanel`, wired `dependencyGraph` to content store
  - FAQ moved into Settings → About as a "Help & FAQ" accordion section

### 5c. Inline Panels Below Chat
**Problem**: PendingChanges, Composer, and Checkpoint panels sit below the chat messages, requiring scrolling past the chat to see them.

**Suggestions**:
1. Moved to a dedicated FILES tab (done as part of 5b).
2. Add notification badges on the toggle buttons when there are pending items.

### 5d. Welcome Screen → Onboarding Integration
- **Previous Problem**: `WelcomeScreen` and `OnboardingWizard` were disconnected.
- **Resolution**: Added `isCompleted` flag to onboarding store, always detect project info during hydrate, WelcomeScreen shows setup CTA when onboarding incomplete. Minimalist redesign: logo + greeting + tagline + optional setup CTA.

### 5e. Settings Organization
**Problem**: 15 settings sections is a lot. Categories like "Agents", "Connectors", "Skills", "MCP" have conceptual overlap.

**Suggestions**:
1. Group into 4 high-level categories: **General** (theme, font, language, privacy), **Models & Providers** (models, MCP, connectors, browser), **Agent Behavior** (agents, context, conversation, rules, skills), **Workspace** (beta, co-worker, about).
2. Add a search/filter in SettingsSidebar for quick access.

### 5f. Mobile / Narrow Viewport
**Problem**: Sidebar panels don't appear to have responsive breakpoints. On narrow webview widths, panels overlap or get clipped.

**Suggestion**: Add a `@media` breakpoint that collapses sidebar panels into full-screen modals below ~400px width.

### 5g. Error Boundary Naming
**Minor**: `errorBoundry.tsx` has a typo in the filename (should be `errorBoundary.tsx`).

---

## 6. New Functionality to Expose

### 6a. Session Cost Dashboard (Priority: HIGH)
- **Source**: `cost-tracking.service.ts`
- **What**: Cumulative cost per session with breakdown by model, provider, input/output tokens.
- **Where**: Expandable section in the `CostDisplay` component or a dedicated "Usage" panel.
- **Implementation**: New `CostTrackingHandler` → sends `cost-summary` messages with session totals.

### 6b. Test Runner Panel (Priority: HIGH)
- **Source**: `test-runner.service.ts`
- **What**: Run tests, see pass/fail/skip counts, view failure details, "Fix this test" button to send failures to the agent.
- **Where**: New panel or tab, or integrated into the CoWorker panel.
- **Implementation**: New `TestRunnerHandler` + `useTestRunnerStore` + `TestRunnerPanel`.

### 6c. Git Status Bar (Priority: HIGH)
- **Source**: `git.service.ts`, `git-actions.ts`
- **What**: Current branch, uncommitted changes count, quick actions (commit, push, create branch).
- **Where**: Header bar next to provider health indicator, or a "Git" section in an expanded status area.
- **Implementation**: New `GitHandler` + periodic git status polling → `git-status-update` messages.

### 6d. Debug Context Panel (Priority: MEDIUM)
- **Source**: `debugger.service.ts`
- **What**: Show active debug sessions, stack trace, local variables. "Ask agent about this variable" action.
- **Where**: New sidebar panel, auto-opens when a debug session starts.
- **Implementation**: New `DebugHandler` + VS Code `debug.onDidStartDebugSession` event forwarding.

### 6e. Terminal Activity Viewer (Priority: MEDIUM)
- **Source**: `deep-terminal.service.ts`
- **What**: View agent terminal commands and output history. Currently users can only see terminal output in the VS Code bottom panel.
- **Where**: Section within the Observability panel.
- **Implementation**: Forward `Terminal.onOutput` events (already in WebViewProviderManager) to a visible UI section.

### 6f. Workspace Visualizer (Priority: LOW)
- **Source**: `dependency-graph.service.ts`, `VisualizerPanel.tsx`
- **Resolution**: Uncommented and promoted to a VISUALIZER tab.

### 6g. Scheduled Tasks Status (Priority: LOW)
- **Source**: `scheduler.service.ts`
- **What**: Show next scheduled run times, last results, enable/disable per-task.
- **Where**: CoWorker panel or Settings → CoWorker section.

### 6h. Team Intelligence Graph (Priority: LOW)
- **Source**: `team-graph-store.ts`
- **What**: Visualize team relationships, commitments, blockers from standup data.
- **Where**: New section in CoWorker panel.

---

## Appendix: Full Wiring Map

### Extension Handler → Webview Store/Component Mapping

| Handler | → Store(s) | → Component(s) | Status |
|---------|-----------|----------------|--------|
| `SettingsHandler` | `useSettingsStore` | `SettingsPanel` + 15 sections | ✅ Full |
| `SessionHandler` | `useSessionsStore` | `SessionsPanel` | ✅ Full |
| `NotificationHandler` | `useNotificationsStore` | `NotificationPanel` | ✅ Full |
| `NewsHandler` | `useContentStore` | `UpdatesPanel`, `News` | ✅ Full |
| `BrowserHandler` | `useContentStore` | `BrowserPanel` | ⚠️ Reader only — no automation |
| `ObservabilityHandler` | `useContentStore` | `ObservabilityPanel` (inline tab + overlay) | ✅ Full |
| `StandupHandler` | `useStandupStore` | `CoWorkerPanel` → `StandupCard` | ✅ Full |
| `DoctorHandler` | `useDoctorStore` | `CoWorkerPanel` → `DoctorSection` | ✅ Full |
| `OnboardingHandler` | `useOnboardingStore` | `OnboardingWizard` | ✅ Full |
| `DiffReviewHandler` | `usePendingChanges` hook | `PendingChangesPanel` | ✅ Full |
| `ComposerHandler` | `useComposerSessions` hook | `ComposerPanel` | ✅ Full |
| `CheckpointHandler` | `useCheckpoints` hook | `CheckpointPanel` | ✅ Full |
| `RulesHandler` | `useSettingsStore` | `RulesSettings` | ✅ Full |
| `ConnectorHandler` | `useSettingsStore` | `ConnectorsSettings` | ✅ Full |
| `SkillHandler` | `useSettingsStore` | `SkillsSettings` | ✅ Full |
| `MCPHandler` | `useSettingsStore` | `MCPSettings` | ✅ Full |
| `DockerHandler` | `useSettingsStore` | `ModelsSettings` | ✅ Full |
| `PerformanceHandler` | (sends text to chat) | Chat messages | ⚠️ Text-only |

### Services with NO Handler

| Service | UI Component | Gap |
|---------|-------------|-----|
| `cost-tracking.service.ts` | `CostDisplay` (partial — streaming only) | No cumulative data |
| `debugger.service.ts` | None | Full gap |
| `test-runner.service.ts` | None | Full gap |
| `git.service.ts` / `git-actions.ts` | None | Full gap |
| `deep-terminal.service.ts` | None | Full gap |
| `team-graph-store.ts` | None | Full gap |
| `codebase-understanding.service.ts` | None | Full gap |
| `inline-review.service.ts` | None | Full gap |
| `meeting-intelligence.service.ts` | Via `StandupHandler` indirectly | Partial |
| `scheduler.service.ts` | Via settings toggles | Partial |
| `credential-proxy.service.ts` | None | Full gap |
