/**
 * Shared standup types — single source of truth for both backend and webview.
 * This file must NOT import any `vscode` module so it can be used in the webview.
 */

export interface Commitment {
  person: string;
  action: string;
  deadline?: string | null;
  ticketIds: string[];
  status: "pending" | "done";
}

export interface Blocker {
  blocked: string;
  blockedBy: string;
  owner: string;
  reason: string;
}

export interface Decision {
  summary: string;
  participants: string[];
}

export interface TicketMention {
  id: string;
  context: string;
  assignee?: string;
}

export interface DetectedRelationship {
  from: string;
  to: string;
  kind: "reviews_for" | "reports_to" | "mentors" | "depends_on";
  context: string;
}

export interface StandupRecord {
  date: string;
  teamName: string;
  participants: string[];
  commitments: Commitment[];
  blockers: Blocker[];
  decisions: Decision[];
  ticketMentions: TicketMention[];
  relationships?: DetectedRelationship[];
}

export interface StandupFilter {
  person?: string;
  dateRange?: string;
  ticketId?: string;
}

// ── Webview-specific aliases (keep for backwards compatibility) ──

/** @deprecated Use `Commitment` instead */
export type StandupCommitment = Commitment;
/** @deprecated Use `Blocker` instead */
export type StandupBlocker = Blocker;
/** @deprecated Use `Decision` instead */
export type StandupDecision = Decision;
/** @deprecated Use `TicketMention` instead */
export type StandupTicketMention = TicketMention;

export interface StandupCardData {
  type: "standup_brief";
  date: string;
  teamName: string;
  participants: string[];
  myCommitments: Commitment[];
  otherCommitments: Commitment[];
  blockers: Blocker[];
  decisions: Decision[];
  ticketMentions: TicketMention[];
}

// ── Shared utilities ────────────────────────────────────────────

/** Canonical person name — lowercase, trimmed, collapsed whitespace. */
export function normalizePersonName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}
