# Standup Intelligence — Feature Spec

## Problem

Standup meeting notes (from Gemini, Otter, etc.) are unstructured walls of text. Engineers waste time mentally parsing who's doing what, which tickets are blocked, and what they committed to. The notes die in a Google Doc — never connected to the actual code, MRs, or tickets.

## Solution

A `/standup` command and agent tool that ingests meeting notes, extracts structured data, stores it in memory, and provides actionable daily briefs linked to your development workflow.

---

## Feature Scope (MVP)

### 1. Standup Parser (LLM-based extraction)

**Input:** Raw meeting notes (pasted text or clipboard)

**Output:** Structured `StandupRecord`:

```typescript
interface StandupRecord {
  date: string;                    // ISO date
  teamName: string;                // "Capital Product Tech"
  participants: string[];
  
  commitments: Commitment[];       // Who promised what
  blockers: Blocker[];             // Dependency chains
  decisions: Decision[];           // Agreed outcomes
  ticketMentions: TicketMention[]; // Extracted ticket/MR refs
}

interface Commitment {
  person: string;
  action: string;                  // "Review MR !1279"
  deadline?: string;               // "before lunch", "first half of day"
  ticketIds: string[];             // ["1279"]
  status: "pending" | "done";
}

interface Blocker {
  blocked: string;                 // Ticket/MR that's stuck
  blockedBy: string;               // What it depends on
  owner: string;                   // Who can unblock
  reason: string;
}

interface Decision {
  summary: string;
  participants: string[];
}

interface TicketMention {
  id: string;                      // "1279", "1287"
  context: string;                 // "needs to be merged today"
  assignee?: string;
}
```

**Implementation:** Single LLM call with structured output schema. Use the configured LLM provider (same as agent mode). Prompt returns JSON matching the schema above.

### 2. `/standup` Slash Command (Ask Mode)

**Usage:**

```
/standup <paste meeting notes here>
```

**Behavior:**

1. Parse notes → `StandupRecord`
2. Store in project memory (`category: "Experience"`, keywords: `standup|{date}|daily`)
3. Return formatted personal brief:
   - **Your action items** (filtered to current user)
   - **Blockers affecting you** (your MRs or ones you need)
   - **Reviews needed from you**
   - **Key decisions** that impact your work

**User identity:** Read from `git config user.name` or a new `codebuddy.standup.myName` setting.

### 3. Standup Agent Tool (Agent Mode)

**Tool name:** `standup_intelligence`

**Operations:**

| Operation | Description |
|-----------|-------------|
| `ingest` | Parse and store standup notes |
| `my_tasks` | Get current user's commitments from recent standups |
| `blockers` | List active dependency chains across standups |
| `track` | Check commitment completion (compare with git log/MR status) |
| `history` | Query past standups by date range, person, or ticket |

**Schema (Zod):**

```typescript
z.object({
  operation: z.enum(["ingest", "my_tasks", "blockers", "track", "history"]),
  args: z.object({
    notes: z.string().optional(),           // For ingest
    person: z.string().optional(),          // Filter by person
    dateRange: z.string().optional(),       // "last 3 days", "this week"
    ticketId: z.string().optional(),        // Filter by ticket
  })
})
```

This lets the agent answer natural language queries:

- *"What did I commit to in yesterday's standup?"*
- *"Is anyone blocked on my work?"*
- *"What's the status of ticket 1279 from standup discussions?"*

### 4. Standup Memory (Persistence)

**Storage:** Project-scoped memory entries via `MemoryTool`.

**Format per standup:**

```
Title: "Daily Standup — 2026-03-17"
Category: "Experience"
Keywords: "standup|2026-03-17|daily|capital-product-tech"
Content: JSON.stringify(StandupRecord)
Scope: "project"
```

**Retention:** Keep last 30 standups. Auto-prune older entries on ingest.

**Queryable by:** Date, person name, ticket ID (via keyword search on `content`).

---

## Architecture

```
┌──────────────────────────────────────────────┐
│                  Entry Points                │
├──────────────────┬───────────────────────────┤
│  /standup cmd    │  standup_intelligence     │
│  (Ask Mode)      │  tool (Agent Mode)        │
├──────────────────┴───────────────────────────┤
│            StandupService (singleton)        │
│  ┌──────────────────────────────────────┐    │
│  │  parseStandup(notes) → StandupRecord │    │
│  │  getMyTasks(name) → Commitment[]     │    │
│  │  getBlockers() → Blocker[]           │    │
│  │  trackCommitments() → StatusReport   │    │
│  │  queryHistory(filter) → StandupRec[] │    │
│  └──────────────────────────────────────┘    │
├──────────────────────────────────────────────┤
│              Storage Layer                   │
│  MemoryTool (project-scoped JSON entries)    │
├──────────────────────────────────────────────┤
│          Optional Enrichment (v2)            │
│  GitLab MCP ─── Jira MCP ─── git_ops tool   │
│  (MR status)    (ticket)     (commit log)    │
└──────────────────────────────────────────────┘
```

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/services/standup.service.ts` | **Create** | Core service: parse, store, query |
| `src/services/standup.interfaces.ts` | **Create** | Types: StandupRecord, Commitment, etc. |
| `src/agents/langgraph/tools/standup.ts` | **Create** | Agent tool wrapper |
| `src/agents/langgraph/tools/provider.ts` | **Modify** | Register StandupToolFactory |
| `src/webview-providers/base.ts` | **Modify** | Add `/standup` slash command |
| `src/webview-providers/handlers/standup-handler.ts` | **Create** | Handler for Ask mode |
| `src/webview-providers/handlers/index.ts` | **Modify** | Export handler |
| `src/test/suite/standup.service.test.ts` | **Create** | Unit tests |

## Settings

```jsonc
// package.json contributions
"codebuddy.standup.myName": {
  "type": "string",
  "description": "Your name as it appears in standup notes (for filtering your tasks)"
}
```

## Example Flow

**User pastes in Ask mode:**

```
/standup Mar 17, 2026 ... <meeting notes>
```

**CodeBuddy responds:**

```markdown
## 📋 Standup Summary — March 17, 2026

### Your Action Items
1. ⬜ Get MR !1279 reviewed and merged (blocks Nelson on #1287)
2. ⬜ Code reviews on 2 MRs from Nelson

### Blockers
- 🔴 #1288 → blocked by #1279 (needs your MR merged first)

### Key Decisions
- Focus on non-LMS items (capital office, settlement, APO, CMS)
- She Tu will discuss resource allocation with Ibrahim

### Team Commitments (5 total)
- Marcus: Review payment service MR, release email ticket before lunch
- Nelson: Code review 2 MRs, indexing ticket for CMS + dashboard
- She Tu: Deploy PDF generator, test data consistency
```

**Later in Agent mode:**

```
"What did Marcus commit to doing today?"
→ Agent calls standup_intelligence({ operation: "my_tasks", args: { person: "Marcus" }})
→ "Marcus committed to: (1) reviewing the payment service MR, (2) releasing the email ticket before lunch."
```

---

## Out of Scope (v2 Ideas)

- **MR/ticket status enrichment** — cross-reference commitments with GitLab MR state
- **Commitment completion tracking** — compare standup promises with git log
- **Webview dashboard** — visual standup summary with cards per person
- **Auto-ingest** — Google Calendar integration to pull notes automatically
- **Team analytics** — commitment completion rates, blocker frequency, velocity
