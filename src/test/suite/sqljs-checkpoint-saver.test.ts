/**
 * SqlJsCheckpointSaver - METADATA_FILTER_SQL Tests
 *
 * Tests: the pre-built SQL fragments used for metadata filtering
 * reject unknown keys and only allow parameterized fragments.
 */

import * as assert from "assert";

suite("METADATA_FILTER_SQL", () => {
  // Mirror of the constant defined in sqljs-checkpoint-saver.ts
  const VALID_METADATA_KEYS = ["source", "step", "parents"] as const;
  const METADATA_FILTER_SQL: Record<(typeof VALID_METADATA_KEYS)[number], string> = {
    source: `json_extract(CAST(metadata AS TEXT), '$.source') = ?`,
    step: `json_extract(CAST(metadata AS TEXT), '$.step') = ?`,
    parents: `json_extract(CAST(metadata AS TEXT), '$.parents') = ?`,
  };

  test("all valid keys have parameterized SQL fragments", () => {
    for (const key of VALID_METADATA_KEYS) {
      const fragment = METADATA_FILTER_SQL[key];
      assert.ok(fragment, `fragment for ${key} should exist`);
      assert.ok(fragment.includes("= ?"), `fragment for ${key} should use parameterized placeholder`);
    }
  });

  test("fragments do not contain string interpolation", () => {
    for (const key of VALID_METADATA_KEYS) {
      const fragment = METADATA_FILTER_SQL[key];
      assert.ok(!fragment.includes("${"), `fragment for ${key} should not contain template literals`);
      assert.ok(!fragment.includes("' +"), `fragment for ${key} should not use string concatenation`);
    }
  });

  test("unknown key is not present in the map", () => {
    const unknownKey = "malicious_key'; DROP TABLE checkpoints;--";
    assert.strictEqual(
      (METADATA_FILTER_SQL as any)[unknownKey],
      undefined,
      "unknown/malicious keys should not appear in the map",
    );
  });

  test("filter loop handles unknown keys by skipping", () => {
    // Simulate the filter loop from list()
    const filter = { source: "input", unknownKey: "evil" };
    const whereClauses: string[] = [];
    const params: any[] = [];

    for (const [key, value] of Object.entries(filter)) {
      if (value === undefined) continue;
      const fragment = (METADATA_FILTER_SQL as any)[key];
      if (!fragment) continue; // unknown key — skip silently
      whereClauses.push(fragment);
      params.push(JSON.stringify(value));
    }

    assert.strictEqual(whereClauses.length, 1);
    assert.ok(whereClauses[0].includes("$.source"));
    assert.strictEqual(params[0], '"input"');
  });
});

suite("buildMigratedCheckpoint null filtering", () => {
  test("filters null entries from json_group_array result", () => {
    // json_group_array returns [null] when there are no matching rows
    const sends = [null, { type: "json", value: '{"data": 1}' }, null, { type: "json", value: '{"data": 2}' }];
    const validSends = sends.filter(
      (s) => s !== null && (s as any).type !== undefined && (s as any).value !== undefined,
    );
    assert.strictEqual(validSends.length, 2);
    assert.deepStrictEqual(validSends[0], { type: "json", value: '{"data": 1}' });
    assert.deepStrictEqual(validSends[1], { type: "json", value: '{"data": 2}' });
  });

  test("returns empty array when all entries are null", () => {
    const sends = [null, null];
    const validSends = sends.filter(
      (s) => s !== null && (s as any).type !== undefined && (s as any).value !== undefined,
    );
    assert.strictEqual(validSends.length, 0);
  });

  test("preserves all entries when none are null", () => {
    const sends = [
      { type: "json", value: '{"a":1}' },
      { type: "json", value: '{"b":2}' },
    ];
    const validSends = sends.filter(
      (s) => s !== null && (s as any).type !== undefined && (s as any).value !== undefined,
    );
    assert.strictEqual(validSends.length, 2);
  });
});

suite("ensureSetup initPromise retry", () => {
  test("nulls initPromise on setup failure so retry is possible", async () => {
    let initPromise: Promise<void> | null = null;
    let isSetup = false;
    let attemptCount = 0;

    async function doSetup(): Promise<void> {
      attemptCount++;
      if (attemptCount === 1) {
        throw new Error("transient WASM failure");
      }
      isSetup = true;
    }

    async function ensureSetup(): Promise<void> {
      if (isSetup) return;
      if (initPromise) return initPromise;

      initPromise = doSetup().catch((err) => {
        initPromise = null;
        throw err;
      });
      return initPromise;
    }

    // First call: should fail and clear the promise
    try {
      await ensureSetup();
      assert.fail("should have thrown");
    } catch (err: any) {
      assert.strictEqual(err.message, "transient WASM failure");
    }
    assert.strictEqual(initPromise, null, "promise should be cleared after failure");

    // Second call: should succeed
    await ensureSetup();
    assert.strictEqual(isSetup, true, "setup should succeed on retry");
    assert.strictEqual(attemptCount, 2, "should have made exactly 2 attempts");
  });
});
