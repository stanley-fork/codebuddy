/**
 * Shared standup types — single source of truth for both backend and webview.
 * This file must NOT import any `vscode` module so it can be used in the webview.
 */

export interface StandupCommitment {
  person: string;
  action: string;
  deadline?: string | null;
  ticketIds: string[];
  status: "pending" | "done";
}

export interface StandupBlocker {
  blocked: string;
  blockedBy: string;
  owner: string;
  reason: string;
}

export interface StandupDecision {
  summary: string;
  participants: string[];
}

export interface StandupTicketMention {
  id: string;
  context: string;
  assignee?: string;
}

export interface StandupCardData {
  type: "standup_brief";
  date: string;
  teamName: string;
  participants: string[];
  myCommitments: StandupCommitment[];
  otherCommitments: StandupCommitment[];
  blockers: StandupBlocker[];
  decisions: StandupDecision[];
  ticketMentions: StandupTicketMention[];
}
