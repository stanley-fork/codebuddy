/**
 * CacheManager Tests
 *
 * Tests: hit/miss counting, getStats(), resetStats(),
 * clear() preserving stats, and cache invalidation.
 */

import * as assert from "assert";
import * as sinon from "sinon";
import { CacheManager } from "../../ast/cache/cache.manager";

// Minimal mocks for vscode OutputChannel and Parser.Tree
function createMockOutputChannel(): any {
  return {
    appendLine: sinon.stub(),
    append: sinon.stub(),
    show: sinon.stub(),
    hide: sinon.stub(),
    clear: sinon.stub(),
    dispose: sinon.stub(),
    replace: sinon.stub(),
    name: "test",
  };
}

function createMockTree(): any {
  return {
    delete: sinon.stub(),
    rootNode: {},
    copy: sinon.stub(),
  };
}

suite("CacheManager", () => {
  let manager: CacheManager;
  let outputChannel: any;

  setup(() => {
    outputChannel = createMockOutputChannel();
    // Reset the singleton before each test
    (CacheManager as any).instance = null;
    manager = CacheManager.getInstance(outputChannel, 10);
  });

  teardown(() => {
    manager.dispose();
    sinon.restore();
  });

  // ── getStats() ────────────────────────────────────────

  test("starts with zero hits and misses", () => {
    const stats = manager.getStats();
    assert.strictEqual(stats.hits, 0);
    assert.strictEqual(stats.misses, 0);
    assert.strictEqual(stats.hitRate, 0);
    assert.strictEqual(stats.size, 0);
  });

  test("increments misses on cache miss (no entry)", async () => {
    await manager.get("nonexistent.ts", "content");
    const stats = manager.getStats();
    assert.strictEqual(stats.misses, 1);
    assert.strictEqual(stats.hits, 0);
  });

  test("increments misses on stale content", async () => {
    const tree = createMockTree();
    manager.set("file.ts", {
      tree,
      language: "typescript",
      content: "old content",
      filePath: "file.ts",
    });

    await manager.get("file.ts", "new content");
    const stats = manager.getStats();
    assert.strictEqual(stats.misses, 1);
    assert.strictEqual(stats.hits, 0);
  });

  test("increments hits on cache hit", async () => {
    const tree = createMockTree();
    manager.set("file.ts", {
      tree,
      language: "typescript",
      content: "content",
      filePath: "file.ts",
    });

    await manager.get("file.ts", "content");
    const stats = manager.getStats();
    assert.strictEqual(stats.hits, 1);
    assert.strictEqual(stats.misses, 0);
  });

  test("hitRate is calculated correctly", async () => {
    const tree = createMockTree();
    manager.set("file.ts", {
      tree,
      language: "typescript",
      content: "content",
      filePath: "file.ts",
    });

    await manager.get("file.ts", "content"); // hit
    await manager.get("file.ts", "content"); // hit
    await manager.get("missing.ts", "x"); // miss

    const stats = manager.getStats();
    assert.strictEqual(stats.hits, 2);
    assert.strictEqual(stats.misses, 1);
    assert.ok(Math.abs(stats.hitRate - 2 / 3) < 0.001);
  });

  // ── resetStats() ──────────────────────────────────────

  test("resetStats() zeroes counters", async () => {
    const tree = createMockTree();
    manager.set("file.ts", {
      tree,
      language: "typescript",
      content: "content",
      filePath: "file.ts",
    });
    await manager.get("file.ts", "content"); // hit
    await manager.get("missing.ts", "x"); // miss

    manager.resetStats();
    const stats = manager.getStats();
    assert.strictEqual(stats.hits, 0);
    assert.strictEqual(stats.misses, 0);
    assert.strictEqual(stats.hitRate, 0);
  });

  // ── clear() does NOT reset stats ──────────────────────

  test("clear() does not reset hits/misses counters", async () => {
    const tree = createMockTree();
    manager.set("file.ts", {
      tree,
      language: "typescript",
      content: "content",
      filePath: "file.ts",
    });
    await manager.get("file.ts", "content"); // hit

    manager.clear();
    const stats = manager.getStats();
    assert.strictEqual(stats.hits, 1, "hits should survive clear()");
    assert.strictEqual(stats.size, 0, "cache should be empty after clear()");
  });

  // ── size tracking ─────────────────────────────────────

  test("reports correct size after set and invalidate", () => {
    const tree1 = createMockTree();
    const tree2 = createMockTree();
    manager.set("a.ts", {
      tree: tree1,
      language: "ts",
      content: "a",
      filePath: "a.ts",
    });
    manager.set("b.ts", {
      tree: tree2,
      language: "ts",
      content: "b",
      filePath: "b.ts",
    });
    assert.strictEqual(manager.getStats().size, 2);

    manager.invalidate("a.ts");
    assert.strictEqual(manager.getStats().size, 1);
  });
});
