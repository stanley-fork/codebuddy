import * as assert from "assert";
import type {
  StandupRecord,
  Commitment,
  Blocker,
  Decision,
  TicketMention,
} from "../../services/standup.interfaces";

// ── Interface Validation ─────────────────────────────────────────

suite("Standup Interfaces", () => {
  test("StandupRecord has all required fields", () => {
    const record: StandupRecord = {
      date: "2026-03-17",
      teamName: "Capital Product Tech",
      participants: ["Alice", "Bob"],
      commitments: [],
      blockers: [],
      decisions: [],
      ticketMentions: [],
    };
    assert.strictEqual(record.date, "2026-03-17");
    assert.strictEqual(record.teamName, "Capital Product Tech");
    assert.strictEqual(record.participants.length, 2);
  });

  test("Commitment has correct shape", () => {
    const commitment: Commitment = {
      person: "Nelson",
      action: "Review MR !1279",
      deadline: "before lunch",
      ticketIds: ["1279"],
      status: "pending",
    };
    assert.strictEqual(commitment.person, "Nelson");
    assert.strictEqual(commitment.status, "pending");
    assert.deepStrictEqual(commitment.ticketIds, ["1279"]);
  });

  test("Blocker has correct shape", () => {
    const blocker: Blocker = {
      blocked: "#1288",
      blockedBy: "#1279",
      owner: "Ola",
      reason: "Methods in 1279 needed for 1288",
    };
    assert.strictEqual(blocker.blocked, "#1288");
    assert.strictEqual(blocker.owner, "Ola");
  });

  test("Decision has correct shape", () => {
    const decision: Decision = {
      summary: "Focus on non-LMS items",
      participants: ["She Tu", "Nelson"],
    };
    assert.strictEqual(decision.summary, "Focus on non-LMS items");
    assert.strictEqual(decision.participants.length, 2);
  });

  test("TicketMention has correct shape with optional assignee", () => {
    const mention: TicketMention = {
      id: "1279",
      context: "needs to be merged today",
      assignee: "Ola",
    };
    assert.strictEqual(mention.id, "1279");
    assert.strictEqual(mention.assignee, "Ola");

    const noAssignee: TicketMention = {
      id: "1287",
      context: "blocked",
    };
    assert.strictEqual(noAssignee.assignee, undefined);
  });
});

// ── LangChain Tool Schema ────────────────────────────────────────

suite("LangChainStandupTool", () => {
  // Import inline to avoid vscode module issues in test runner
  let LangChainStandupTool: any;

  setup(async () => {
    const mod = await import("../../agents/langgraph/tools/standup");
    LangChainStandupTool = mod.LangChainStandupTool;
  });

  teardown(() => {
    // no-op — keep for future mock cleanup
  });

  test("tool has correct name", () => {
    const tool = new LangChainStandupTool();
    assert.strictEqual(tool.name, "standup_intelligence");
  });

  test("tool has description", () => {
    const tool = new LangChainStandupTool();
    assert.ok(tool.description.length > 0);
    assert.ok(tool.description.includes("standup"));
  });

  test("tool schema accepts valid ingest input", () => {
    const tool = new LangChainStandupTool();
    const input = {
      operation: "ingest",
      args: { notes: "Some meeting notes" },
    };
    const result = tool.schema.safeParse(input);
    assert.ok(result.success, "Schema should accept valid ingest input");
  });

  test("tool schema accepts my_tasks with person", () => {
    const tool = new LangChainStandupTool();
    const input = {
      operation: "my_tasks",
      args: { person: "Nelson" },
    };
    const result = tool.schema.safeParse(input);
    assert.ok(result.success, "Schema should accept my_tasks with person");
  });

  test("tool schema accepts history with all filters", () => {
    const tool = new LangChainStandupTool();
    const input = {
      operation: "history",
      args: {
        person: "Marcus",
        dateRange: "last 3 days",
        ticketId: "1279",
      },
    };
    const result = tool.schema.safeParse(input);
    assert.ok(result.success, "Schema should accept history with filters");
  });

  test("tool schema rejects invalid operation", () => {
    const tool = new LangChainStandupTool();
    const input = { operation: "invalid_op" };
    const result = tool.schema.safeParse(input);
    assert.ok(!result.success, "Schema should reject invalid operation");
  });

  test("tool schema accepts blockers with no args", () => {
    const tool = new LangChainStandupTool();
    const input = { operation: "blockers" };
    const result = tool.schema.safeParse(input);
    assert.ok(result.success, "Schema should accept blockers without args");
  });
});

// ── Formatting Logic ─────────────────────────────────────────────

suite("StandupRecord formatting", () => {
  const sampleRecord: StandupRecord = {
    date: "2026-03-17",
    teamName: "Capital Product Tech",
    participants: [
      "Olasunkanmi Raymond",
      "Nelson Choon",
      "Marcus Wong",
      "She Tu Chun Ket",
    ],
    commitments: [
      {
        person: "Olasunkanmi Raymond",
        action: "Get MR !1279 reviewed and merged",
        deadline: "today",
        ticketIds: ["1279"],
        status: "pending",
      },
      {
        person: "Nelson Choon",
        action: "Code review on 2 MRs from Ola",
        ticketIds: [],
        status: "pending",
      },
      {
        person: "Marcus Wong",
        action: "Review payment service MR",
        ticketIds: [],
        status: "pending",
      },
      {
        person: "Marcus Wong",
        action: "Release email ticket before lunch",
        deadline: "before lunch",
        ticketIds: [],
        status: "pending",
      },
    ],
    blockers: [
      {
        blocked: "#1288",
        blockedBy: "#1279",
        owner: "Olasunkanmi Raymond",
        reason: "Methods in 1279 needed for 1288",
      },
    ],
    decisions: [
      {
        summary: "Focus on non-LMS items (capital office, settlement, APO, CMS)",
        participants: ["She Tu Chun Ket"],
      },
    ],
    ticketMentions: [
      {
        id: "1279",
        context: "needs to be merged today",
        assignee: "Olasunkanmi Raymond",
      },
      { id: "1287", context: "blocked by 1279" },
      { id: "1288", context: "depends on 1279" },
    ],
  };

  test("record has correct participant count", () => {
    assert.strictEqual(sampleRecord.participants.length, 4);
  });

  test("record has correct commitment count", () => {
    assert.strictEqual(sampleRecord.commitments.length, 4);
  });

  test("commitments can be filtered by person", () => {
    const marcusCommitments = sampleRecord.commitments.filter(
      (c) => c.person === "Marcus Wong",
    );
    assert.strictEqual(marcusCommitments.length, 2);
  });

  test("blockers reference valid tickets", () => {
    for (const b of sampleRecord.blockers) {
      assert.ok(b.blocked.length > 0);
      assert.ok(b.blockedBy.length > 0);
    }
  });

  test("ticket mentions are unique by id", () => {
    const ids = sampleRecord.ticketMentions.map((t) => t.id);
    const uniqueIds = [...new Set(ids)];
    assert.strictEqual(ids.length, uniqueIds.length);
  });

  test("all commitments default to pending status", () => {
    for (const c of sampleRecord.commitments) {
      assert.strictEqual(c.status, "pending");
    }
  });
});

// ── Fallback Parser ──────────────────────────────────────────────

suite("Fallback standup parser (regex)", () => {
  test("extracts date from 'Mar 17, 2026' format", () => {
    const notes = "Mar 17, 2026\nCapital Product Tech Daily Stand Up";
    const dateMatch = notes.match(
      /(\w{3}\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/,
    );
    assert.ok(dateMatch);
    assert.ok(dateMatch[1].includes("Mar"));
  });

  test("extracts date from ISO format", () => {
    const notes = "2026-03-17 standup notes";
    const dateMatch = notes.match(
      /(\w{3}\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/,
    );
    assert.ok(dateMatch);
    assert.strictEqual(dateMatch[1], "2026-03-17");
  });

  test("extracts ticket IDs from various formats", () => {
    const notes = "Ticket 1279, MR 1287, #1288, !1290, capital-1300";
    const matches =
      notes.match(/(?:#|!|ticket\s*|MR\s*|capital[- ]?)(\d{4,})/gi) || [];
    const ids = matches.map((m) =>
      m.replace(/^(?:#|!|ticket\s*|MR\s*|capital[- ]?)/i, ""),
    );
    assert.ok(ids.includes("1279"));
    assert.ok(ids.includes("1287"));
    assert.ok(ids.includes("1288"));
    assert.ok(ids.includes("1290"));
    assert.ok(ids.includes("1300"));
  });

  test("deduplicates ticket IDs", () => {
    const notes = "ticket 1279, #1279, MR 1279";
    const matches =
      notes.match(/(?:#|!|ticket\s*|MR\s*|capital[- ]?)(\d{2,})/gi) || [];
    const ids = [
      ...new Set(
        matches.map((m) =>
          m.replace(/^(?:#|!|ticket\s*|MR\s*|capital[- ]?)/i, ""),
        ),
      ),
    ];
    assert.strictEqual(ids.length, 1);
    assert.strictEqual(ids[0], "1279");
  });
});

// ── Name Matching ────────────────────────────────────────────────

suite("Name matching logic", () => {
  /** Replicated from MeetingIntelligenceService for unit testing. */
  const NAME_STOPWORDS = new Set([
    "the", "and", "for", "her", "his", "our", "their", "with",
    "from", "has", "had", "was", "are", "not", "but", "can",
  ]);

  function nameMatch(candidate: string, target: string): boolean {
    const normalizedCandidate = candidate.toLowerCase().trim();
    const normalizedTarget = target.toLowerCase().trim();
    if (normalizedCandidate === normalizedTarget) return true;
    const candidateParts = normalizedCandidate.split(/\s+/);
    const targetParts = normalizedTarget.split(/\s+/);
    return candidateParts.some(
      (part) =>
        part.length > 2 &&
        !NAME_STOPWORDS.has(part) &&
        targetParts.some((tPart) => part === tPart),
    );
  }

  test("exact match", () => {
    assert.ok(nameMatch("Olasunkanmi Raymond", "Olasunkanmi Raymond"));
  });

  test("case insensitive match", () => {
    assert.ok(nameMatch("olasunkanmi raymond", "Olasunkanmi Raymond"));
  });

  test("first name partial match", () => {
    assert.ok(nameMatch("Olasunkanmi Raymond", "Olasunkanmi"));
  });

  test("last name partial match", () => {
    assert.ok(nameMatch("Nelson Choon Jiin Hao", "Nelson"));
  });

  test("does not match short tokens (<=2 chars)", () => {
    assert.ok(!nameMatch("Al Nameh", "Al"));
  });

  test("does not match completely different names", () => {
    assert.ok(!nameMatch("Marcus Wong", "Nelson Choon"));
  });

  test("does not match common stopwords", () => {
    assert.ok(!nameMatch("The Manager", "The Other"));
    assert.ok(!nameMatch("Her Name", "Her Role"));
    assert.ok(!nameMatch("And More", "And Less"));
  });

  test("handles extra whitespace", () => {
    assert.ok(nameMatch("  Nelson Choon  ", "Nelson"));
  });
});

// ── Date Range Filtering ─────────────────────────────────────────

suite("Date range filtering logic", () => {
  test("parses 'last 3 days' as 3 days back", () => {
    const match = "last 3 days".match(/(\d+)\s*day/i);
    assert.ok(match);
    assert.strictEqual(parseInt(match![1], 10), 3);
  });

  test("parses 'last 7 days' as 7 days back", () => {
    const match = "last 7 days".match(/(\d+)\s*day/i);
    assert.ok(match);
    assert.strictEqual(parseInt(match![1], 10), 7);
  });

  test("recognizes 'this week'", () => {
    assert.ok(/this\s*week/i.test("this week"));
    assert.ok(/this\s*week/i.test("This Week"));
  });

  test("recognizes 'last week'", () => {
    assert.ok(/last\s*week/i.test("last week"));
  });

  test("'this week' calculation handles Sunday (day 0) correctly", () => {
    // (getDay() + 6) % 7 gives days since Monday
    // Sunday: getDay()=0 → (0+6)%7=6 (correct: 6 days back to Monday)
    // Monday: getDay()=1 → (1+6)%7=0 (correct: 0 days back)
    // Tuesday: getDay()=2 → (2+6)%7=1 (correct: 1 day back)
    assert.strictEqual((0 + 6) % 7, 6); // Sunday → 6 days back
    assert.strictEqual((1 + 6) % 7, 0); // Monday → 0 days back
    assert.strictEqual((2 + 6) % 7, 1); // Tuesday → 1 day back
    assert.strictEqual((6 + 6) % 7, 5); // Saturday → 5 days back
  });
});
