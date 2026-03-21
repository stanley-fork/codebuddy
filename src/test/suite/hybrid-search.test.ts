/**
 * Tests for the hybrid memory search modules:
 * - temporal-decay.ts
 * - mmr.ts
 * - hybrid-search.service.ts (pure functions only — no sql.js dependency)
 */

import * as assert from "assert";
import {
  toDecayLambda,
  calculateTemporalDecayMultiplier,
  applyTemporalDecayToScore,
  ageInDaysFromTimestamp,
  applyTemporalDecay,
} from "../../memory/temporal-decay";
import {
  tokenize,
  jaccardSimilarity,
  applyMMR,
} from "../../memory/mmr";
import {
  buildFtsQuery,
  computeFts4Score,
  mergeHybridResults,
  type VectorHit,
  type KeywordHit,
} from "../../memory/hybrid-search.service";

// ─── Temporal Decay ──────────────────────────────────────────────────

suite("Temporal Decay", () => {
  test("toDecayLambda returns ln(2)/halfLifeDays", () => {
    const lambda = toDecayLambda(30);
    assert.ok(Math.abs(lambda - Math.LN2 / 30) < 1e-10);
  });

  test("toDecayLambda returns 0 for invalid input", () => {
    assert.strictEqual(toDecayLambda(0), 0);
    assert.strictEqual(toDecayLambda(-5), 0);
    assert.strictEqual(toDecayLambda(NaN), 0);
    assert.strictEqual(toDecayLambda(Infinity), 0);
  });

  test("decay multiplier is 0.5 exactly at half-life", () => {
    const m = calculateTemporalDecayMultiplier({
      ageInDays: 30,
      halfLifeDays: 30,
    });
    assert.ok(Math.abs(m - 0.5) < 1e-10);
  });

  test("decay multiplier is 1 for age 0", () => {
    const m = calculateTemporalDecayMultiplier({
      ageInDays: 0,
      halfLifeDays: 30,
    });
    assert.strictEqual(m, 1);
  });

  test("decay multiplier decreases with age", () => {
    const m10 = calculateTemporalDecayMultiplier({
      ageInDays: 10,
      halfLifeDays: 30,
    });
    const m60 = calculateTemporalDecayMultiplier({
      ageInDays: 60,
      halfLifeDays: 30,
    });
    assert.ok(m10 > m60);
    assert.ok(m10 > 0 && m10 < 1);
    assert.ok(m60 > 0 && m60 < 1);
  });

  test("applyTemporalDecayToScore multiplies correctly", () => {
    const decayed = applyTemporalDecayToScore({
      score: 0.8,
      ageInDays: 30,
      halfLifeDays: 30,
    });
    assert.ok(Math.abs(decayed - 0.4) < 1e-10);
  });

  test("ageInDaysFromTimestamp computes correct age", () => {
    const now = Date.UTC(2026, 2, 21); // March 21, 2026
    const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
    const age = ageInDaysFromTimestamp(tenDaysAgo, now);
    assert.ok(Math.abs(age - 10) < 0.01);
  });

  test("ageInDaysFromTimestamp returns 0 for invalid timestamp", () => {
    assert.strictEqual(ageInDaysFromTimestamp("invalid", Date.now()), 0);
  });

  test("applyTemporalDecay is no-op when disabled", () => {
    const results = [
      { score: 0.9, indexedAt: "2020-01-01T00:00:00Z" },
      { score: 0.5, indexedAt: "2020-01-01T00:00:00Z" },
    ];
    const out = applyTemporalDecay(results, { enabled: false });
    assert.strictEqual(out[0].score, 0.9);
    assert.strictEqual(out[1].score, 0.5);
  });

  test("applyTemporalDecay reduces old scores", () => {
    const now = Date.UTC(2026, 2, 21);
    const results = [
      { score: 1.0, indexedAt: new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString() },
      { score: 1.0, indexedAt: new Date(now).toISOString() },
    ];
    const out = applyTemporalDecay(
      results,
      { enabled: true, halfLifeDays: 30 },
      now,
    );
    // 60-day-old result should have score ≈ 0.25 (two half-lives)
    assert.ok(out[0].score < 0.3);
    // Brand-new result should be unchanged
    assert.ok(out[1].score > 0.99);
  });

  test("applyTemporalDecay skips results without indexedAt", () => {
    const results = [{ score: 0.8 }]; // no indexedAt
    const out = applyTemporalDecay(
      results,
      { enabled: true, halfLifeDays: 30 },
      Date.now(),
    );
    assert.strictEqual(out[0].score, 0.8);
  });
});

// ─── MMR (Jaccard + re-ranking) ──────────────────────────────────────

suite("MMR Re-ranking", () => {
  test("tokenize extracts lowercase alphanumeric tokens", () => {
    const tokens = tokenize("Hello world_42 FOO-bar");
    assert.ok(tokens.has("hello"));
    assert.ok(tokens.has("world_42"));
    assert.ok(tokens.has("foo"));
    assert.ok(tokens.has("bar"));
  });

  test("tokenize returns empty set for empty string", () => {
    assert.strictEqual(tokenize("").size, 0);
    assert.strictEqual(tokenize("   !@#$  ").size, 0);
  });

  test("jaccardSimilarity returns 1 for identical sets", () => {
    const s = new Set(["a", "b", "c"]);
    assert.strictEqual(jaccardSimilarity(s, s), 1);
  });

  test("jaccardSimilarity returns 0 for disjoint sets", () => {
    const a = new Set(["a", "b"]);
    const b = new Set(["c", "d"]);
    assert.strictEqual(jaccardSimilarity(a, b), 0);
  });

  test("jaccardSimilarity returns 1/3 for one-of-three shared tokens", () => {
    const a = new Set(["a", "b"]);
    const b = new Set(["b", "c"]);
    // intersection=1, union=3 → 1/3
    assert.ok(Math.abs(jaccardSimilarity(a, b) - 1 / 3) < 1e-10);
  });

  test("jaccardSimilarity handles empty sets", () => {
    const empty = new Set<string>();
    const nonEmpty = new Set(["a"]);
    assert.strictEqual(jaccardSimilarity(empty, empty), 1);
    assert.strictEqual(jaccardSimilarity(empty, nonEmpty), 0);
  });

  test("applyMMR returns empty array for empty input", () => {
    assert.deepStrictEqual(applyMMR([], { enabled: true }), []);
  });

  test("applyMMR returns same order when disabled", () => {
    const items = [
      { score: 0.5, snippet: "a", filePath: "a.ts", startLine: 1 },
      { score: 0.9, snippet: "b", filePath: "b.ts", startLine: 1 },
    ];
    const out = applyMMR(items, { enabled: false });
    // Should be a copy, not re-ranked
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].snippet, "a");
  });

  test("applyMMR promotes diverse results", () => {
    // Two very similar snippets + one unique
    const items = [
      { score: 0.9, snippet: "function handleRequest handler", filePath: "a.ts", startLine: 1 },
      { score: 0.85, snippet: "function handleRequest processor", filePath: "b.ts", startLine: 1 },
      { score: 0.8, snippet: "database connection pool setup", filePath: "c.ts", startLine: 1 },
    ];
    const out = applyMMR(items, { enabled: true, lambda: 0.5 });
    // With λ=0.5 (high diversity), the unique "database" snippet should be promoted
    assert.strictEqual(out.length, 3);
    // First pick is still highest scorer
    assert.strictEqual(out[0].filePath, "a.ts");
    // Second pick should be the diverse one, not the near-duplicate
    assert.strictEqual(out[1].filePath, "c.ts");
  });
});

// ─── FTS Helpers ──────────────────────────────────────────────────────

suite("FTS Helpers", () => {
  test("buildFtsQuery tokenizes and AND-joins", () => {
    assert.strictEqual(
      buildFtsQuery("hello world"),
      '"hello" AND "world"',
    );
  });

  test("buildFtsQuery handles underscored identifiers", () => {
    assert.strictEqual(
      buildFtsQuery("FOO_bar baz"),
      '"FOO_bar" AND "baz"',
    );
  });

  test("buildFtsQuery returns null for blank input", () => {
    assert.strictEqual(buildFtsQuery("   "), null);
    assert.strictEqual(buildFtsQuery(""), null);
  });

  test("buildFtsQuery strips quotes", () => {
    assert.strictEqual(
      buildFtsQuery('"hello" "world"'),
      '"hello" AND "world"',
    );
  });

  test("buildFtsQuery handles Unicode", () => {
    assert.strictEqual(buildFtsQuery("金银价格"), '"金银价格"');
  });

  test("buildFtsQuery caps at 32 tokens", () => {
    const manyWords = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
    const query = buildFtsQuery(manyWords);
    assert.ok(query !== null);
    const tokenCount = (query!.match(/ AND /g) ?? []).length + 1;
    assert.strictEqual(tokenCount, 32);
  });

  test("buildFtsQuery handles null-ish input gracefully", () => {
    // @ts-expect-error — testing runtime guard
    assert.strictEqual(buildFtsQuery(null), null);
    // @ts-expect-error — testing runtime guard
    assert.strictEqual(buildFtsQuery(undefined), null);
  });

  test("computeFts4Score returns positive score for matching row", () => {
    // Simulate matchinfo('pcx') for 1 phrase, 1 column:
    // p=1, c=1, hits_this_row=2, hits_all_rows=5, docs_with_hit=3
    const ints = new Int32Array([1, 1, 2, 5, 3]);
    const blob = new Uint8Array(ints.buffer);
    const score = computeFts4Score(blob);
    // tf * (1/df) = 2 * (1/3) = 0.667; normalized: 0.667/(1+0.667) ≈ 0.4
    assert.ok(score > 0.3 && score < 0.5);
  });

  test("computeFts4Score returns higher score for more hits", () => {
    // 3 hits in this row
    const moreHits = new Int32Array([1, 1, 3, 5, 3]);
    // 1 hit in this row
    const fewerHits = new Int32Array([1, 1, 1, 5, 3]);
    const scoreMore = computeFts4Score(new Uint8Array(moreHits.buffer));
    const scoreFewer = computeFts4Score(new Uint8Array(fewerHits.buffer));
    assert.ok(scoreMore > scoreFewer);
  });

  test("computeFts4Score returns higher score for rarer terms", () => {
    // Rare term: only 1 doc has it
    const rare = new Int32Array([1, 1, 1, 1, 1]);
    // Common term: 100 docs have it
    const common = new Int32Array([1, 1, 1, 100, 100]);
    const scoreRare = computeFts4Score(new Uint8Array(rare.buffer));
    const scoreCommon = computeFts4Score(new Uint8Array(common.buffer));
    assert.ok(scoreRare > scoreCommon);
  });

  test("computeFts4Score handles empty matchinfo gracefully", () => {
    const empty = new Uint8Array(0);
    const score = computeFts4Score(empty);
    assert.ok(score > 0 && score < 1);
  });
});

// ─── Hybrid Merge ────────────────────────────────────────────────────

suite("Hybrid Merge", () => {
  const makeVector = (
    id: string,
    score: number,
    filePath = "test.ts",
  ): VectorHit => ({
    id,
    filePath,
    startLine: 1,
    endLine: 10,
    snippet: `vector content for ${id}`,
    vectorScore: score,
    chunkType: "function",
    language: "typescript",
    indexedAt: new Date().toISOString(),
  });

  const makeKeyword = (
    id: string,
    score: number,
    filePath = "test.ts",
  ): KeywordHit => ({
    id,
    filePath,
    startLine: 1,
    endLine: 10,
    snippet: `keyword content for ${id}`,
    textScore: score,
    chunkType: "function",
    language: "typescript",
    indexedAt: new Date().toISOString(),
  });

  test("mergeHybridResults unions by ID and combines weighted scores", () => {
    const merged = mergeHybridResults({
      vector: [makeVector("a", 0.9, "a.ts")],
      keyword: [makeKeyword("b", 1.0, "b.ts")],
      config: { vectorWeight: 0.7, textWeight: 0.3 },
    });

    assert.strictEqual(merged.length, 2);
    const a = merged.find((r) => r.filePath === "a.ts");
    const b = merged.find((r) => r.filePath === "b.ts");
    assert.ok(a);
    assert.ok(b);
    assert.ok(Math.abs(a!.score - 0.7 * 0.9) < 0.01);
    assert.ok(Math.abs(b!.score - 0.3 * 1.0) < 0.01);
  });

  test("mergeHybridResults combines overlapping IDs", () => {
    const merged = mergeHybridResults({
      vector: [makeVector("a", 0.8)],
      keyword: [makeKeyword("a", 0.6)],
      config: { vectorWeight: 0.5, textWeight: 0.5 },
    });

    assert.strictEqual(merged.length, 1);
    assert.ok(Math.abs(merged[0].score - (0.5 * 0.8 + 0.5 * 0.6)) < 0.01);
  });

  test("mergeHybridResults prefers keyword snippet on overlap", () => {
    const merged = mergeHybridResults({
      vector: [makeVector("a", 0.8)],
      keyword: [makeKeyword("a", 0.6)],
    });

    assert.ok(merged[0].snippet.includes("keyword"));
  });

  test("mergeHybridResults respects topK", () => {
    const vectors = Array.from({ length: 20 }, (_, i) =>
      makeVector(`v${i}`, 0.5 + i * 0.01, `v${i}.ts`),
    );
    const merged = mergeHybridResults({
      vector: vectors,
      keyword: [],
      config: { topK: 5 },
    });
    assert.strictEqual(merged.length, 5);
  });

  test("mergeHybridResults sorts by score descending", () => {
    const merged = mergeHybridResults({
      vector: [
        makeVector("low", 0.3, "low.ts"),
        makeVector("high", 0.9, "high.ts"),
        makeVector("mid", 0.6, "mid.ts"),
      ],
      keyword: [],
    });

    for (let i = 1; i < merged.length; i++) {
      assert.ok(merged[i - 1].score >= merged[i].score);
    }
  });

  test("mergeHybridResults with temporal decay penalizes old results", () => {
    const now = Date.UTC(2026, 2, 21);
    const oldTs = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days ago
    const newTs = new Date(now).toISOString();

    const oldHit: VectorHit = {
      ...makeVector("old", 0.95, "old.ts"),
      indexedAt: oldTs,
    };
    const newHit: VectorHit = {
      ...makeVector("new", 0.7, "new.ts"),
      indexedAt: newTs,
    };

    const merged = mergeHybridResults({
      vector: [oldHit, newHit],
      keyword: [],
      config: {
        temporalDecay: { enabled: true, halfLifeDays: 30 },
        nowMs: now,
      },
    });

    // New result should rank higher despite lower raw score
    assert.strictEqual(merged[0].filePath, "new.ts");
  });

  test("mergeHybridResults returns empty for empty inputs", () => {
    const merged = mergeHybridResults({
      vector: [],
      keyword: [],
    });
    assert.strictEqual(merged.length, 0);
  });

  test("mergeHybridResults normalizes weights that sum > 1", () => {
    const merged = mergeHybridResults({
      vector: [makeVector("a", 1.0, "a.ts")],
      keyword: [],
      config: { vectorWeight: 2.0, textWeight: 1.0 },
    });
    // After normalization: vectorWeight = 2/3 ≈ 0.667
    assert.ok(merged[0].score < 1.0);
    assert.ok(Math.abs(merged[0].score - 2 / 3) < 0.01);
  });

  test("mergeHybridResults deep-merges nested mmr config", () => {
    // Passing only mmr.enabled should preserve default lambda
    const merged = mergeHybridResults({
      vector: [
        makeVector("a", 0.9, "a.ts"),
        makeVector("b", 0.85, "b.ts"),
      ],
      keyword: [],
      config: { mmr: { enabled: true } },
    });
    // Should not throw — lambda should be 0.7 from defaults
    assert.strictEqual(merged.length, 2);
  });
});
