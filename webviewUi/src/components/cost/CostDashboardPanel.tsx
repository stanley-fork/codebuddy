import { useEffect } from "react";
import styled from "styled-components";
import { useCostStore } from "../../stores/cost.store";
import type { ProviderBreakdown, ConversationCostEntry } from "../../stores/cost.store";

interface CostDashboardProps {
  isOpen: boolean;
  onClose: () => void;
}

/* ─── Helpers ─── */

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${(count / 1_000).toFixed(1)}k`;
  return count.toLocaleString();
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
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
  width: 420px;
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

const Section = styled.div`
  margin-bottom: 20px;
`;

const SectionTitle = styled.h3`
  margin: 0 0 10px 0;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--vscode-descriptionForeground);
`;

const StatsGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
`;

const StatCard = styled.div`
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-widget-border);
  border-radius: 6px;
  padding: 12px;
`;

const StatValue = styled.div`
  font-size: 20px;
  font-weight: 700;
  color: var(--vscode-foreground);
  margin-bottom: 2px;
`;

const CostValue = styled(StatValue)`
  color: var(--vscode-charts-green, #89d185);
`;

const StatLabel = styled.div`
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
`;

const ProviderRow = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-widget-border);
  margin-bottom: 6px;
`;

const ProviderName = styled.span`
  font-weight: 600;
  font-size: 12px;
  color: var(--vscode-foreground);
  min-width: 80px;
`;

const ProviderStat = styled.span`
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
`;

const ProviderCost = styled.span`
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-charts-green, #89d185);
  margin-left: auto;
`;

const ConversationRow = styled.div`
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-widget-border);
  margin-bottom: 6px;
`;

const ConvHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
`;

const ConvModel = styled.span`
  font-size: 12px;
  font-weight: 500;
  color: var(--vscode-foreground);
`;

const ConvCost = styled.span`
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-charts-green, #89d185);
`;

const ConvMeta = styled.div`
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  display: flex;
  gap: 8px;
`;

const EmptyState = styled.div`
  text-align: center;
  padding: 40px 16px;
  color: var(--vscode-descriptionForeground);
  font-size: 13px;
`;

const ActionBar = styled.div`
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
`;

const ActionButton = styled.button`
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  padding: 6px 12px;
  font-size: 11px;
  cursor: pointer;
  &:hover { background: var(--vscode-button-secondaryHoverBackground); }
`;

const ResetButton = styled(ActionButton)`
  color: var(--vscode-errorForeground, #f48771);
`;

/* ─── Component ─── */

export function CostDashboardPanel({ isOpen, onClose }: CostDashboardProps) {
  const { totals, providers, conversations, isLoading, requestSummary, requestReset } = useCostStore();

  useEffect(() => {
    if (isOpen) requestSummary();
  }, [isOpen, requestSummary]);

  const handleReset = () => {
    if (confirm("Reset all cost tracking data?")) {
      requestReset();
    }
  };

  return (
    <PanelOverlay $isOpen={isOpen} onClick={onClose}>
      <PanelContainer onClick={(e) => e.stopPropagation()}>
        <Header>
          <Title>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a7 7 0 110 14A7 7 0 018 1zm0 1.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM8 4a.75.75 0 01.75.75v2.5h2.5a.75.75 0 010 1.5h-2.5v2.5a.75.75 0 01-1.5 0v-2.5h-2.5a.75.75 0 010-1.5h2.5v-2.5A.75.75 0 018 4z" />
            </svg>
            Cost Dashboard
          </Title>
          <CloseButton onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 8.707l3.646 3.647.708-.708L8.707 8l3.647-3.646-.708-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z" />
            </svg>
          </CloseButton>
        </Header>

        <Content>
          {isLoading && <EmptyState>Loading…</EmptyState>}

          {!isLoading && !totals && (
            <EmptyState>
              No cost data yet. Start a conversation to begin tracking.
            </EmptyState>
          )}

          {!isLoading && totals && (
            <>
              <ActionBar>
                <ActionButton onClick={requestSummary}>Refresh</ActionButton>
                <ResetButton onClick={handleReset}>Reset All</ResetButton>
              </ActionBar>

              {/* Totals */}
              <Section>
                <SectionTitle>Session Totals</SectionTitle>
                <StatsGrid>
                  <StatCard>
                    <CostValue>{formatCost(totals.estimatedCostUSD)}</CostValue>
                    <StatLabel>Estimated Cost</StatLabel>
                  </StatCard>
                  <StatCard>
                    <StatValue>{formatTokens(totals.totalTokens)}</StatValue>
                    <StatLabel>Total Tokens</StatLabel>
                  </StatCard>
                  <StatCard>
                    <StatValue>{totals.requestCount}</StatValue>
                    <StatLabel>Requests</StatLabel>
                  </StatCard>
                  <StatCard>
                    <StatValue>{totals.conversationCount}</StatValue>
                    <StatLabel>Conversations</StatLabel>
                  </StatCard>
                </StatsGrid>
              </Section>

              {/* Token Breakdown */}
              <Section>
                <SectionTitle>Token Breakdown</SectionTitle>
                <StatsGrid>
                  <StatCard>
                    <StatValue>{formatTokens(totals.inputTokens)}</StatValue>
                    <StatLabel>Input Tokens</StatLabel>
                  </StatCard>
                  <StatCard>
                    <StatValue>{formatTokens(totals.outputTokens)}</StatValue>
                    <StatLabel>Output Tokens</StatLabel>
                  </StatCard>
                </StatsGrid>
              </Section>

              {/* Provider Breakdown */}
              {providers.length > 0 && (
                <Section>
                  <SectionTitle>By Provider</SectionTitle>
                  {providers.map((p: ProviderBreakdown) => (
                    <ProviderRow key={p.provider}>
                      <ProviderName>{p.provider}</ProviderName>
                      <ProviderStat>{formatTokens(p.totalTokens)} tokens</ProviderStat>
                      <ProviderStat>{p.requestCount} req</ProviderStat>
                      <ProviderCost>{formatCost(p.estimatedCostUSD)}</ProviderCost>
                    </ProviderRow>
                  ))}
                </Section>
              )}

              {/* Per-conversation history */}
              {conversations.length > 0 && (
                <Section>
                  <SectionTitle>Conversations</SectionTitle>
                  {conversations.map((c: ConversationCostEntry) => (
                    <ConversationRow key={c.threadId}>
                      <ConvHeader>
                        <ConvModel>{c.model}</ConvModel>
                        <ConvCost>{formatCost(c.estimatedCostUSD)}</ConvCost>
                      </ConvHeader>
                      <ConvMeta>
                        <span>{formatTokens(c.totalTokens)} tokens</span>
                        <span>{c.requestCount} requests</span>
                        <span>{c.provider}</span>
                      </ConvMeta>
                    </ConversationRow>
                  ))}
                </Section>
              )}
            </>
          )}
        </Content>
      </PanelContainer>
    </PanelOverlay>
  );
}
