import React, { useMemo, useState } from "react";
import styled, { keyframes } from "styled-components";
import { sanitizeText } from "../../utils/sanitize";

/* ─── Types (canonical definitions in src/shared/standup.types.ts) ─── */
/* Re-exported here so existing imports from MessageRenderer keep working. */

export type {
  StandupCommitment,
  StandupBlocker,
  StandupDecision,
  StandupTicketMention,
  StandupCardData,
} from "../../../../src/shared/standup.types";

import type { StandupCardData } from "../../../../src/shared/standup.types";

interface StandupCardProps {
  data: StandupCardData;
  onToggleCommitment?: (index: number, done: boolean) => void;
}

/* ─── Animations ─── */

const fadeIn = keyframes`
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
`;

/* ─── Styled Components ─── */

const Card = styled.div`
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
  border-radius: 8px;
  padding: 16px;
  margin: 8px 0;
  animation: ${fadeIn} 0.3s ease-out;
`;

const CardHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
`;

const HeaderLeft = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

const HeaderIcon = styled.span`
  font-size: 16px;
`;

const HeaderTitle = styled.span`
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-foreground);
`;

const DateBadge = styled.span`
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-textBlockQuote-background, rgba(128, 128, 128, 0.1));
  padding: 2px 8px;
  border-radius: 10px;
`;

const TeamBadge = styled.span`
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
`;

const SectionHeader = styled.div`
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--vscode-descriptionForeground);
  margin: 14px 0 8px;
  display: flex;
  align-items: center;
  gap: 6px;
`;

const SectionIcon = styled.span`
  font-size: 12px;
`;

const CommitmentRow = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.08));
  margin-bottom: 4px;
  transition: background 0.15s ease;

  &:hover {
    background: var(
      --vscode-list-activeSelectionBackground,
      rgba(128, 128, 128, 0.12)
    );
  }
`;

const Checkbox = styled.button<{ $done: boolean }>`
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  border: 1.5px solid
    ${(p) =>
      p.$done
        ? "var(--vscode-testing-iconPassed, #73c991)"
        : "var(--vscode-descriptionForeground)"};
  background: ${(p) =>
    p.$done
      ? "var(--vscode-testing-iconPassed, #73c991)"
      : "transparent"};
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 2px;
  padding: 0;
  transition: all 0.15s ease;
  color: white;
  font-size: 10px;

  &:hover {
    border-color: var(--vscode-focusBorder);
  }
`;

const CommitmentText = styled.span<{ $done: boolean }>`
  font-size: 12px;
  color: var(--vscode-foreground);
  line-height: 1.4;
  text-decoration: ${(p) => (p.$done ? "line-through" : "none")};
  opacity: ${(p) => (p.$done ? 0.6 : 1)};
`;

const DeadlineTag = styled.span`
  font-size: 10px;
  color: var(--vscode-editorWarning-foreground, #cca700);
  background: rgba(204, 167, 0, 0.1);
  padding: 1px 6px;
  border-radius: 8px;
  white-space: nowrap;
`;

const TicketTag = styled.span`
  font-size: 10px;
  color: var(--vscode-textLink-foreground);
  background: rgba(0, 122, 204, 0.1);
  padding: 1px 6px;
  border-radius: 8px;
  white-space: nowrap;
  cursor: pointer;

  &:hover {
    background: rgba(0, 122, 204, 0.2);
  }
`;

const BlockerRow = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(255, 85, 85, 0.06);
  border-left: 3px solid var(--vscode-editorError-foreground, #f14c4c);
  margin-bottom: 4px;
`;

const BlockerText = styled.div`
  font-size: 12px;
  color: var(--vscode-foreground);
  line-height: 1.4;
`;

const BlockerMeta = styled.span`
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
`;

const DecisionRow = styled.div`
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--vscode-textBlockQuote-background, rgba(128, 128, 128, 0.1));
  border-left: 3px solid
    var(--vscode-symbolIcon-functionForeground, #b180d7);
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--vscode-foreground);
  line-height: 1.4;
`;

const TicketRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  font-size: 12px;
`;

const TicketId = styled.span`
  font-weight: 500;
  color: var(--vscode-textLink-foreground);
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }
`;

const TicketContext = styled.span`
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
`;

const ParticipantsList = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
`;

const ParticipantChip = styled.span`
  font-size: 11px;
  color: var(--vscode-foreground);
  background: var(--vscode-textBlockQuote-background, rgba(128, 128, 128, 0.1));
  padding: 2px 8px;
  border-radius: 10px;
`;

const PersonGroup = styled.div`
  margin-bottom: 6px;
`;

const PersonName = styled.span`
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
`;

const PersonActions = styled.span`
  font-size: 12px;
  color: var(--vscode-foreground);
  margin-left: 4px;
`;

const ExpandButton = styled.button`
  background: none;
  border: none;
  color: var(--vscode-textLink-foreground);
  font-size: 12px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: background 0.15s ease;

  &:hover {
    background: var(--vscode-list-hoverBackground);
  }
`;

/* ─── Component ─── */

const StandupCard: React.FC<StandupCardProps> = ({
  data,
  onToggleCommitment,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [localStatuses, setLocalStatuses] = useState<Record<string, boolean>>(
    {},
  );

  // ── Sanitize LLM-derived content at the trust boundary (Issue 1) ──
  const safeData = useMemo(() => ({
    ...data,
    participants: data.participants.map(p => sanitizeText(p, 100)),
    myCommitments: data.myCommitments.map(c => ({
      ...c,
      person: sanitizeText(c.person, 100),
      action: sanitizeText(c.action),
      deadline: c.deadline ? sanitizeText(c.deadline, 100) : c.deadline,
    })),
    otherCommitments: data.otherCommitments.map(c => ({
      ...c,
      person: sanitizeText(c.person, 100),
      action: sanitizeText(c.action),
    })),
    blockers: data.blockers.map(b => ({
      blocked: sanitizeText(b.blocked),
      blockedBy: sanitizeText(b.blockedBy),
      owner: sanitizeText(b.owner),
      reason: sanitizeText(b.reason),
    })),
    decisions: data.decisions.map(d => ({
      ...d,
      summary: sanitizeText(d.summary, 300),
    })),
    ticketMentions: data.ticketMentions.map(t => ({
      ...t,
      id: sanitizeText(t.id, 20),
      context: sanitizeText(t.context, 200),
      assignee: t.assignee ? sanitizeText(t.assignee, 100) : t.assignee,
    })),
  }), [data]);

  /** Stable keys for commitments, blockers, and decisions. */
  const stableKey = (prefix: string, text: string, index: number) =>
    `${prefix}-${text.slice(0, 40)}-${index}`;

  const commitmentKeys = useMemo(
    () =>
      safeData.myCommitments.map((c, i) =>
        stableKey("mc", c.action, i),
      ),
    [safeData.myCommitments],
  );

  const handleToggle = (index: number) => {
    const key = commitmentKeys[index];
    const current = localStatuses[key] ?? safeData.myCommitments[index]?.status === "done";
    setLocalStatuses((prev) => ({ ...prev, [key]: !current }));
    onToggleCommitment?.(index, !current);
  };

  const isDone = (index: number) =>
    localStatuses[commitmentKeys[index]] ?? safeData.myCommitments[index]?.status === "done";

  // Group other commitments by person (memoized — Issue 15)
  const byPerson = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const c of safeData.otherCommitments) {
      const actions = map.get(c.person) ?? [];
      actions.push(c.action);
      map.set(c.person, actions);
    }
    return map;
  }, [safeData.otherCommitments]);

  const visibleOthers = expanded
    ? [...byPerson.entries()]
    : [...byPerson.entries()].slice(0, 3);

  return (
    <Card>
      {/* Header */}
      <CardHeader>
        <HeaderLeft>
          <HeaderIcon>📋</HeaderIcon>
          <HeaderTitle>Standup Summary</HeaderTitle>
          <TeamBadge>{safeData.teamName}</TeamBadge>
        </HeaderLeft>
        <DateBadge>{safeData.date}</DateBadge>
      </CardHeader>

      {/* Participants */}
      <ParticipantsList>
        {safeData.participants.map((p) => (
          <ParticipantChip key={p}>{p}</ParticipantChip>
        ))}
      </ParticipantsList>

      {/* My Action Items */}
      {safeData.myCommitments.length > 0 && (
        <>
          <SectionHeader>
            <SectionIcon>✅</SectionIcon>
            Your Action Items ({safeData.myCommitments.length})
          </SectionHeader>
          {safeData.myCommitments.map((c, i) => (
            <CommitmentRow key={commitmentKeys[i]}>
              <Checkbox
                $done={isDone(i)}
                onClick={() => handleToggle(i)}
                aria-label={isDone(i) ? "Mark undone" : "Mark done"}
              >
                {isDone(i) && "✓"}
              </Checkbox>
              <div>
                <CommitmentText $done={isDone(i)}>{c.action}</CommitmentText>
                <div style={{ display: "flex", gap: 4, marginTop: 3 }}>
                  {c.deadline && <DeadlineTag>⏰ {c.deadline}</DeadlineTag>}
                  {c.ticketIds.map((tid) => (
                    <TicketTag key={tid}>#{tid}</TicketTag>
                  ))}
                </div>
              </div>
            </CommitmentRow>
          ))}
        </>
      )}

      {/* Blockers */}
      {safeData.blockers.length > 0 && (
        <>
          <SectionHeader>
            <SectionIcon>🔴</SectionIcon>
            Blockers ({safeData.blockers.length})
          </SectionHeader>
          {safeData.blockers.map((b, i) => (
            <BlockerRow key={stableKey("bl", b.blocked + b.blockedBy, i)}>
              <div>
                <BlockerText>
                  <strong>{b.blocked}</strong> → blocked by{" "}
                  <strong>{b.blockedBy}</strong>
                </BlockerText>
                <BlockerMeta>
                  {b.reason} · Owner: {b.owner}
                </BlockerMeta>
              </div>
            </BlockerRow>
          ))}
        </>
      )}

      {/* Decisions */}
      {safeData.decisions.length > 0 && (
        <>
          <SectionHeader>
            <SectionIcon>🤝</SectionIcon>
            Key Decisions ({safeData.decisions.length})
          </SectionHeader>
          {safeData.decisions.map((d, i) => (
            <DecisionRow key={stableKey("dc", d.summary, i)}>{d.summary}</DecisionRow>
          ))}
        </>
      )}

      {/* Team Commitments */}
      {byPerson.size > 0 && (
        <>
          <SectionHeader>
            <SectionIcon>👥</SectionIcon>
            Team Commitments ({safeData.otherCommitments.length})
          </SectionHeader>
          {visibleOthers.map(([person, actions]) => (
            <PersonGroup key={person}>
              <PersonName>{person}:</PersonName>
              <PersonActions>{actions.join("; ")}</PersonActions>
            </PersonGroup>
          ))}
          {byPerson.size > 3 && (
            <ExpandButton onClick={() => setExpanded(!expanded)}>
              {expanded
                ? "Show less"
                : `Show ${byPerson.size - 3} more team members`}
            </ExpandButton>
          )}
        </>
      )}

      {/* Tickets Referenced */}
      {safeData.ticketMentions.length > 0 && (
        <>
          <SectionHeader>
            <SectionIcon>🎫</SectionIcon>
            Tickets Referenced ({safeData.ticketMentions.length})
          </SectionHeader>
          {safeData.ticketMentions.map((t) => (
            <TicketRow key={t.id}>
              <TicketId>#{t.id}</TicketId>
              <TicketContext>
                {t.context}
                {t.assignee && ` (${t.assignee})`}
              </TicketContext>
            </TicketRow>
          ))}
        </>
      )}
    </Card>
  );
};

export default StandupCard;
