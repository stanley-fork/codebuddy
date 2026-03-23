import React, { useEffect, useState } from "react";
import styled from "styled-components";
import { useTeamStore } from "../../stores/team.store";
import { useStandupStore } from "../../stores/standup.store";
import type { TeamRelationshipEdge } from "../../stores/team.store";

interface TeamPanelProps {
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

  &:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
`;

const Content = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 16px;

  &::-webkit-scrollbar {
    width: 10px;
  }
  &::-webkit-scrollbar-track {
    background: transparent;
  }
  &::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 5px;
    border: 2px solid var(--vscode-editor-background);
  }
`;

const Section = styled.div`
  margin-bottom: 20px;
`;

const SectionTitle = styled.h3`
  margin: 0 0 12px 0;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--vscode-descriptionForeground);
`;

const EmptyState = styled.div`
  text-align: center;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  padding: 24px 16px;
  line-height: 1.5;
`;

const ErrorText = styled.div`
  color: var(--vscode-editorError-foreground, #f14c4c);
  font-size: 11px;
  margin-top: 4px;
`;

const SectionDescription = styled.div`
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.4;
  margin-bottom: 8px;
`;

/* ── Meeting Intelligence Styled Components ── */

const NotesTextArea = styled.textarea`
  width: 100%;
  min-height: 80px;
  max-height: 200px;
  resize: vertical;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.12));
  border-radius: 4px;
  padding: 8px;
  font-size: 12px;
  font-family: var(--vscode-font-family);
  line-height: 1.4;
  box-sizing: border-box;

  &::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }

  &:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
  }
`;

const IngestButton = styled.button<{ $loading?: boolean }>`
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 4px;
  padding: 6px 14px;
  cursor: ${(p) => (p.$loading ? "wait" : "pointer")};
  font-size: 12px;
  font-weight: 500;
  width: 100%;
  margin-top: 8px;
  opacity: ${(p) => (p.$loading ? 0.7 : 1)};
  transition: all 0.15s ease;

  &:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const QuickActions = styled.div`
  display: flex;
  gap: 6px;
  margin-top: 10px;
  flex-wrap: wrap;
`;

const QuickActionButton = styled.button`
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  padding: 4px 10px;
  cursor: pointer;
  color: var(--vscode-foreground);
  font-size: 11px;
  white-space: nowrap;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 4px;

  &:hover {
    background: rgba(255, 255, 255, 0.14);
    border-color: rgba(255, 255, 255, 0.2);
  }

  &:active {
    transform: scale(0.97);
  }
`;

const RecentList = styled.div`
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const RecentItem = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.08));
  font-size: 11px;
`;

const RecentDate = styled.span`
  color: var(--vscode-foreground);
  font-weight: 500;
`;

const RecentMeta = styled.span`
  color: var(--vscode-descriptionForeground);
`;

const DeleteButton = styled.button`
  background: none;
  border: none;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  padding: 2px 4px;
  font-size: 12px;
  border-radius: 3px;
  opacity: 0;
  transition: opacity 0.15s ease, color 0.15s ease;

  ${RecentItem}:hover & {
    opacity: 1;
  }

  &:hover {
    color: var(--vscode-editorError-foreground, #f14c4c);
    background: rgba(241, 76, 76, 0.1);
  }
`;

const StandupErrorText = styled.div`
  color: var(--vscode-editorError-foreground, #f14c4c);
  font-size: 11px;
  margin-top: 4px;
`;

/* ── Health Stats Card ── */

const HealthGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
`;

const StatCard = styled.div`
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  padding: 10px;
  text-align: center;
`;

const StatValue = styled.div`
  font-size: 18px;
  font-weight: 700;
  color: var(--vscode-foreground);
`;

const StatLabel = styled.div`
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  margin-top: 2px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
`;

/* ── Member List ── */

const MemberCard = styled.div<{ $selected?: boolean }>`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  background: ${(p) =>
    p.$selected
      ? "rgba(0, 122, 204, 0.15)"
      : "rgba(255, 255, 255, 0.03)"};
  border: 1px solid ${(p) =>
    p.$selected
      ? "rgba(0, 122, 204, 0.4)"
      : "rgba(255, 255, 255, 0.06)"};
  margin-bottom: 4px;
  transition: all 0.15s ease;

  &:hover {
    background: ${(p) =>
      p.$selected
        ? "rgba(0, 122, 204, 0.2)"
        : "rgba(255, 255, 255, 0.06)"};
    border-color: rgba(255, 255, 255, 0.12);
  }
`;

const Avatar = styled.div<{ $hue: number }>`
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: hsla(${(p) => p.$hue}, 60%, 45%, 0.25);
  border: 1px solid hsla(${(p) => p.$hue}, 60%, 50%, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: hsla(${(p) => p.$hue}, 60%, 75%, 1);
  flex-shrink: 0;
`;

const MemberInfo = styled.div`
  flex: 1;
  min-width: 0;
`;

const MemberName = styled.div`
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const MemberMeta = styled.div`
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  margin-top: 1px;
`;

const CompletionBadge = styled.span<{ $rate: number }>`
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 10px;
  background: ${(p) =>
    p.$rate >= 80
      ? "rgba(40, 167, 69, 0.2)"
      : p.$rate >= 50
        ? "rgba(255, 193, 7, 0.2)"
        : "rgba(220, 53, 69, 0.2)"};
  color: ${(p) =>
    p.$rate >= 80
      ? "#28a745"
      : p.$rate >= 50
        ? "#ffc107"
        : "#dc3545"};
`;

/* ── Relationship Graph (simple list view) ── */

const EdgeRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  font-size: 11px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);

  &:last-child {
    border-bottom: none;
  }
`;

const EdgeKind = styled.span<{ $kind: string }>`
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 8px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  background: ${(p) => {
    switch (p.$kind) {
      case "collaborates_with": return "rgba(0, 122, 204, 0.15)";
      case "blocks": return "rgba(220, 53, 69, 0.15)";
      case "reviews_for": return "rgba(40, 167, 69, 0.15)";
      case "reports_to": return "rgba(255, 193, 7, 0.15)";
      case "mentors": return "rgba(156, 39, 176, 0.15)";
      case "depends_on": return "rgba(255, 152, 0, 0.15)";
      default: return "rgba(255, 255, 255, 0.08)";
    }
  }};
  color: ${(p) => {
    switch (p.$kind) {
      case "collaborates_with": return "#4fc3f7";
      case "blocks": return "#ef5350";
      case "reviews_for": return "#66bb6a";
      case "reports_to": return "#ffc107";
      case "mentors": return "#ce93d8";
      case "depends_on": return "#ffb74d";
      default: return "var(--vscode-descriptionForeground)";
    }
  }};
`;

const WeightBadge = styled.span`
  font-size: 9px;
  color: var(--vscode-descriptionForeground);
  margin-left: auto;
`;

/* ── Person Detail ── */

const DetailHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
`;

const DetailAvatar = styled(Avatar)`
  width: 42px;
  height: 42px;
  font-size: 16px;
`;

const DetailName = styled.div`
  font-size: 15px;
  font-weight: 600;
  color: var(--vscode-foreground);
`;

const DetailRole = styled.div`
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
`;

const DetailStats = styled.div`
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 12px;
`;

const Tag = styled.span`
  display: inline-block;
  font-size: 10px;
  background: rgba(0, 122, 204, 0.12);
  color: var(--vscode-textLink-foreground, #4fc3f7);
  padding: 2px 6px;
  border-radius: 4px;
  margin-right: 4px;
  margin-bottom: 4px;
`;

const CommitmentRow = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 4px 0;
  font-size: 12px;
  color: var(--vscode-foreground);
  line-height: 1.4;
`;

const CommitmentDate = styled.span`
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  flex-shrink: 0;
`;

const BackButton = styled.button`
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  padding: 4px 10px;
  cursor: pointer;
  color: var(--vscode-foreground);
  font-size: 11px;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 12px;

  &:hover {
    background: rgba(255, 255, 255, 0.14);
    border-color: rgba(255, 255, 255, 0.2);
  }
`;

const TabRow = styled.div`
  display: flex;
  gap: 2px;
  margin-bottom: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
`;

const Tab = styled.button<{ $active: boolean }>`
  background: none;
  border: none;
  border-bottom: 2px solid ${(p) =>
    p.$active ? "var(--vscode-textLink-foreground, #4fc3f7)" : "transparent"};
  color: ${(p) =>
    p.$active ? "var(--vscode-foreground)" : "var(--vscode-descriptionForeground)"};
  padding: 6px 12px;
  font-size: 11px;
  font-weight: ${(p) => (p.$active ? 600 : 400)};
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover {
    color: var(--vscode-foreground);
  }
`;

const CollabRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 0;
  font-size: 12px;
  color: var(--vscode-foreground);
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);

  &:last-child {
    border-bottom: none;
  }
`;

/* ─── Helpers ─── */

function nameToHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash % 360);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatKind(kind: string): string {
  return kind.replace(/_/g, " ");
}

type PanelTab = "members" | "graph" | "blockers";

/* ─── PersonDetailView ─── */

const PersonDetailView: React.FC<{
  onBack: () => void;
}> = ({ onBack }) => {
  const selectedPerson = useTeamStore((s) => s.selectedPerson);
  const personCommitments = useTeamStore((s) => s.personCommitments);
  const requestCommitments = useTeamStore((s) => s.requestCommitments);
  const requestPersonProfile = useTeamStore((s) => s.requestPersonProfile);

  const member = selectedPerson?.member;

  useEffect(() => {
    if (member?.name) {
      requestCommitments(member.name);
    }
  }, [member?.name, requestCommitments]);

  if (!member) return null;

  const hue = nameToHue(member.name);

  return (
    <>
      <BackButton onClick={onBack}>← Back to Team</BackButton>
      <DetailHeader>
        <DetailAvatar $hue={hue}>{initials(member.name)}</DetailAvatar>
        <div>
          <DetailName>{member.name}</DetailName>
          <DetailRole>
            {member.role || "No role detected"}
            {member.workStyle && ` · ${member.workStyle}`}
          </DetailRole>
        </div>
      </DetailHeader>

      <DetailStats>
        <span>{member.standupCount} standups</span>
        <span>{member.commitmentCount} commitments</span>
        <CompletionBadge $rate={member.completionRate}>
          {member.completionRate}% done
        </CompletionBadge>
      </DetailStats>

      {member.expertise.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {member.expertise.map((e) => (
            <Tag key={e}>{e}</Tag>
          ))}
        </div>
      )}

      {/* Commitments */}
      {personCommitments.length > 0 && (
        <Section>
          <SectionTitle>Recent Commitments</SectionTitle>
          {personCommitments.map((c, i) => (
            <CommitmentRow key={i}>
              <span>{c.status === "done" ? "✅" : "⬜"}</span>
              <span style={{ flex: 1 }}>{c.action}</span>
              <CommitmentDate>{c.date}</CommitmentDate>
            </CommitmentRow>
          ))}
        </Section>
      )}

      {/* Collaborators */}
      {selectedPerson?.collaborators && selectedPerson.collaborators.length > 0 && (
        <Section>
          <SectionTitle>Top Collaborators</SectionTitle>
          {selectedPerson.collaborators.map((c, i) => (
            <CollabRow key={i}>
              <span
                style={{ cursor: "pointer" }}
                onClick={() => requestPersonProfile(c.name)}
              >
                {c.name}
              </span>
              <span style={{ fontSize: 10, color: "var(--vscode-descriptionForeground)" }}>
                {c.weight} meetings
              </span>
            </CollabRow>
          ))}
        </Section>
      )}
    </>
  );
};

/* ─── Main Component ─── */

export const TeamPanel: React.FC<TeamPanelProps> = ({ isOpen, onClose }) => {
  const {
    members,
    edges,
    blockersMarkdown,
    isLoading,
    lastError,
    selectedPerson,
    hydrate,
    requestPersonProfile,
    requestRecurringBlockers,
    clearSelectedPerson,
  } = useTeamStore();

  // Meeting Intelligence state
  const [notesInput, setNotesInput] = useState("");
  const {
    isIngesting,
    lastError: standupError,
    recentStandups,
    ingestNotes,
    requestMyTasks,
    requestBlockers,
    requestHistory,
    deleteStandup,
    deletingKey,
    hydrate: hydrateStandups,
  } = useStandupStore();

  const handleIngest = () => {
    if (!notesInput.trim() || isIngesting) return;
    ingestNotes(notesInput.trim());
    setNotesInput("");
  };

  const [activeTab, setActiveTab] = useState<PanelTab>("members");

  // Hydrate on first open
  useEffect(() => {
    if (isOpen && members.length === 0) hydrate();
  }, [isOpen, members.length, hydrate]);

  // Rehydrate recent standups from backend when panel opens
  useEffect(() => {
    if (isOpen && recentStandups.length === 0) hydrateStandups();
  }, [isOpen, recentStandups.length, hydrateStandups]);

  // Request blockers when switching to that tab
  useEffect(() => {
    if (activeTab === "blockers" && !blockersMarkdown) {
      requestRecurringBlockers();
    }
  }, [activeTab, blockersMarkdown, requestRecurringBlockers]);

  // Structured health stats from the extension (no markdown parsing needed)
  const healthStats = useTeamStore((s) => s.healthStats);

  // Group edges by kind for the graph tab
  const edgesByKind = React.useMemo(() => {
    const grouped: Record<string, TeamRelationshipEdge[]> = {};
    for (const edge of edges) {
      (grouped[edge.kind] ??= []).push(edge);
    }
    // Sort each group by weight desc
    for (const kind of Object.keys(grouped)) {
      grouped[kind].sort((a, b) => b.weight - a.weight);
    }
    return grouped;
  }, [edges]);

  return (
    <PanelOverlay $isOpen={isOpen} onClick={onClose}>
      <PanelContainer onClick={(e) => e.stopPropagation()}>
        <Header>
          <Title>
            <TeamIcon />
            Team Graph
          </Title>
          <CloseButton onClick={onClose} aria-label="Close team panel">
            <span className="codicon codicon-close"></span>
          </CloseButton>
        </Header>
        <Content>
          {lastError && <ErrorText>{lastError}</ErrorText>}

          {/* ── Meeting Intelligence Section ── */}
          <Section>
            <SectionTitle>Meeting Intelligence</SectionTitle>
            <SectionDescription>
              Paste meeting or standup notes to extract action items, blockers,
              and decisions automatically.
            </SectionDescription>
            <NotesTextArea
              placeholder="Paste your standup / meeting notes here..."
              value={notesInput}
              onChange={(e) => setNotesInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  handleIngest();
                }
              }}
            />
            <IngestButton
              $loading={isIngesting}
              disabled={isIngesting || !notesInput.trim()}
              onClick={handleIngest}
            >
              {isIngesting ? "⏳ Parsing..." : "📋 Parse Meeting Notes"}
            </IngestButton>
            {standupError && <StandupErrorText>{standupError}</StandupErrorText>}

            <QuickActions>
              <QuickActionButton onClick={() => requestMyTasks()}>
                ✅ My Tasks
              </QuickActionButton>
              <QuickActionButton onClick={() => requestBlockers()}>
                🔴 Blockers
              </QuickActionButton>
              <QuickActionButton onClick={() => requestHistory({ dateRange: "this week" })}>
                📅 This Week
              </QuickActionButton>
            </QuickActions>

            {recentStandups.length > 0 && (
              <RecentList>
                {recentStandups.map((s) => (
                  <RecentItem key={`${s.date}-${s.teamName}`}>
                    <div>
                      <RecentDate>{s.date} — {s.teamName}</RecentDate>
                      <RecentMeta>
                        {s.commitmentCount} tasks · {s.blockerCount} blockers
                      </RecentMeta>
                    </div>
                    <DeleteButton
                      onClick={() => deleteStandup(s.date, s.teamName)}
                      disabled={deletingKey === `${s.date}-${s.teamName}`}
                      title={`Delete standup for ${s.date}`}
                      aria-label={`Delete standup for ${s.date}`}
                    >
                      {deletingKey === `${s.date}-${s.teamName}` ? "⏳" : "🗑"}
                    </DeleteButton>
                  </RecentItem>
                ))}
              </RecentList>
            )}
          </Section>

          {/* Person Detail View */}
          {selectedPerson ? (
            <PersonDetailView onBack={clearSelectedPerson} />
          ) : (
            <>
              {/* Health Stats */}
              {healthStats && (
                <HealthGrid>
                  <StatCard>
                    <StatValue>{healthStats.teamSize}</StatValue>
                    <StatLabel>Team Members</StatLabel>
                  </StatCard>
                  <StatCard>
                    <StatValue>{healthStats.standups}</StatValue>
                    <StatLabel>Standups</StatLabel>
                  </StatCard>
                  <StatCard>
                    <StatValue>{healthStats.avgCompletion}%</StatValue>
                    <StatLabel>Completion</StatLabel>
                  </StatCard>
                  <StatCard>
                    <StatValue>{healthStats.totalBlockers}</StatValue>
                    <StatLabel>Blockers</StatLabel>
                  </StatCard>
                </HealthGrid>
              )}

              {/* Tabs */}
              <TabRow>
                <Tab
                  $active={activeTab === "members"}
                  onClick={() => setActiveTab("members")}
                >
                  Members
                </Tab>
                <Tab
                  $active={activeTab === "graph"}
                  onClick={() => setActiveTab("graph")}
                >
                  Relationships
                </Tab>
                <Tab
                  $active={activeTab === "blockers"}
                  onClick={() => setActiveTab("blockers")}
                >
                  Blockers
                </Tab>
              </TabRow>

              {/* Tab Content */}
              {activeTab === "members" && (
                <Section>
                  {isLoading && members.length === 0 ? (
                    <EmptyState>Loading team data...</EmptyState>
                  ) : members.length === 0 ? (
                    <EmptyState>
                      No team members tracked yet.
                      <br />
                      Ingest meeting notes above to populate the
                      team graph.
                    </EmptyState>
                  ) : (
                    members.map((m) => (
                      <MemberCard
                        key={m.id}
                        onClick={() => requestPersonProfile(m.name)}
                      >
                        <Avatar $hue={nameToHue(m.name)}>
                          {initials(m.name)}
                        </Avatar>
                        <MemberInfo>
                          <MemberName>{m.name}</MemberName>
                          <MemberMeta>
                            {m.role || "Unknown role"}
                            {" · "}
                            {m.standupCount} standups
                            {" · "}
                            last seen {m.lastSeen}
                          </MemberMeta>
                        </MemberInfo>
                        {m.commitmentCount > 0 && (
                          <CompletionBadge $rate={m.completionRate}>
                            {m.completionRate}%
                          </CompletionBadge>
                        )}
                      </MemberCard>
                    ))
                  )}
                </Section>
              )}

              {activeTab === "graph" && (
                <Section>
                  {edges.length === 0 ? (
                    <EmptyState>
                      No relationships detected yet.
                      <br />
                      Ingest multiple standups to build the team graph.
                    </EmptyState>
                  ) : (
                    Object.entries(edgesByKind).map(([kind, kindEdges]) => (
                      <div key={kind} style={{ marginBottom: 12 }}>
                        <SectionTitle>{formatKind(kind)}</SectionTitle>
                        {kindEdges.map((edge, i) => (
                          <EdgeRow key={i}>
                            <span
                              style={{ cursor: "pointer" }}
                              onClick={() =>
                                requestPersonProfile(edge.sourceName)
                              }
                            >
                              {edge.sourceName}
                            </span>
                            <EdgeKind $kind={edge.kind}>
                              {formatKind(edge.kind)}
                            </EdgeKind>
                            <span
                              style={{ cursor: "pointer" }}
                              onClick={() =>
                                requestPersonProfile(edge.targetName)
                              }
                            >
                              {edge.targetName}
                            </span>
                            <WeightBadge>×{edge.weight}</WeightBadge>
                          </EdgeRow>
                        ))}
                      </div>
                    ))
                  )}
                </Section>
              )}

              {activeTab === "blockers" && (
                <Section>
                  {!blockersMarkdown ||
                  blockersMarkdown.includes("No recurring blockers") ? (
                    <EmptyState>
                      No recurring blockers found.
                      <br />
                      Blockers are tracked from ingested meeting notes.
                    </EmptyState>
                  ) : (
                    <div
                      style={{
                        fontSize: 12,
                        lineHeight: 1.5,
                        color: "var(--vscode-foreground)",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {blockersMarkdown
                        .replace(/^## Recurring Blockers\n\n/, "")
                        .split("\n")
                        .map((line, i) => (
                          <div key={i}>{line}</div>
                        ))}
                    </div>
                  )}
                </Section>
              )}
            </>
          )}
        </Content>
      </PanelContainer>
    </PanelOverlay>
  );
};

/* ─── Icon ─── */
const TeamIcon = () => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);
