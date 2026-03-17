import * as cp from "child_process";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../infrastructure/logger/logger";
import { GroqLLM } from "../llms/groq/groq";
import { getAPIKeyAndModel } from "../utils/utils";
import { MemoryTool } from "../tools/memory";
import type {
  StandupRecord,
  StandupFilter,
  Commitment,
  Blocker,
} from "./standup.interfaces";

const STANDUP_KEYWORD_PREFIX = "standup";
const MAX_STORED_STANDUPS = 30;

/**
 * MeetingIntelligenceService — ingests external standup/meeting notes,
 * extracts structured data via LLM, persists to project memory, and
 * provides queryable history with personal briefs.
 */
export class MeetingIntelligenceService {
  private static instance: MeetingIntelligenceService | undefined;
  private readonly logger: Logger;
  private readonly groqLLM: GroqLLM | null;
  private readonly memoryTool: MemoryTool;

  private constructor() {
    this.logger = Logger.initialize("MeetingIntelligenceService", {
      minLevel: LogLevel.DEBUG,
      enableConsole: true,
      enableFile: true,
      enableTelemetry: true,
    });
    const { apiKey } = getAPIKeyAndModel("groq");
    this.groqLLM = apiKey
      ? GroqLLM.getInstance({
          apiKey,
          model: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
        })
      : null;
    this.memoryTool = new MemoryTool();
  }

  static getInstance(): MeetingIntelligenceService {
    if (!MeetingIntelligenceService.instance) {
      MeetingIntelligenceService.instance = new MeetingIntelligenceService();
    }
    return MeetingIntelligenceService.instance;
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Parse raw meeting notes into a StandupRecord, persist it, and return a
   * formatted personal brief for the current user.
   */
  async ingest(rawNotes: string): Promise<string> {
    const record = await this.parseStandup(rawNotes);
    await this.store(record);
    await this.pruneOldStandups();
    const myName = this.resolveMyName();
    return this.formatPersonalBrief(record, myName);
  }

  /** Return the specified person's (or current user's) commitments. */
  async getMyTasks(person?: string): Promise<string> {
    const name = person ?? this.resolveMyName();
    const standups = await this.loadStandups();
    const commitments: Array<Commitment & { date: string }> = [];
    for (const s of standups) {
      for (const c of s.commitments) {
        if (this.nameMatch(c.person, name)) {
          commitments.push({ ...c, date: s.date });
        }
      }
    }
    if (commitments.length === 0) {
      return `No commitments found for "${name}" in recent standups.`;
    }
    let out = `## Commitments for ${name}\n\n`;
    for (const c of commitments) {
      const status = c.status === "done" ? "✅" : "⬜";
      const deadline = c.deadline ? ` (${c.deadline})` : "";
      const tickets = c.ticketIds.length ? ` [${c.ticketIds.join(", ")}]` : "";
      out += `- ${status} ${c.action}${deadline}${tickets} — *${c.date}*\n`;
    }
    return out;
  }

  /** Return all active blockers from recent standups. */
  async getBlockers(): Promise<string> {
    const standups = await this.loadStandups();
    const blockers: Array<Blocker & { date: string }> = [];
    for (const s of standups) {
      for (const b of s.blockers) {
        blockers.push({ ...b, date: s.date });
      }
    }
    if (blockers.length === 0) {
      return "No blockers found in recent standups.";
    }
    let out = "## Active Blockers\n\n";
    for (const b of blockers) {
      out += `- 🔴 **${b.blocked}** blocked by **${b.blockedBy}** — ${b.reason} (owner: ${b.owner}, ${b.date})\n`;
    }
    return out;
  }

  /** Query standup history by filter. */
  async queryHistory(filter: StandupFilter): Promise<string> {
    let standups = await this.loadStandups();

    if (filter.person) {
      standups = standups.filter(
        (s) =>
          s.commitments.some((c) => this.nameMatch(c.person, filter.person!)) ||
          s.participants.some((p) => this.nameMatch(p, filter.person!)),
      );
    }
    if (filter.ticketId) {
      const tid = filter.ticketId;
      standups = standups.filter(
        (s) =>
          s.ticketMentions.some((t) => t.id === tid) ||
          s.commitments.some((c) => c.ticketIds.includes(tid)),
      );
    }
    if (filter.dateRange) {
      standups = this.filterByDateRange(standups, filter.dateRange);
    }
    if (standups.length === 0) {
      return "No standups matched the filter.";
    }
    let out = `## Standup History (${standups.length} results)\n\n`;
    for (const s of standups) {
      out += `### ${s.date} — ${s.teamName}\n`;
      out += `**Participants:** ${s.participants.join(", ")}\n`;
      if (s.commitments.length) {
        out += "**Commitments:**\n";
        for (const c of s.commitments) {
          out += `- ${c.person}: ${c.action}\n`;
        }
      }
      if (s.blockers.length) {
        out += "**Blockers:**\n";
        for (const b of s.blockers) {
          out += `- ${b.blocked} → ${b.blockedBy}\n`;
        }
      }
      out += "\n";
    }
    return out;
  }

  // ── LLM Parsing ────────────────────────────────────────────────

  private async parseStandup(rawNotes: string): Promise<StandupRecord> {
    if (!this.groqLLM) {
      this.logger.warn("No LLM configured — using fallback parser");
      return this.fallbackParse(rawNotes);
    }

    const prompt = `You are a standup meeting note parser. Extract structured data from the meeting notes below.

Return ONLY valid JSON matching this schema (no markdown fences, no explanation):
{
  "date": "YYYY-MM-DD",
  "teamName": "team name from the notes",
  "participants": ["Name1", "Name2"],
  "commitments": [
    {
      "person": "Full Name",
      "action": "what they committed to do",
      "deadline": "deadline if mentioned or null",
      "ticketIds": ["1279"],
      "status": "pending"
    }
  ],
  "blockers": [
    {
      "blocked": "ticket or MR that is stuck",
      "blockedBy": "what it depends on",
      "owner": "person who can unblock",
      "reason": "why it is blocked"
    }
  ],
  "decisions": [
    {
      "summary": "what was decided",
      "participants": ["who was involved"]
    }
  ],
  "ticketMentions": [
    {
      "id": "ticket number",
      "context": "what was said about it",
      "assignee": "person or null"
    }
  ]
}

Rules:
- Extract ticket/MR numbers from patterns like #1279, !1279, ticket 1279, MR 1279, capital-1279
- "deadline" should capture time references like "before lunch", "first half of day", "today", "end of day"
- Each person's update should produce at least one commitment
- Look for dependency language: "blocks", "depends on", "needs X first", "unblock"
- Look for decision language: "agreed", "decided", "will focus on", "prioritize"

Meeting notes:
<notes>
${rawNotes}
</notes>`;

    try {
      const response = await this.groqLLM.generateText(prompt);
      if (!response) {
        throw new Error("Empty LLM response");
      }
      // Strip markdown fences if LLM wraps output
      const cleaned = response
        .replace(/^```(?:json)?\s*/m, "")
        .replace(/\s*```$/m, "")
        .trim();
      const parsed = JSON.parse(cleaned) as StandupRecord;
      this.logger.info(
        `Parsed standup: ${parsed.date}, ${parsed.commitments.length} commitments, ${parsed.blockers.length} blockers`,
      );
      return parsed;
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : "Unknown parse error";
      this.logger.error(`LLM standup parsing failed: ${msg}`);
      return this.fallbackParse(rawNotes);
    }
  }

  /** Regex-based fallback when LLM is unavailable. */
  private fallbackParse(rawNotes: string): StandupRecord {
    const dateMatch = rawNotes.match(
      /(\w{3}\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/,
    );
    const date = dateMatch
      ? this.normalizeDate(dateMatch[1])
      : new Date().toISOString().slice(0, 10);

    const ticketIds = [
      ...new Set(
        (
          rawNotes.match(/(?:#|!|ticket\s*|MR\s*|capital[- ]?)(\d{4,})/gi) || []
        ).map((m) => m.replace(/^(?:#|!|ticket\s*|MR\s*|capital[- ]?)/i, "")),
      ),
    ];

    return {
      date,
      teamName: "Unknown Team",
      participants: [],
      commitments: [],
      blockers: [],
      decisions: [],
      ticketMentions: ticketIds.map((id) => ({
        id,
        context: "mentioned in standup",
      })),
    };
  }

  // ── Storage (via MemoryTool) ───────────────────────────────────

  private async store(record: StandupRecord): Promise<void> {
    const keyword = `${STANDUP_KEYWORD_PREFIX}|${record.date}|daily|${record.teamName.toLowerCase().replace(/\s+/g, "-")}`;
    try {
      await this.memoryTool.execute("add", {
        category: "Experience",
        title: `Daily Standup — ${record.date}`,
        content: JSON.stringify(record),
        keywords: keyword,
        scope: "project",
      });
      this.logger.info(`Stored standup for ${record.date}`);
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : "Unknown store error";
      this.logger.error(`Failed to store standup: ${msg}`);
    }
  }

  private async loadStandups(): Promise<StandupRecord[]> {
    try {
      const raw = await this.memoryTool.execute(
        "search",
        undefined,
        STANDUP_KEYWORD_PREFIX,
      );
      const entries = JSON.parse(raw);
      if (!Array.isArray(entries)) return [];

      return entries
        .map((e: { content: string }) => {
          try {
            return JSON.parse(e.content) as StandupRecord;
          } catch {
            return null;
          }
        })
        .filter((r): r is StandupRecord => r !== null)
        .sort((a, b) => b.date.localeCompare(a.date));
    } catch {
      return [];
    }
  }

  private async pruneOldStandups(): Promise<void> {
    try {
      const raw = await this.memoryTool.execute(
        "search",
        undefined,
        STANDUP_KEYWORD_PREFIX,
      );
      const entries = JSON.parse(raw);
      if (!Array.isArray(entries) || entries.length <= MAX_STORED_STANDUPS)
        return;

      const sorted = entries.sort(
        (a: { timestamp: number }, b: { timestamp: number }) =>
          b.timestamp - a.timestamp,
      );
      for (let i = MAX_STORED_STANDUPS; i < sorted.length; i++) {
        await this.memoryTool.execute("delete", { id: sorted[i].id });
      }
      this.logger.info(
        `Pruned ${sorted.length - MAX_STORED_STANDUPS} old standup(s)`,
      );
    } catch {
      // Non-critical
    }
  }

  // ── Formatting ─────────────────────────────────────────────────

  private formatPersonalBrief(record: StandupRecord, myName: string): string {
    let out = `## 📋 Standup Summary — ${record.date}\n`;
    if (record.teamName) out += `**Team:** ${record.teamName}\n\n`;

    // My action items
    const myCommitments = record.commitments.filter((c) =>
      this.nameMatch(c.person, myName),
    );
    if (myCommitments.length > 0) {
      out += "### Your Action Items\n";
      for (const c of myCommitments) {
        const deadline = c.deadline ? ` *(${c.deadline})*` : "";
        const tickets = c.ticketIds.length
          ? ` [${c.ticketIds.join(", ")}]`
          : "";
        out += `1. ⬜ ${c.action}${deadline}${tickets}\n`;
      }
      out += "\n";
    }

    // Blockers
    if (record.blockers.length > 0) {
      out += "### Blockers\n";
      for (const b of record.blockers) {
        out += `- 🔴 **${b.blocked}** → blocked by **${b.blockedBy}** (${b.reason})\n`;
      }
      out += "\n";
    }

    // Decisions
    if (record.decisions.length > 0) {
      out += "### Key Decisions\n";
      for (const d of record.decisions) {
        out += `- ${d.summary}\n`;
      }
      out += "\n";
    }

    // Team commitments (others)
    const otherCommitments = record.commitments.filter(
      (c) => !this.nameMatch(c.person, myName),
    );
    if (otherCommitments.length > 0) {
      out += `### Team Commitments (${otherCommitments.length})\n`;
      const byPerson = new Map<string, string[]>();
      for (const c of otherCommitments) {
        const actions = byPerson.get(c.person) ?? [];
        actions.push(c.action);
        byPerson.set(c.person, actions);
      }
      for (const [person, actions] of byPerson) {
        out += `- **${person}:** ${actions.join("; ")}\n`;
      }
      out += "\n";
    }

    // Tickets mentioned
    if (record.ticketMentions.length > 0) {
      out += "### Tickets Referenced\n";
      for (const t of record.ticketMentions) {
        const assignee = t.assignee ? ` (${t.assignee})` : "";
        out += `- **#${t.id}**${assignee}: ${t.context}\n`;
      }
    }

    return out;
  }

  // ── Utilities ──────────────────────────────────────────────────

  private resolveMyName(): string {
    const setting = vscode.workspace
      .getConfiguration("codebuddy.standup")
      .get<string>("myName");
    if (setting) return setting;

    try {
      const name = cp
        .execSync("git config user.name", {
          encoding: "utf8",
          timeout: 3000,
        })
        .trim();
      if (name) return name;
    } catch {
      // ignore
    }

    return "Unknown";
  }

  /** Fuzzy name matching — handles first name, last name, partial. */
  private nameMatch(candidate: string, target: string): boolean {
    const c = candidate.toLowerCase().trim();
    const t = target.toLowerCase().trim();
    if (c === t) return true;
    const cParts = c.split(/\s+/);
    const tParts = t.split(/\s+/);
    return cParts.some((cp) => tParts.some((tp) => cp === tp && cp.length > 2));
  }

  private normalizeDate(raw: string): string {
    try {
      const d = new Date(raw);
      if (isNaN(d.getTime())) return raw;
      return d.toISOString().slice(0, 10);
    } catch {
      return raw;
    }
  }

  private filterByDateRange(
    standups: StandupRecord[],
    range: string,
  ): StandupRecord[] {
    const now = new Date();
    let daysBack = 7;
    const match = range.match(/(\d+)\s*day/i);
    if (match) {
      daysBack = parseInt(match[1], 10);
    } else if (/this\s*week/i.test(range)) {
      daysBack = now.getDay();
    } else if (/last\s*week/i.test(range)) {
      daysBack = now.getDay() + 7;
    }
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - daysBack);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return standups.filter((s) => s.date >= cutoffStr);
  }
}
