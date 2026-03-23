import { useEffect, useRef, useCallback } from "react";
import styled from "styled-components";
import { useTerminalStore } from "../../stores/terminal.store";
import type { TerminalSessionInfo } from "../../stores/terminal.store";

interface TerminalViewerPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

/* ─── Styled Components ─── */

const PanelOverlay = styled.div<{ $isOpen: boolean }>`
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.5);
  z-index: 999;
  display: ${(p) => (p.$isOpen ? "flex" : "none")};
  justify-content: flex-end;
  animation: fadeIn 0.2s ease-in-out;

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
`;

const PanelContainer = styled.div`
  width: 520px;
  height: 100%;
  background: var(--vscode-editor-background);
  border-left: 1px solid var(--vscode-widget-border);
  display: flex;
  flex-direction: column;
  box-shadow: -2px 0 8px rgba(0, 0, 0, 0.2);
  animation: slideIn 0.2s ease-in-out;

  @keyframes slideIn {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
  }
`;

const Header = styled.div`
  padding: 16px;
  border-bottom: 1px solid var(--vscode-widget-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
`;

const Title = styled.h2`
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--vscode-foreground);
  display: flex;
  align-items: center;
  gap: 8px;
`;

const CloseButton = styled.button`
  background: none;
  border: none;
  color: var(--vscode-foreground);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  &:hover { background: var(--vscode-toolbar-hoverBackground); }
`;

const Content = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

const SessionList = styled.div`
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-widget-border);
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
`;

const SessionChip = styled.button<{ $active: boolean }>`
  background: ${(p) =>
    p.$active
      ? "var(--vscode-button-background)"
      : "var(--vscode-editorWidget-background, #252526)"};
  color: ${(p) =>
    p.$active
      ? "var(--vscode-button-foreground)"
      : "var(--vscode-foreground)"};
  border: 1px solid
    ${(p) =>
      p.$active
        ? "var(--vscode-button-background)"
        : "var(--vscode-widget-border)"};
  border-radius: 12px;
  padding: 4px 10px;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;

  &:hover {
    background: ${(p) =>
      p.$active
        ? "var(--vscode-button-hoverBackground)"
        : "var(--vscode-toolbar-hoverBackground)"};
  }
`;

const SessionMeta = styled.span`
  font-size: 10px;
  opacity: 0.7;
  margin-left: 4px;
`;

const TerminalOutput = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
  font-family: "Menlo", "Monaco", "Courier New", monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--vscode-terminal-foreground, #e0e0e0);
  background: var(--vscode-terminal-background, #1e1e1e);
  white-space: pre-wrap;
  word-break: break-all;

  &::-webkit-scrollbar { width: 6px; }
  &::-webkit-scrollbar-track { background: transparent; }
  &::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background, rgba(255, 255, 255, 0.2));
    border-radius: 3px;
  }
  &::-webkit-scrollbar-thumb:hover {
    background: var(--vscode-scrollbarSlider-hoverBackground, rgba(255, 255, 255, 0.3));
  }
`;

const EmptyState = styled.div`
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  font-size: 13px;
  padding: 24px;
  text-align: center;
`;

const ActionBar = styled.div`
  padding: 8px 12px;
  border-top: 1px solid var(--vscode-widget-border);
  display: flex;
  gap: 8px;
  align-items: center;
`;

const ActionButton = styled.button`
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  padding: 5px 10px;
  font-size: 11px;
  cursor: pointer;
  &:hover { background: var(--vscode-button-secondaryHoverBackground); }
`;

const LiveDot = styled.span`
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vscode-charts-green, #89d185);
  margin-right: 6px;
  animation: pulse 1.5s ease-in-out infinite;

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
`;

const SessionCount = styled.span`
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-left: auto;
`;

/* ─── Helpers ─── */

function formatAge(createdAt: number): string {
  const secs = Math.floor((Date.now() - createdAt) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

/* ─── Component ─── */

export function TerminalViewerPanel({ isOpen, onClose }: TerminalViewerPanelProps) {
  const {
    sessions,
    selectedSessionId,
    sessionOutput,
    isLoading,
    requestSessions,
    requestHistory,
    requestNewOutput,
    selectSession,
  } = useTerminalStore();

  const outputRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch sessions on open
  useEffect(() => {
    if (isOpen) requestSessions();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isOpen, requestSessions]);

  // Auto-scroll output to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [sessionOutput]);

  // Poll for new output when a session is selected
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (selectedSessionId && isOpen) {
      pollRef.current = setInterval(() => {
        requestNewOutput(selectedSessionId);
      }, 2000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [selectedSessionId, isOpen, requestNewOutput]);

  const handleSelectSession = useCallback(
    (id: string) => {
      selectSession(id);
      requestHistory(id);
    },
    [selectSession, requestHistory],
  );

  return (
    <PanelOverlay $isOpen={isOpen} onClick={onClose}>
      <PanelContainer onClick={(e) => e.stopPropagation()}>
        <Header>
          <Title>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            Terminal Activity
          </Title>
          <CloseButton onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 8.707l3.646 3.647.708-.708L8.707 8l3.647-3.646-.708-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z" />
            </svg>
          </CloseButton>
        </Header>

        <Content>
          {/* Session chips */}
          {sessions.length > 0 && (
            <SessionList>
              {sessions.map((s: TerminalSessionInfo) => (
                <SessionChip
                  key={s.id}
                  $active={s.id === selectedSessionId}
                  onClick={() => handleSelectSession(s.id)}
                >
                  <LiveDot />
                  {s.id}
                  <SessionMeta>({formatAge(s.createdAt)})</SessionMeta>
                </SessionChip>
              ))}
              <SessionCount>
                {sessions.length} session{sessions.length !== 1 ? "s" : ""}
              </SessionCount>
            </SessionList>
          )}

          {/* Terminal output */}
          {isLoading && !sessionOutput && (
            <EmptyState>Loading…</EmptyState>
          )}

          {!isLoading && sessions.length === 0 && (
            <EmptyState>
              No terminal sessions active. The agent will create sessions when it runs commands.
            </EmptyState>
          )}

          {sessions.length > 0 && !selectedSessionId && (
            <EmptyState>Select a session above to view its output.</EmptyState>
          )}

          {selectedSessionId && (
            <TerminalOutput ref={outputRef}>
              {sessionOutput || "(no output yet)"}
            </TerminalOutput>
          )}
        </Content>

        {/* Footer actions */}
        {selectedSessionId && (
          <ActionBar>
            <ActionButton onClick={() => requestHistory(selectedSessionId)}>
              Refresh
            </ActionButton>
            <ActionButton onClick={requestSessions}>
              Refresh Sessions
            </ActionButton>
          </ActionBar>
        )}
      </PanelContainer>
    </PanelOverlay>
  );
}
