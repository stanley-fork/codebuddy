export interface Commitment {
  person: string;
  action: string;
  deadline?: string;
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

export interface StandupRecord {
  date: string;
  teamName: string;
  participants: string[];
  commitments: Commitment[];
  blockers: Blocker[];
  decisions: Decision[];
  ticketMentions: TicketMention[];
}

export interface StandupFilter {
  person?: string;
  dateRange?: string;
  ticketId?: string;
}
