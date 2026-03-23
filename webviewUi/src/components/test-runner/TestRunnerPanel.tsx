import styled from "styled-components";
import { useTestRunnerStore } from "../../stores/testRunner.store";
import type { TestFailureInfo } from "../../stores/testRunner.store";

interface TestRunnerPanelProps {
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
  width: 460px;
  max-width: 100%;
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
  overflow-y: auto;
  padding: 16px;
`;

const SummaryCard = styled.div<{ $success: boolean }>`
  padding: 16px;
  border-radius: 8px;
  border: 1px solid ${(p) =>
    p.$success
      ? "var(--vscode-charts-green, #89d185)"
      : "var(--vscode-charts-red, #f48771)"};
  background: ${(p) =>
    p.$success ? "rgba(137,209,133,0.08)" : "rgba(244,135,113,0.08)"};
  margin-bottom: 16px;
`;

const SummaryRow = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
`;

const Stat = styled.div<{ $color?: string }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
`;

const StatValue = styled.span<{ $color?: string }>`
  font-size: 22px;
  font-weight: 700;
  color: ${(p) => p.$color ?? "var(--vscode-foreground)"};
`;

const StatLabel = styled.span`
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--vscode-descriptionForeground);
`;

const Meta = styled.div`
  margin-top: 12px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
`;

const FailureList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
`;

const FailureCard = styled.div`
  padding: 12px;
  border-radius: 6px;
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-widget-border);
`;

const FailureName = styled.div`
  font-weight: 600;
  font-size: 12px;
  color: var(--vscode-foreground);
  margin-bottom: 4px;
`;

const FailureFile = styled.div`
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 6px;
`;

const FailureMessage = styled.pre`
  font-size: 11px;
  font-family: "Menlo", "Monaco", "Courier New", monospace;
  color: var(--vscode-charts-red, #f48771);
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  max-height: 120px;
  overflow-y: auto;
`;

const SectionTitle = styled.h3`
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
  margin: 0 0 10px 0;
  text-transform: uppercase;
  letter-spacing: 0.5px;
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
  padding: 12px 16px;
  border-top: 1px solid var(--vscode-widget-border);
  display: flex;
  gap: 8px;
`;

const RunButton = styled.button<{ $running?: boolean }>`
  flex: 1;
  background: ${(p) =>
    p.$running
      ? "var(--vscode-button-secondaryBackground)"
      : "rgba(255, 255, 255, 0.08)"};
  color: ${(p) =>
    p.$running
      ? "var(--vscode-button-secondaryForeground)"
      : "var(--vscode-foreground)"};
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 500;
  cursor: ${(p) => (p.$running ? "default" : "pointer")};
  opacity: ${(p) => (p.$running ? 0.7 : 1)};
  &:hover {
    background: ${(p) =>
      p.$running
        ? "var(--vscode-button-secondaryBackground)"
        : "rgba(255, 255, 255, 0.14)"};
  }
`;

const ErrorBanner = styled.div`
  padding: 10px 14px;
  border-radius: 6px;
  font-size: 11px;
  font-family: "Menlo", "Monaco", "Courier New", monospace;
  background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
  color: var(--vscode-errorForeground, #f48771);
  margin-bottom: 16px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
`;

const Spinner = styled.div`
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--vscode-foreground);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-right: 8px;

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
`;

/* ─── Component ─── */

const TestIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
    <polyline points="14 2 14 8 20 8" />
    <path d="m9 15 2 2 4-4" />
  </svg>
);

export function TestRunnerPanel({ isOpen, onClose }: TestRunnerPanelProps) {
  const { isRunning, result, error, runTests, clear } = useTestRunnerStore();

  return (
    <PanelOverlay $isOpen={isOpen} onClick={onClose}>
      <PanelContainer onClick={(e) => e.stopPropagation()}>
        <Header>
          <Title>
            <TestIcon />
            Test Runner
          </Title>
          <CloseButton onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 8.707l3.646 3.647.708-.708L8.707 8l3.647-3.646-.708-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z" />
            </svg>
          </CloseButton>
        </Header>

        <Content>
          {error && <ErrorBanner>{error}</ErrorBanner>}

          {isRunning && (
            <EmptyState>
              <div>
                <Spinner />
                Running tests…
              </div>
            </EmptyState>
          )}

          {!isRunning && !result && !error && (
            <EmptyState>
              Click "Run Tests" to detect your test framework and execute your test suite.
            </EmptyState>
          )}

          {!isRunning && result && (
            <>
              <SummaryCard $success={result.success}>
                <SummaryRow>
                  <Stat>
                    <StatValue $color="var(--vscode-charts-green, #89d185)">
                      {result.passed}
                    </StatValue>
                    <StatLabel>Passed</StatLabel>
                  </Stat>
                  <Stat>
                    <StatValue $color="var(--vscode-charts-red, #f48771)">
                      {result.failed}
                    </StatValue>
                    <StatLabel>Failed</StatLabel>
                  </Stat>
                  <Stat>
                    <StatValue $color="var(--vscode-charts-yellow, #e0af68)">
                      {result.skipped}
                    </StatValue>
                    <StatLabel>Skipped</StatLabel>
                  </Stat>
                  <Stat>
                    <StatValue>{result.total}</StatValue>
                    <StatLabel>Total</StatLabel>
                  </Stat>
                </SummaryRow>
                <Meta>
                  <span>Framework: {result.framework}</span>
                  <span>Duration: {result.duration}</span>
                </Meta>
                {result.parseWarning && (
                  <Meta>
                    <span style={{ color: "var(--vscode-charts-yellow, #e0af68)" }}>
                      ⚠ {result.parseWarning}
                    </span>
                  </Meta>
                )}
              </SummaryCard>

              {result.failures.length > 0 && (
                <>
                  <SectionTitle>Failures ({result.failures.length})</SectionTitle>
                  <FailureList>
                    {result.failures.map((f: TestFailureInfo, i: number) => (
                      <FailureCard key={i}>
                        <FailureName>{f.testName}</FailureName>
                        {f.file && <FailureFile>{f.file}</FailureFile>}
                        <FailureMessage>{f.message}</FailureMessage>
                      </FailureCard>
                    ))}
                  </FailureList>
                </>
              )}
            </>
          )}
        </Content>

        <ActionBar>
          <RunButton
            $running={isRunning}
            onClick={() => !isRunning && runTests()}
            disabled={isRunning}
          >
            {isRunning ? "Running…" : "Run Tests"}
          </RunButton>
          {result && (
            <RunButton $running={false} onClick={clear}>
              Clear
            </RunButton>
          )}
        </ActionBar>
      </PanelContainer>
    </PanelOverlay>
  );
}
