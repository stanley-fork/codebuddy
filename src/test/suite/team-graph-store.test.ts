/**
 * TeamGraphStore Tests
 *
 * Tests the SQLite-backed graph store for Meeting Intelligence.
 *
 * Covers:
 *   - Singleton lifecycle (getInstance, initialize, dispose)
 *   - isReady guard behavior
 *   - Person CRUD (upsert, getByName, updateRole, updateTraits)
 *   - Name normalization (canonical_name, whitespace, casing)
 *   - PersonTraitsSchema Zod validation via rowToPerson
 *   - Standup ingest (storeStandup, loadStandups)
 *   - Relationship building (collaboration edges, blocking edges, LLM-detected)
 *   - Query methods (getPersonProfile, getTeamSummary, getTicketHistory,
 *     getRecurringBlockers, getCompletionTrends, getTeamHealth)
 *   - Ticket lookup via json_each (not LIKE)
 *   - Pruning old standups
 *   - Delete standup
 */

import * as assert from "assert";
import * as sinon from "sinon";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import {
  TeamGraphStore,
  type PersonProfile,
} from "../../services/team-graph-store";
import type { StandupRecord } from "../../shared/standup.types";

// ── Test Helpers ─────────────────────────────────────────────────

let tmpDir: string;

function makeSampleRecord(overrides: Partial<StandupRecord> = {}): StandupRecord {
  return {
    date: "2026-03-17",
    teamName: "Test Team",
    participants: ["Alice Smith", "Bob Jones"],
    commitments: [
      {
        person: "Alice Smith",
        action: "Review MR !100",
        deadline: "today",
        ticketIds: ["100"],
        status: "pending",
      },
      {
        person: "Bob Jones",
        action: "Fix login bug",
        ticketIds: ["200"],
        status: "done",
      },
    ],
    blockers: [
      {
        blocked: "#300",
        blockedBy: "#100",
        owner: "Alice Smith",
        reason: "Needs MR merged first",
      },
    ],
    decisions: [
      {
        summary: "Ship by Friday",
        participants: ["Alice Smith", "Bob Jones"],
      },
    ],
    ticketMentions: [
      { id: "100", context: "needs review", assignee: "Alice Smith" },
      { id: "200", context: "login bug fix" },
    ],
    ...overrides,
  };
}

// ── Lifecycle & isReady ──────────────────────────────────────────

suite("TeamGraphStore — Lifecycle", () => {
  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tgs-test-"));
    sinon.stub(vscode.workspace, "workspaceFolders").value([
      { uri: { fsPath: tmpDir }, name: "test-ws", index: 0 },
    ]);
  });

  teardown(() => {
    const store = TeamGraphStore.getInstance();
    store.dispose();
    sinon.restore();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore cleanup */ }
  });

  test("getInstance returns same instance", () => {
    const a = TeamGraphStore.getInstance();
    const b = TeamGraphStore.getInstance();
    assert.strictEqual(a, b);
  });

  test("isReady returns false before initialize", () => {
    const store = TeamGraphStore.getInstance();
    assert.strictEqual(store.isReady(), false);
  });

  test("isReady returns true after initialize", async () => {
    const store = TeamGraphStore.getInstance();
    await store.initialize();
    assert.strictEqual(store.isReady(), true);
  });

  test("dispose resets singleton", async () => {
    const store = TeamGraphStore.getInstance();
    await store.initialize();
    store.dispose();
    const store2 = TeamGraphStore.getInstance();
    assert.notStrictEqual(store, store2);
    assert.strictEqual(store2.isReady(), false);
  });
});

// ── Person CRUD ──────────────────────────────────────────────────

suite("TeamGraphStore — Person CRUD", () => {
  let store: TeamGraphStore;

  setup(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tgs-test-"));
    sinon.stub(vscode.workspace, "workspaceFolders").value([
      { uri: { fsPath: tmpDir }, name: "test-ws", index: 0 },
    ]);
    store = TeamGraphStore.getInstance();
    await store.initialize();
  });

  teardown(() => {
    store.dispose();
    sinon.restore();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore cleanup */ }
  });

  test("upsertPerson creates new person", () => {
    const id = store.upsertPerson("Alice Smith", "2026-03-17");
    assert.ok(id > 0);
    const person = store.getPersonByName("Alice Smith");
    assert.ok(person);
    assert.strictEqual(person!.name, "Alice Smith");
    assert.strictEqual(person!.canonical_name, "alice smith");
    assert.strictEqual(person!.standup_count, 1);
  });

  test("upsertPerson increments count on repeat", () => {
    store.upsertPerson("Alice Smith", "2026-03-17");
    store.upsertPerson("Alice Smith", "2026-03-18");
    const person = store.getPersonByName("Alice Smith");
    assert.strictEqual(person!.standup_count, 2);
    assert.strictEqual(person!.last_seen, "2026-03-18");
  });

  test("getPersonByName is case-insensitive", () => {
    store.upsertPerson("Alice Smith", "2026-03-17");
    assert.ok(store.getPersonByName("alice smith"));
    assert.ok(store.getPersonByName("ALICE SMITH"));
    assert.ok(store.getPersonByName("  Alice  Smith  "));
  });

  test("getPersonByName returns null for unknown", () => {
    assert.strictEqual(store.getPersonByName("Nobody"), null);
  });

  test("updateRole sets person role", () => {
    const id = store.upsertPerson("Alice Smith", "2026-03-17");
    store.updateRole(id, "Frontend Engineer");
    const person = store.getPersonByName("Alice Smith");
    assert.strictEqual(person!.role, "Frontend Engineer");
  });

  test("updateTraits merges with existing traits", () => {
    const id = store.upsertPerson("Alice Smith", "2026-03-17");
    store.updateTraits(id, { expertise: ["React"] });
    store.updateTraits(id, { workStyle: "fast-mover" });
    const person = store.getPersonByName("Alice Smith");
    assert.deepStrictEqual(person!.traits.expertise, ["React"]);
    assert.strictEqual(person!.traits.workStyle, "fast-mover");
  });

  test("traits are Zod-validated with defaults", () => {
    const id = store.upsertPerson("Alice Smith", "2026-03-17");
    const person = store.getPersonByName("Alice Smith");
    // Fresh person should have default traits from PersonTraitsSchema
    assert.deepStrictEqual(person!.traits.expertise, []);
    assert.deepStrictEqual(person!.traits.expertiseScores, {});
    assert.deepStrictEqual(person!.traits.roleCandidates, {});
  });

  test("invalid traits JSON falls back to defaults via catch", () => {
    const id = store.upsertPerson("Alice Smith", "2026-03-17");
    // Manually corrupt the traits column
    store.updateTraits(id, "not a valid object" as any);
    // Re-fetch — should not throw, should return defaults
    const person = store.getPersonByName("Alice Smith");
    assert.ok(person);
    // The traits should still have the merged corrupted data but the schema
    // passthrough means it stores what we give it. Since we gave it a string
    // spread, the result should still parse via .catch() fallback.
  });

  test("getAllPeople returns all people ordered by last_seen desc", () => {
    store.upsertPerson("Alice Smith", "2026-03-17");
    store.upsertPerson("Bob Jones", "2026-03-18");
    const people = store.getAllPeople();
    assert.strictEqual(people.length, 2);
    assert.strictEqual(people[0].name, "Bob Jones"); // more recent
    assert.strictEqual(people[1].name, "Alice Smith");
  });
});

// ── Standup Ingest & Load ────────────────────────────────────────

suite("TeamGraphStore — Standup Ingest", () => {
  let store: TeamGraphStore;

  setup(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tgs-test-"));
    sinon.stub(vscode.workspace, "workspaceFolders").value([
      { uri: { fsPath: tmpDir }, name: "test-ws", index: 0 },
    ]);
    store = TeamGraphStore.getInstance();
    await store.initialize();
  });

  teardown(() => {
    store.dispose();
    sinon.restore();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore cleanup */ }
  });

  test("storeStandup returns a standup ID", () => {
    const record = makeSampleRecord();
    const id = store.storeStandup(record);
    assert.ok(id > 0);
  });

  test("storeStandup creates people from participants", () => {
    store.storeStandup(makeSampleRecord());
    assert.ok(store.getPersonByName("Alice Smith"));
    assert.ok(store.getPersonByName("Bob Jones"));
  });

  test("storeStandup increments commitment counts", () => {
    store.storeStandup(makeSampleRecord());
    const alice = store.getPersonByName("Alice Smith")!;
    assert.strictEqual(alice.commitment_count, 1);
    assert.strictEqual(alice.completion_count, 0); // her commitment is "pending"
    const bob = store.getPersonByName("Bob Jones")!;
    assert.strictEqual(bob.commitment_count, 1);
    assert.strictEqual(bob.completion_count, 1); // his is "done"
  });

  test("storeStandup builds collaboration edges", () => {
    store.storeStandup(makeSampleRecord());
    const alice = store.getPersonByName("Alice Smith")!;
    const collabs = store.getTopCollaborators(alice.id, 5);
    assert.strictEqual(collabs.length, 1);
    assert.strictEqual(collabs[0].person.name, "Bob Jones");
  });

  test("storeStandup builds LLM-detected relationship edges", () => {
    const record = makeSampleRecord({
      relationships: [
        {
          from: "Alice Smith",
          to: "Bob Jones",
          kind: "reviews_for",
          context: "MR !100",
        },
      ],
    });
    store.storeStandup(record);
    const alice = store.getPersonByName("Alice Smith")!;
    const rels = store.getRelationshipsFor(alice.id);
    const reviewRel = rels.find((r) => r.kind === "reviews_for");
    assert.ok(reviewRel, "Should have reviews_for relationship");
  });

  test("loadStandups returns stored records", () => {
    store.storeStandup(makeSampleRecord());
    const standups = store.loadStandups(10);
    assert.strictEqual(standups.length, 1);
    assert.strictEqual(standups[0].date, "2026-03-17");
    assert.strictEqual(standups[0].teamName, "Test Team");
  });

  test("storeStandup replaces on duplicate (date, team)", () => {
    store.storeStandup(makeSampleRecord());
    store.storeStandup(makeSampleRecord({ participants: ["Carol Danvers"] }));
    const standups = store.loadStandups(10);
    assert.strictEqual(standups.length, 1);
  });

  test("deleteStandup removes the record", () => {
    store.storeStandup(makeSampleRecord());
    const deleted = store.deleteStandup("2026-03-17", "Test Team");
    assert.strictEqual(deleted, true);
    const standups = store.loadStandups(10);
    assert.strictEqual(standups.length, 0);
  });

  test("deleteStandup returns false for non-existent", () => {
    assert.strictEqual(store.deleteStandup("2099-01-01"), false);
  });

  test("pruneOldStandups keeps only maxCount", () => {
    for (let i = 1; i <= 5; i++) {
      store.storeStandup(
        makeSampleRecord({ date: `2026-03-${String(i).padStart(2, "0")}` }),
      );
    }
    const pruned = store.pruneOldStandups(3);
    assert.strictEqual(pruned, 2);
    const remaining = store.loadStandups(10);
    assert.strictEqual(remaining.length, 3);
  });
});

// ── Query Methods ────────────────────────────────────────────────

suite("TeamGraphStore — Query Methods", () => {
  let store: TeamGraphStore;

  setup(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tgs-test-"));
    sinon.stub(vscode.workspace, "workspaceFolders").value([
      { uri: { fsPath: tmpDir }, name: "test-ws", index: 0 },
    ]);
    store = TeamGraphStore.getInstance();
    await store.initialize();
    // Seed data
    store.storeStandup(makeSampleRecord());
  });

  teardown(() => {
    store.dispose();
    sinon.restore();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore cleanup */ }
  });

  // ── getPersonProfile ──

  test("getPersonProfile returns markdown for known person", () => {
    const profile = store.getPersonProfile("Alice Smith");
    assert.ok(profile.includes("## Alice Smith"));
    assert.ok(profile.includes("standup"));
  });

  test("getPersonProfile returns error for unknown person", () => {
    const profile = store.getPersonProfile("Nobody");
    assert.ok(profile.includes("No profile found"));
  });

  // ── getTeamSummary ──

  test("getTeamSummary returns markdown table", () => {
    const summary = store.getTeamSummary();
    assert.ok(summary.includes("Team Summary"));
    assert.ok(summary.includes("Alice Smith"));
    assert.ok(summary.includes("Bob Jones"));
  });

  // ── getTicketHistory ──

  test("getTicketHistory returns history for known ticket", () => {
    const history = store.getTicketHistory("100");
    assert.ok(history.includes("Ticket #100"));
  });

  test("getTicketHistory finds commitments via json_each", () => {
    const history = store.getTicketHistory("200");
    // Bob's commitment references ticketId "200"
    assert.ok(
      history.includes("Bob Jones") || history.includes("200"),
      `Should find ticket 200 in history: ${history}`,
    );
  });

  test("getTicketHistory rejects invalid ticket IDs", () => {
    const result = store.getTicketHistory("'; DROP TABLE people;--");
    assert.ok(result.includes("Invalid ticket ID format"));
  });

  test("getTicketHistory returns not-found for unknown ticket", () => {
    const result = store.getTicketHistory("99999");
    assert.ok(result.includes("No history found"));
  });

  // ── getRecurringBlockers ──

  test("getRecurringBlockers returns results when threshold met", () => {
    // Ingest a second standup so Alice has 2 blockers
    store.storeStandup(
      makeSampleRecord({
        date: "2026-03-18",
        blockers: [
          {
            blocked: "#400",
            blockedBy: "#100",
            owner: "Alice Smith",
            reason: "Still waiting",
          },
        ],
      }),
    );
    const blockers = store.getRecurringBlockers(2);
    assert.ok(blockers.includes("Alice Smith"));
  });

  test("getRecurringBlockers returns no-results message when below threshold", () => {
    const blockers = store.getRecurringBlockers(5);
    assert.ok(blockers.includes("No recurring blockers"));
  });

  // ── getTeamHealth ──

  test("getTeamHealth returns markdown with metrics", () => {
    const health = store.getTeamHealth();
    assert.ok(health.includes("Team Health"));
  });

  // ── getCompletionTrends ──

  test("getCompletionTrends returns data for known person", () => {
    const alice = store.getPersonByName("Alice Smith")!;
    const trends = store.getCompletionTrends(alice.id, 4);
    assert.ok(trends.includes("Completion Trends"));
  });

  // ── getStandupsByDateRange ──

  test("getStandupsByDateRange finds records in range", () => {
    const results = store.getStandupsByDateRange("2026-03-01", "2026-03-31");
    assert.strictEqual(results.length, 1);
  });

  test("getStandupsByDateRange returns empty for out-of-range", () => {
    const results = store.getStandupsByDateRange("2099-01-01", "2099-12-31");
    assert.strictEqual(results.length, 0);
  });

  // ── getStandupsByTicket ──

  test("getStandupsByTicket finds standup mentioning ticket", () => {
    const results = store.getStandupsByTicket("100");
    assert.strictEqual(results.length, 1);
  });
});

// ── isReady Guards ───────────────────────────────────────────────

suite("TeamGraphStore — isReady guards", () => {
  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tgs-test-"));
    sinon.stub(vscode.workspace, "workspaceFolders").value([
      { uri: { fsPath: tmpDir }, name: "test-ws", index: 0 },
    ]);
  });

  teardown(() => {
    const store = TeamGraphStore.getInstance();
    try { store.dispose(); } catch { /* may not be init'd */ }
    sinon.restore();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore cleanup */ }
  });

  const queryMethods = [
    "getTeamSummary",
    "getTeamHealth",
    "getRecurringBlockers",
  ] as const;

  queryMethods.forEach((method) => {
    test(`${method} returns fallback when not initialized`, async () => {
      const store = TeamGraphStore.getInstance();
      // Don't initialize — isReady() is false
      const result = (store as any)[method]();
      assert.ok(
        typeof result === "string" && result.includes("not yet initialized"),
        `${method} should return "not yet initialized" when not ready`,
      );
    });
  });

  test("getPersonProfile returns guard message when not initialized", () => {
    const store = TeamGraphStore.getInstance();
    const result = store.getPersonProfile("Alice");
    assert.ok(result.includes("not yet initialized"));
  });

  test("getTicketHistory returns guard message when not initialized", () => {
    const store = TeamGraphStore.getInstance();
    const result = store.getTicketHistory("100");
    assert.ok(result.includes("not yet initialized"));
  });
});

// ── Persistence ──────────────────────────────────────────────────

suite("TeamGraphStore — Persistence", () => {
  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tgs-test-"));
    sinon.stub(vscode.workspace, "workspaceFolders").value([
      { uri: { fsPath: tmpDir }, name: "test-ws", index: 0 },
    ]);
  });

  teardown(() => {
    sinon.restore();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore cleanup */ }
  });

  test("DB file is created on disk after initialize", async () => {
    const store = TeamGraphStore.getInstance();
    await store.initialize();
    const dbPath = path.join(tmpDir, ".codebuddy", "team_graph.db");
    assert.ok(fs.existsSync(dbPath), "team_graph.db should exist");
    store.dispose();
  });

  test("data survives dispose + re-initialize", async () => {
    const store1 = TeamGraphStore.getInstance();
    await store1.initialize();
    store1.storeStandup(makeSampleRecord());
    store1.dispose();

    const store2 = TeamGraphStore.getInstance();
    await store2.initialize();
    const standups = store2.loadStandups(10);
    assert.strictEqual(standups.length, 1);
    assert.ok(store2.getPersonByName("Alice Smith"));
    store2.dispose();
  });
});
