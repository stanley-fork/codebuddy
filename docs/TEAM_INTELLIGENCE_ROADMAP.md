# Team Intelligence Roadmap

> How the Team Graph evolves from passive storage into an intelligent system that knows your team.

## Current State (v1 — Shipped)

The `TeamGraphStore` persists standup data in SQLite with 7 tables. On each ingest:

- **People** are upserted with `standup_count`, `commitment_count`, `completion_count`, `first_seen`, `last_seen`
- **Collaboration edges** are built: every pair of standup participants → `collaborates_with` (weight increments per co-occurrence)
- **Blocking edges** are built: blocker owner → person committed on the blocked ticket → `blocks`
- **Commitments, blockers, decisions, ticket mentions** are stored relationally with foreign keys

The agent can answer: `/standup-my-tasks`, `/standup-blockers`, `/standup-history`.

---

## Phase 1: Post-Ingest Trait Extraction

**Goal:** After every standup ingest, run a lightweight LLM pass to extract role and expertise signals from the commitments and context.

### How It Works

```
standup ingested → storeStandup() → extractTraitsFromRecord(record) → updateRole() / updateTraits()
```

The extraction prompt would receive the person's commitments across the last N standups and produce:

```json
{
  "role": "Frontend Engineer",
  "expertise": ["React", "performance", "accessibility"],
  "workStyle": "fast-mover",
  "reliability": "high"
}
```

### Data Signals Available

| Signal | Source | Example |
|--------|--------|---------|
| Role | Repeated action patterns | "deploying", "reviewing MRs", "writing tests" → QA Engineer |
| Expertise | Ticket context + actions | "optimized Webpack config", "fixed memory leak" → build tooling, performance |
| Work style | Commitment patterns | Always takes 3+ items → high-throughput; always finishes → reliable |
| Blocker frequency | Blocker table | Blocked 4 of last 6 standups → at-risk |

### Implementation

- Add `extractTraitsForParticipants(record: StandupRecord)` to `MeetingIntelligenceService`
- Call it at the end of `ingest()` / `ingestStructured()`, fire-and-forget (non-blocking)
- Use a cheaper/faster model (e.g. Groq Llama) since this is background enrichment
- Accumulate traits over time — don't overwrite, merge with confidence scores

### Files to Change

- `src/services/meeting-intelligence.service.ts` — add `extractTraitsForParticipants()`
- `src/services/team-graph-store.ts` — `updateTraits()` already exists, just needs callers

---

## Phase 2: Team Summary as Agent Context

**Goal:** Inject the team graph summary into the agent's system prompt so it can answer natural language questions about the team.

### How It Works

```
user asks "Who should review my Kubernetes PR?"
  → agent system prompt includes getTeamSummary() output
  → LLM sees: "Alice (DevOps Engineer) — 12 standups, 89% completion, expertise: [k8s, CI/CD]"
  → LLM answers: "Alice is your best bet — she's the most active DevOps engineer with k8s expertise"
```

### Questions This Enables

- "Who should I talk to about ticket #1279?"
- "Who are the strongest collaborators on the backend team?"
- "Is Alice reliable?"
- "Who's been blocked the most this week?"
- "What's the team's velocity trend?"

### Implementation

- `getTeamSummary()` already exists and outputs markdown
- Enhance it to include: expertise tags, blocker frequency, recent activity
- Wire it into the enhanced prompt builder (`EnhancedPromptBuilderService`) as a "team context" section
- Gate behind a config flag: `codebuddy.standup.injectTeamContext` (default: true)

### Files to Change

- `src/services/team-graph-store.ts` — enhance `getTeamSummary()` with expertise + blocker data
- `src/services/enhanced-prompt-builder.service.ts` — inject team summary into LLM context

---

## Phase 3: Graph Query Tools for the Agent

**Goal:** Register dedicated query methods as LangGraph tools so the agent can answer open-ended questions by querying the graph.

### Tools to Build

| Tool Name | Description | Example Question |
|-----------|-------------|-----------------|
| `getPersonProfile` | Full profile: role, expertise, stats, relationships, recent commitments | "Tell me about Alice" |
| `getTopCollaborators` | Strongest collaboration edges for a person | "Who does Bob work with most?" |
| `getRecurringBlockers` | People/tickets that appear in blockers repeatedly | "What keeps blocking us?" |
| `getCompletionTrends` | Commitment completion rate over time windows | "Is Alice's velocity improving?" |
| `getTicketHistory` | All standups, commitments, blockers mentioning a ticket | "What's the full story on #1279?" |
| `getTeamHealth` | Aggregate: avg completion rate, blocker count trend, collaboration density | "How is the team doing?" |

### Implementation Pattern

Each tool is a `StructuredTool` registered in the LangGraph agent's tool belt:

```typescript
// In src/agents/langgraph/tools/team-graph.ts
class PersonProfileTool extends StructuredTool {
  name = "get_person_profile";
  description = "Get a team member's full profile including role, expertise, reliability stats, and relationships";
  schema = z.object({ name: z.string().describe("Person's name") });

  async _call({ name }: { name: string }): Promise<string> {
    const store = TeamGraphStore.getInstance();
    const person = store.getPersonByName(name);
    if (!person) return `No profile found for "${name}"`;
    const collaborators = store.getTopCollaborators(person.id);
    const commitments = store.getCommitmentsFor(person.id, 10);
    // Format as markdown for LLM consumption
    return formatPersonProfile(person, collaborators, commitments);
  }
}
```

### New SQL Queries Needed in TeamGraphStore

```sql
-- getRecurringBlockers: people who appear as blocker owners >= N times
SELECT p.name, COUNT(*) as block_count
FROM blockers b
JOIN people p ON b.owner_id = p.id
GROUP BY p.id
HAVING block_count >= 2
ORDER BY block_count DESC;

-- getCompletionTrends: completion rate by week
SELECT
  strftime('%Y-W%W', s.date) AS week,
  COUNT(CASE WHEN c.status = 'done' THEN 1 END) AS completed,
  COUNT(*) AS total
FROM commitments c
JOIN standups s ON c.standup_id = s.id
WHERE c.person_id = ?
GROUP BY week
ORDER BY week DESC
LIMIT 8;
```

### Files to Change

- `src/services/team-graph-store.ts` — add `getRecurringBlockers()`, `getCompletionTrends()`, `getTeamHealth()`
- `src/agents/langgraph/tools/team-graph.ts` — new file, 6 StructuredTool classes
- `src/agents/langgraph/tools/index.ts` — register the new tools

---

## Phase 4: Enhanced Relationship Detection

**Goal:** Extract richer relationship types from meeting notes beyond collaboration and blocking.

### New Relationship Types

| Kind | Detection Signal | Example in Notes |
|------|-----------------|-----------------|
| `reviews_for` | "reviewed", "approved MR", "left comments on" | "Alice reviewed Bob's MR !1279" |
| `reports_to` | "Bob's team", "reporting to", "manager" | "escalated to Alice (Bob's manager)" |
| `mentors` | "paired with", "onboarding", "shadowing" | "Carol is onboarding Dave this week" |
| `depends_on` | "waiting for", "needs X's API first" | "Frontend depends on Bob's API changes" |

### Implementation

Extend the LLM parse prompt to also output a `relationships` array:

```json
{
  "relationships": [
    { "source": "Alice", "target": "Bob", "kind": "reviews_for", "context": "MR !1279" },
    { "source": "Carol", "target": "Dave", "kind": "mentors", "context": "onboarding" }
  ]
}
```

Update `StandupRecordSchema` to include an optional `relationships` field, and `storeStandup()` to persist detected edges.

### Files to Change

- `src/services/meeting-intelligence.service.ts` — extend `buildParsePrompt()` and Zod schema
- `src/shared/standup.types.ts` — add `DetectedRelationship` type
- `src/services/team-graph-store.ts` — handle relationship array in `storeStandup()`

---

## Phase 5: Identity Resolution

**Goal:** Merge duplicate person records and handle nickname/abbreviation variations.

### Problem

- "Ali K." and "Alikhan Kurmangaliyev" are stored as separate people
- "Ben" could be "Benjamin Torres" or "Benoit Marchand"

### Approach

1. **Same-standup exclusion** — If two names never appear in the same standup, they might be the same person
2. **Ticket overlap** — If "Ali K." and "Alikhan" both commit to the same tickets, confidence increases
3. **LLM-assisted merging** — Present candidate pairs to the LLM: "Are these the same person? Ali K. (works on #1279, #1301) and Alikhan Kurmangaliyev (works on #1279, #1305)"
4. **Manual confirmation** — Surface merge suggestions in the webview: "We think Ali K. and Alikhan are the same person. Merge?"

### Data Model

Add an `aliases` table:

```sql
CREATE TABLE IF NOT EXISTS person_aliases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  alias      TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5
);
```

---

## Phase 6: Proactive Pattern Detection

**Goal:** Surface insights automatically rather than waiting for questions.

### Patterns to Detect

| Pattern | Trigger | Output |
|---------|---------|--------|
| Chronic blocker | Same person/ticket in blockers 3+ times in 2 weeks | "⚠️ Ticket #1279 has been blocked for 3 consecutive standups" |
| Velocity drop | Completion rate drops >30% over 2-week window | "📉 Bob's completion rate dropped from 80% to 45%" |
| Silo risk | Two people who used to collaborate stop appearing together | "Alice and Dave haven't overlapped in 3 weeks" |
| Overload | Person has >5 active commitments across standups | "⚠️ Carol has 7 open commitments — possible overload" |
| New member | Person appears for the first time | "👋 New team member detected: Eve (first seen today)" |

### Implementation

- Run pattern checks after each ingest (lightweight SQL queries, no LLM)
- Surface via VS Code notifications or a "Team Insights" section in the CoWorker panel
- Store detected insights in a new `insights` table with `dismissed` flag for user control

---

## Priority Order

| Phase | Effort | Impact | Dependencies |
|-------|--------|--------|-------------|
| **Phase 2** — Team summary in agent context | Small | High | None |
| **Phase 1** — Post-ingest trait extraction | Medium | High | None |
| **Phase 3** — Graph query tools | Medium | Very High | Phase 1 (for richer data) |
| **Phase 4** — Enhanced relationships | Small | Medium | None |
| **Phase 6** — Proactive patterns | Medium | High | Phase 1 |
| **Phase 5** — Identity resolution | Large | Medium | Phase 3 |

---

## Architecture Diagram

```
Daily Standup Notes
       │
       ▼
┌─────────────────────┐
│  MeetingIntelligence │
│     Service          │
│  (LLM parse + store) │
└──────┬──────────────┘
       │
       ├── storeStandup() ─────────┐
       │                           ▼
       │                  ┌─────────────────┐
       │                  │ TeamGraphStore   │
       │                  │ (SQLite)         │
       │                  │                  │
       │                  │  people ────┐    │
       │                  │  standups   │    │
       │                  │  commitments│    │
       │                  │  blockers   │    │
       │                  │  decisions  │    │
       │                  │  tickets    │    │
       │                  │  relationships   │
       │                  └──────┬──────────┘
       │                         │
       ├─ extractTraits() ───────┤  (Phase 1)
       │                         │
       ▼                         ▼
┌──────────────┐      ┌──────────────────┐
│ Agent Tools  │◀─────│  Query Methods   │  (Phase 3)
│ (LangGraph)  │      │  getPersonProfile│
│              │      │  getTeamHealth   │
│ Natural      │      │  getTicketHistory│
│ Language Q&A │      └──────────────────┘
└──────────────┘
       │
       ▼
┌──────────────┐
│ Team Summary │──▶ Agent System Prompt  (Phase 2)
│ (Markdown)   │
└──────────────┘
```
