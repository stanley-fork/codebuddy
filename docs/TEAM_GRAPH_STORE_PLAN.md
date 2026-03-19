# Team Graph Store — Implementation Plan

## Problem

Standup/meeting data is currently stored via `MemoryTool` in `.codebuddy/memory.json`.
This has three critical issues:

1. **Data loss on restart** — the JSON file is volatile and can be wiped when the extension reloads or the workspace is reopened.
2. **No relational queries** — searching for "all commitments by person X across standups" requires loading every entry and filtering in-memory.
3. **No relationship tracking** — we can't model who works with whom, who blocks whom, or how team dynamics evolve over time.

## Solution

Replace `MemoryTool`-based standup storage with a **SQLite-backed graph store** (`TeamGraphStore`) that models people as nodes, relationships as weighted edges, and standups/commitments/blockers as normalized tables with foreign keys.

The store uses the same `sql.js` WASM engine already used by `SqliteDatabaseService`, `SqliteVectorStore`, and `SqlJsCheckpointSaver` — no new native dependencies.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                MeetingIntelligenceService             │
│   parseStandup() → store() → loadStandups()          │
│   getMyTasks() · getBlockers() · queryHistory()      │
│   getRecentSummaries() · deleteStandup()             │
└────────────────────────┬─────────────────────────────┘
                         │ delegates storage to
                         ▼
┌──────────────────────────────────────────────────────┐
│                   TeamGraphStore                      │
│   .codebuddy/team_graph.db  (sql.js WASM SQLite)     │
│                                                       │
│   Tables (nodes):  people                             │
│   Tables (data):   standups, commitments, blockers,   │
│                    decisions, ticket_mentions          │
│   Tables (edges):  relationships                      │
│                                                       │
│   APIs:                                               │
│     storeStandup(record) — upserts everything         │
│     loadStandups(limit)                               │
│     deleteStandup(date, team)                         │
│     getRecentSummaries(limit)                         │
│     upsertPerson(name, date) → id                    │
│     updateTraits(personId, traits)                    │
│     upsertRelationship(src, tgt, kind)                │
│     getTopCollaborators(personId, limit)              │
│     getCommitmentsFor(personId, limit)                │
│     getStandupsByDateRange(since, until)              │
│     getStandupsByTicket(ticketId)                     │
│     getTeamSummary() → markdown string                │
│     pruneOldStandups(maxCount)                        │
└──────────────────────────────────────────────────────┘
```

---

## Database Schema

**File:** `.codebuddy/team_graph.db`

### `people` (nodes)

| Column           | Type    | Notes                                    |
|------------------|---------|------------------------------------------|
| id               | INTEGER | PK autoincrement                         |
| name             | TEXT    | Display name as seen in notes            |
| canonical_name   | TEXT    | UNIQUE, lowercase trimmed (for matching) |
| role             | TEXT    | Nullable — inferred from meeting context |
| traits           | TEXT    | JSON object — personality/behavior data  |
| standup_count    | INTEGER | How many standups they appeared in       |
| commitment_count | INTEGER | Total commitments made                   |
| completion_count | INTEGER | Commitments marked done                  |
| first_seen       | TEXT    | ISO date of first appearance             |
| last_seen        | TEXT    | ISO date of most recent appearance       |

Indexed on `canonical_name`.

### `standups`

| Column     | Type    | Notes                          |
|------------|---------|--------------------------------|
| id         | INTEGER | PK autoincrement               |
| date       | TEXT    | YYYY-MM-DD                     |
| team_name  | TEXT    |                                |
| raw_json   | TEXT    | Full StandupRecord JSON        |
| created_at | TEXT    | Auto-populated datetime        |

UNIQUE constraint on `(date, team_name)`. Indexed on `date`.

### `commitments`

| Column     | Type    | Notes                               |
|------------|---------|-------------------------------------|
| id         | INTEGER | PK autoincrement                    |
| standup_id | INTEGER | FK → standups(id) ON DELETE CASCADE |
| person_id  | INTEGER | FK → people(id) ON DELETE CASCADE   |
| action     | TEXT    | What they committed to              |
| deadline   | TEXT    | Nullable                            |
| ticket_ids | TEXT    | JSON array of strings               |
| status     | TEXT    | 'pending' or 'done'                 |

Indexed on `person_id` and `standup_id`.

### `blockers`

| Column     | Type    | Notes                               |
|------------|---------|-------------------------------------|
| id         | INTEGER | PK autoincrement                    |
| standup_id | INTEGER | FK → standups(id) ON DELETE CASCADE |
| blocked    | TEXT    | What is blocked                     |
| blocked_by | TEXT    | What is blocking it                 |
| owner_id   | INTEGER | FK → people(id), nullable           |
| reason     | TEXT    |                                     |

### `decisions`

| Column       | Type    | Notes                               |
|--------------|---------|-------------------------------------|
| id           | INTEGER | PK autoincrement                    |
| standup_id   | INTEGER | FK → standups(id) ON DELETE CASCADE |
| summary      | TEXT    |                                     |
| participants | TEXT    | JSON array of names                 |

### `ticket_mentions`

| Column      | Type    | Notes                               |
|-------------|---------|-------------------------------------|
| id          | INTEGER | PK autoincrement                    |
| standup_id  | INTEGER | FK → standups(id) ON DELETE CASCADE |
| ticket_id   | TEXT    | e.g. "1279"                         |
| context     | TEXT    | What was said about the ticket      |
| assignee_id | INTEGER | FK → people(id), nullable           |

Indexed on `ticket_id`.

### `relationships` (edges)

| Column           | Type    | Notes                                    |
|------------------|---------|------------------------------------------|
| id               | INTEGER | PK autoincrement                         |
| source_person_id | INTEGER | FK → people(id) ON DELETE CASCADE        |
| target_person_id | INTEGER | FK → people(id) ON DELETE CASCADE        |
| kind             | TEXT    | collaborates_with, blocks, reviews_for, reports_to, mentors |
| weight           | INTEGER | Incremented on each co-occurrence        |
| metadata         | TEXT    | JSON — latest context                    |
| updated_at       | TEXT    | Auto-updated datetime                    |

UNIQUE on `(source_person_id, target_person_id, kind)`. Indexed on both person IDs.

---

## Implementation Steps

### Step 1 — TeamGraphStore service (DONE)

File: `src/services/team-graph-store.ts`

Already created with:
- sql.js initialization (same WASM path pattern as SqliteDatabaseService)
- Full schema creation with foreign keys and indexes
- People CRUD: `upsertPerson`, `updateRole`, `updateTraits`, `getPersonByName`, `getAllPeople`
- Relationship CRUD: `upsertRelationship`, `getRelationshipsFor`, `getTopCollaborators`
- Standup storage: `storeStandup` (upserts everything + builds collaboration/blocking edges)
- Standup queries: `loadStandups`, `deleteStandup`, `getRecentSummaries`, `getStandupsByDateRange`, `getStandupsByTicket`
- Utility: `pruneOldStandups`, `getTeamSummary` (markdown for LLM context)
- Debounced `saveToDisk()`, proper `dispose()`

### Step 2 — Migrate MeetingIntelligenceService storage (DONE)

File: `src/services/meeting-intelligence.service.ts`

Changes:
1. Add `TeamGraphStore` as a dependency (initialize in constructor or lazily)
2. Replace `store()` method — call `teamGraph.storeStandup(record)` instead of `memoryTool.execute("add", ...)`
3. Replace `loadStandups()` — call `teamGraph.loadStandups()` instead of searching MemoryTool
4. Replace `deleteStandup()` — call `teamGraph.deleteStandup(date, teamName)`
5. Replace `getRecentSummaries()` — delegate to `teamGraph.getRecentSummaries(limit)`
6. Replace `pruneOldStandups()` — call `teamGraph.pruneOldStandups(MAX_STORED_STANDUPS)`
7. Remove MemoryTool dependency entirely (it's no longer needed for standups)
8. Remove `standupCache` in-memory cache — SQLite is fast enough for the query volumes we see

### Step 3 — Register TeamGraphStore for disposal (DONE)

File: `src/extension.ts`

- Import `TeamGraphStore`
- Call `TeamGraphStore.getInstance().initialize()` during activation
- Push to `context.subscriptions` for proper cleanup

### Step 4 — One-time migration of existing memory.json data (DONE)

File: `src/services/meeting-intelligence.service.ts` (or TeamGraphStore)

On first `initialize()`:
1. Check if `.codebuddy/memory.json` exists and has standup entries
2. If TeamGraphStore is empty (0 standups), iterate the memory entries
3. Parse each standup `content` JSON → call `storeStandup(record)`
4. Log how many records were migrated
5. Do NOT delete the memory.json entries (other non-standup memories live there too)

### Step 5 — Enhance query methods to leverage SQL (DONE)

File: `src/services/meeting-intelligence.service.ts`

Upgrade existing methods:
- `getMyTasks(person)` — join `commitments` with `people` by canonical_name instead of loading all standups
- `getBlockers()` — direct query on `blockers` table with owner person name join
- `queryHistory(filter)` — use `getStandupsByDateRange`, `getStandupsByTicket`, or person filter via SQL
- `filterByDateRange()` — now handled at the SQL level, remove in-memory filtering

### Step 6 — Expose team graph data to the webview

Files: `standup-handler.ts`, `standup.store.ts`, `useMessageDispatcher.ts`

New commands:
- `standup-team-summary` — returns `teamGraph.getTeamSummary()` markdown for display
- `standup-person-profile` — returns a person's profile + top collaborators + recent commitments

(Future — not blocking the core system.)

### Step 7 — Build and verify (DONE)

- `npm run compile` — check no TS errors ✅
- `npm run build` — full pipeline ✅
- Manual test: ingest notes, restart extension, verify data persists ✅
- Manual test: ingest 2–3 standups, check that people/relationships are populated ✅

---

## What This Enables (Future)

1. ~~**Team personality profiling**~~ — ✅ **Shipped** (Phase 1). Traits JSON accumulates role, expertise, work-style. Zod-validated `PersonTraitsSchema`.
2. **Relationship graph visualization** — render the people + edges in a webview (D3 force graph)
3. **Smart assignment suggestions** — "Based on past standups, Alice usually handles ticket patterns matching X"
4. ~~**Standup trend analysis**~~ — ✅ **Shipped** (Phase 3). `completion_trends` and `team_health` operations.
5. ~~**Cross-standup context**~~ — ✅ **Shipped** (Phase 3). `ticket_history` operation with `json_each()` lookup.
6. ~~**Role inference**~~ — ✅ **Shipped** (Phase 4). `reviews_for`, `reports_to`, `mentors`, `depends_on` relationships detected from meeting notes.

---

## Files Modified

| File | Change |
|------|--------|
| `src/services/team-graph-store.ts` | Full graph store: 7 tables, `PersonTraitsSchema` Zod validation, `json_each()` queries, `normalizePersonName()`, `isReady()` guards |
| `src/services/meeting-intelligence.service.ts` | LLM parsing, trait extraction (serial queue, exp backoff), MemoryTool migration, `normalizePersonName()` |
| `src/services/llm-safety.ts` | NEW — shared `sanitizeForLLM()` + 14 injection patterns |
| `src/services/enhanced-prompt-builder.service.ts` | Team context injection for Ask mode (keyword gate, TTL cache, sanitization) |
| `src/agents/langgraph/tools/team-graph.ts` | NEW — `team_graph` StructuredTool with 7 operations, Zod safeParse, egress sanitization |
| `src/agents/langgraph/tools/provider.ts` | Registered `TeamGraphToolFactory`, role mappings |
| `src/extension.ts` | Register TeamGraphStore for init + disposal |
| `src/shared/standup.types.ts` | `DetectedRelationship` type, `normalizePersonName()` utility |
| `src/webview-providers/handlers/standup-handler.ts` | `getRecentSummaries` from graph store |

## Files NOT Modified

| File | Reason |
|------|--------|
| `src/tools/memory.ts` | Still used for non-standup memories (knowledge, rules) |
| `webviewUi/src/**` | No UI changes — same data shape |
| `src/agents/langgraph/tools/standup.ts` | Calls MeetingIntelligenceService API, no direct storage access |
| `src/agents/developer/agent.ts` | Agent uses `team_graph` tool on-demand (no blind context injection) |
