# Standup Intelligence — Feature Spec

> **Status: MVP Shipped + Team Intelligence Extension (Phases 1–4)**

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

**Storage:** SQLite-backed `TeamGraphStore` (`.codebuddy/team_graph.db`) using sql.js WASM.

> **Note:** The original spec called for `MemoryTool` with JSON entries. This was replaced by the relational graph store — see [TEAM_GRAPH_STORE_PLAN.md](TEAM_GRAPH_STORE_PLAN.md).

**Schema:** 7 normalized tables — `people`, `standups`, `commitments`, `blockers`, `decisions`, `ticket_mentions`, `relationships`.

**Retention:** Keep last 30 standups. Auto-prune older entries on ingest.

**Queryable by:** Date, person name (normalized via `normalizePersonName()`), ticket ID (via `json_each()`), person relationships.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│                  Entry Points                │
├──────────────────┬───────────────────────────┤
│  /standup cmd    │  standup_intelligence     │
│  (Ask Mode)      │  tool (Agent Mode)        │
├──────────────────┴───────────────────────────┤
│       MeetingIntelligenceService (singleton)  │
│  ┌──────────────────────────────────────┐    │
│  │  parseStandup(notes) → StandupRecord │    │
│  │  ingest() + extractTraits() (bg LLM) │    │
│  │  getMyTasks(name) → Commitment[]     │    │
│  │  getBlockers() → Blocker[]           │    │
│  │  queryHistory(filter) → StandupRec[] │    │
│  └──────────────────────────────────────┘    │
├──────────────────────────────────────────────┤
│              Storage Layer                   │
│  TeamGraphStore (SQLite via sql.js WASM)     │
│  7 tables: people, standups, commitments,    │
│  blockers, decisions, ticket_mentions,        │
│  relationships                                │
├──────────────────────────────────────────────┤
│              Query Layer                     │
│  team_graph tool (LangGraph, 7 operations)   │
│  EnhancedPromptBuilder (Ask mode injection)  │
│  llm-safety.ts (shared sanitization)         │
├──────────────────────────────────────────────┤
│          Optional Enrichment (v2)            │
│  GitLab MCP ─── Jira MCP ─── git_ops tool   │
│  (MR status)    (ticket)     (commit log)    │
└──────────────────────────────────────────────┘
```

## Files Created/Modified

| File | Action | Purpose |
|------|--------|---------|
| `src/services/meeting-intelligence.service.ts` | **Created** | Core service: parse, store, query, trait extraction |
| `src/services/standup.interfaces.ts` | **Created** | Service-layer type re-exports |
| `src/shared/standup.types.ts` | **Created** | Shared types + `normalizePersonName()` utility |
| `src/services/team-graph-store.ts` | **Created** | SQLite graph store (7 tables, Zod-validated traits) |
| `src/services/llm-safety.ts` | **Created** | Shared `sanitizeForLLM()` + injection patterns |
| `src/services/enhanced-prompt-builder.service.ts` | **Modified** | Team context injection for Ask mode |
| `src/agents/langgraph/tools/standup.ts` | **Created** | `standup_intelligence` agent tool wrapper |
| `src/agents/langgraph/tools/team-graph.ts` | **Created** | `team_graph` StructuredTool (7 operations) |
| `src/agents/langgraph/tools/provider.ts` | **Modified** | Register tool factories + role mappings |
| `src/webview-providers/base.ts` | **Modified** | Add `/standup` slash command |
| `src/webview-providers/handlers/standup-handler.ts` | **Created** | Handler for Ask mode |
| `src/extension.ts` | **Modified** | Register TeamGraphStore for init + disposal |

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
- ~~**Team analytics**~~ — ✅ **Shipped** as `team_health`, `completion_trends`, `recurring_blockers` operations
- **Identity resolution** — merge duplicate person records (Phase 5)
- **Proactive pattern detection** — auto-surface chronic blockers, velocity drops, overload (Phase 6)
- **Relationship graph visualization** — D3 force graph in the webview
