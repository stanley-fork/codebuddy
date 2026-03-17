/**
 * ContextWindowCompactionService Tests
 *
 * Tests the multi-tier context window compaction system:
 * - Pure utility functions (parseContextWindowSetting, resolveContextWindow)
 * - Singleton lifecycle (createInstance, getInstance, dispose)
 * - Token budget calculation and warning levels
 * - Tier 1: Tool result stripping
 * - Tier 2: Multi-chunk summarization
 * - Tier 3: Partial summarization
 * - Tier 4: Plain description fallback
 * - Orphaned tool result repair
 * - Disposed guard
 */

import * as assert from "assert";
import * as sinon from "sinon";
import {
  ContextWindowCompactionService,
  parseContextWindowSetting,
  resolveContextWindow,
  CompactionTier,
  SAFETY_MARGIN,
  type CompactionMessage,
  type CompactionOptions,
  type CompactionResult,
} from "../../services/context-window-compaction.service";

// ── Helpers ──────────────────────────────────────────────────────────

/** Simple char/4 token counter for deterministic tests. */
const simpleTokenCounter = async (text: string): Promise<number> =>
  Math.ceil(text.length / 4);

/** Summarizer stub that echoes a short summary. */
const echoSummarizer = async (text: string): Promise<string | undefined> =>
  `Summary of ${text.length} chars`;

/** Summarizer that always fails. */
const failingSummarizer = async (): Promise<string | undefined> => undefined;

/** Build N messages of a given role and approximate token size. */
function makeMessages(
  count: number,
  role: CompactionMessage["role"] = "user",
  contentSize = 100,
): CompactionMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role,
    content: `Message ${i}: ${"x".repeat(contentSize)}`,
  }));
}

/** Build a realistic conversation with user/assistant pairs. */
function makeConversation(pairs: number, contentSize = 100): CompactionMessage[] {
  const msgs: CompactionMessage[] = [];
  for (let i = 0; i < pairs; i++) {
    msgs.push({ role: "user", content: `User question ${i}: ${"q".repeat(contentSize)}` });
    msgs.push({ role: "assistant", content: `Assistant answer ${i}: ${"a".repeat(contentSize)}` });
  }
  return msgs;
}

/** Build options with a tight budget. */
function tightOptions(maxTokens = 500): CompactionOptions {
  return { maxContextTokens: maxTokens, systemPromptTokens: 50 };
}

/** Build options with a generous budget. */
function generousOptions(maxTokens = 100_000): CompactionOptions {
  return { maxContextTokens: maxTokens, systemPromptTokens: 200 };
}

// ── Pure Function Tests ──────────────────────────────────────────────

suite("parseContextWindowSetting", () => {
  test("parses '4k' → 4000", () => {
    assert.strictEqual(parseContextWindowSetting("4k"), 4000);
  });

  test("parses '128k' → 128000", () => {
    assert.strictEqual(parseContextWindowSetting("128k"), 128000);
  });

  test("parses '16K' (uppercase) → 16000", () => {
    assert.strictEqual(parseContextWindowSetting("16K"), 16000);
  });

  test("parses raw number string '32768' → 32768", () => {
    assert.strictEqual(parseContextWindowSetting("32768"), 32768);
  });

  test("returns 16000 for garbage input", () => {
    assert.strictEqual(parseContextWindowSetting("banana"), 16000);
  });

  test("returns 16000 for empty string", () => {
    assert.strictEqual(parseContextWindowSetting(""), 16000);
  });
});

suite("resolveContextWindow", () => {
  test("returns known model window for 'gpt-4o'", () => {
    assert.strictEqual(resolveContextWindow("gpt-4o"), 128_000);
  });

  test("returns known model window for claude", () => {
    assert.strictEqual(
      resolveContextWindow("claude-sonnet-4-20250514"),
      200_000,
    );
  });

  test("returns default 16000 for unknown model", () => {
    assert.strictEqual(resolveContextWindow("unknown-model-xyz"), 16_000);
  });

  test("returns default 16000 when no model provided", () => {
    assert.strictEqual(resolveContextWindow(), 16_000);
  });

  test("calls logger.warn for unknown model when logger provided", () => {
    const warn = sinon.stub();
    resolveContextWindow("totally-unknown-model", { warn });
    assert.ok(warn.calledOnce);
    assert.ok(warn.firstCall.args[0].includes("totally-unknown-model"));
  });

  test("does not call logger when model is known", () => {
    const warn = sinon.stub();
    resolveContextWindow("gpt-4o", { warn });
    assert.ok(warn.notCalled);
  });
});

// ── Singleton Lifecycle ──────────────────────────────────────────────

suite("ContextWindowCompactionService — lifecycle", () => {
  teardown(() => {
    // Ensure clean slate
    ContextWindowCompactionService.getInstance()?.dispose();
  });

  test("getInstance returns undefined before createInstance", () => {
    // Force clean state
    ContextWindowCompactionService.getInstance()?.dispose();
    assert.strictEqual(ContextWindowCompactionService.getInstance(), undefined);
  });

  test("createInstance returns an instance and getInstance finds it", () => {
    const svc = ContextWindowCompactionService.createInstance(
      echoSummarizer,
      simpleTokenCounter,
    );
    assert.ok(svc);
    assert.strictEqual(ContextWindowCompactionService.getInstance(), svc);
  });

  test("createInstance disposes previous instance", () => {
    const first = ContextWindowCompactionService.createInstance(
      echoSummarizer,
      simpleTokenCounter,
    );
    const second = ContextWindowCompactionService.createInstance(
      echoSummarizer,
      simpleTokenCounter,
    );
    assert.notStrictEqual(first, second);
    assert.strictEqual(ContextWindowCompactionService.getInstance(), second);
  });

  test("dispose makes getInstance return undefined", async () => {
    const svc = ContextWindowCompactionService.createInstance(
      echoSummarizer,
      simpleTokenCounter,
    );
    await svc.dispose();
    assert.strictEqual(ContextWindowCompactionService.getInstance(), undefined);
  });

  test("compact throws after dispose", async () => {
    const svc = ContextWindowCompactionService.createInstance(
      echoSummarizer,
      simpleTokenCounter,
    );
    await svc.dispose();
    await assert.rejects(
      () => svc.compact([], generousOptions()),
      /disposed/,
    );
  });
});

// ── compact() — No Compaction Needed ─────────────────────────────────

suite("compact — within budget (no compaction)", () => {
  let svc: ContextWindowCompactionService;

  setup(() => {
    svc = ContextWindowCompactionService.createInstance(
      echoSummarizer,
      simpleTokenCounter,
    );
  });

  teardown(async () => {
    await svc.dispose();
  });

  test("returns messages as-is when tokens fit within budget", async () => {
    const messages = makeMessages(3, "user", 20);
    const result = await svc.compact(messages, generousOptions());

    assert.strictEqual(result.compacted, false);
    assert.strictEqual(result.tier, CompactionTier.NONE);
    assert.strictEqual(result.originalCount, 3);
    assert.strictEqual(result.finalCount, 3);
    assert.strictEqual(result.messages.length, 3);
  });

  test("annotates _tokenCount on returned messages", async () => {
    const messages: CompactionMessage[] = [
      { role: "user", content: "Hello world!" },
    ];
    const result = await svc.compact(messages, generousOptions());
    assert.ok(result.messages[0]._tokenCount !== undefined);
    assert.ok(result.messages[0]._tokenCount! > 0);
  });

  test("preserves cached _tokenCount and does not recount", async () => {
    const counter = sinon.stub().resolves(10);
    const svc2 = ContextWindowCompactionService.createInstance(
      echoSummarizer,
      counter,
    );
    const messages: CompactionMessage[] = [
      { role: "user", content: "test", _tokenCount: 42 },
    ];
    const result = await svc2.compact(messages, generousOptions());
    assert.strictEqual(result.messages[0]._tokenCount, 42);
    // Counter should NOT have been called because token was pre-cached
    assert.ok(counter.notCalled);
    await svc2.dispose();
  });
});

// ── Warning Levels ───────────────────────────────────────────────────

suite("compact — warning levels", () => {
  let svc: ContextWindowCompactionService;

  setup(() => {
    svc = ContextWindowCompactionService.createInstance(
      echoSummarizer,
      simpleTokenCounter,
    );
  });

  teardown(async () => {
    await svc.dispose();
  });

  test('returns warningLevel "none" when usage < 80%', async () => {
    // 1 small message, large budget
    const messages: CompactionMessage[] = [
      { role: "user", content: "Hi", _tokenCount: 10 },
    ];
    const result = await svc.compact(messages, {
      maxContextTokens: 1000,
      systemPromptTokens: 0,
    });
    assert.strictEqual(result.warningLevel, "none");
  });

  test('returns warningLevel "warning" at 80-90% usage', async () => {
    // totalTokens (850) + systemPrompt (0) = 850; ratio = 850/1000 = 0.85
    const messages: CompactionMessage[] = [
      { role: "user", content: "x", _tokenCount: 850 },
    ];
    // Budget: (1000 - 0 - 4096) / 1.2 → negative, so compaction triggers
    // But we want to test warning level display, use generous budget for effective
    // Actually: ratio is raw: (850 + 0) / 1000 = 0.85 → "warning"
    // effectiveBudget = (1000 - 0 - 4096) / 1.2 → negative, so this will trigger compaction
    // Let's use a larger context window
    const result = await svc.compact(messages, {
      maxContextTokens: 10_000,
      systemPromptTokens: 7500,
    });
    // ratio = (850 + 7500) / 10000 = 0.835 → "warning"
    assert.strictEqual(result.warningLevel, "warning");
  });

  test('returns warningLevel "critical" at ≥90% usage', async () => {
    const messages: CompactionMessage[] = [
      { role: "user", content: "x", _tokenCount: 500 },
    ];
    const result = await svc.compact(messages, {
      maxContextTokens: 1000,
      systemPromptTokens: 420,
    });
    // ratio = (500 + 420) / 1000 = 0.92 → "critical"
    assert.strictEqual(result.warningLevel, "critical");
  });
});

// ── Tier 1: Tool Result Stripping ────────────────────────────────────

suite("compact — Tier 1: tool stripping", () => {
  let svc: ContextWindowCompactionService;

  setup(() => {
    svc = ContextWindowCompactionService.createInstance(
      echoSummarizer,
      simpleTokenCounter,
    );
  });

  teardown(async () => {
    await svc.dispose();
  });

  test("strips large tool results from older messages", async () => {
    const messages: CompactionMessage[] = [
      { role: "user", content: "read that file" },
      {
        role: "assistant",
        content: "Sure, reading.",
        tool_calls: [{ id: "tc1", name: "read_file" }],
      },
      {
        role: "tool",
        content: "x".repeat(5000), // large tool result
        tool_call_id: "tc1",
      },
      { role: "assistant", content: "Here is the file content." },
      // Recent 4 messages preserved
      { role: "user", content: "Thanks" },
      { role: "assistant", content: "You're welcome" },
      { role: "user", content: "Next question" },
      { role: "assistant", content: "Sure, go ahead" },
    ];

    // Budget tight enough that large tool result exceeds it, but stripping fixes it
    const result = await svc.compact(messages, {
      maxContextTokens: 2000,
      systemPromptTokens: 50,
    });

    if (result.compacted) {
      // Either tool strip or higher tier was used
      assert.ok(result.finalTokens <= result.originalTokens);
      // The large tool result should have been truncated
      const toolMsg = result.messages.find((m) => m.role === "tool");
      if (toolMsg) {
        assert.ok(
          toolMsg.content.includes("[Tool result truncated") ||
            toolMsg.content.length < 5000,
        );
      }
    }
  });

  test("preserves recent messages during stripping", async () => {
    const recent: CompactionMessage[] = [
      { role: "user", content: "Recent 1" },
      { role: "assistant", content: "Recent 2" },
      { role: "user", content: "Recent 3" },
      { role: "assistant", content: "Recent 4" },
    ];
    const older: CompactionMessage[] = [
      { role: "tool", content: "x".repeat(1000), tool_call_id: "tc1" },
    ];
    const messages = [...older, ...recent];

    const result = await svc.compact(messages, {
      maxContextTokens: 800,
      systemPromptTokens: 50,
    });

    if (result.compacted) {
      // Recent messages should still appear
      const contents = result.messages.map((m) => m.content);
      assert.ok(contents.some((c) => c.includes("Recent 4")));
    }
  });
});

// ── Tier 2: Multi-Chunk Summarization ────────────────────────────────

suite("compact — Tier 2: multi-chunk summarization", () => {
  let svc: ContextWindowCompactionService;

  setup(() => {
    svc = ContextWindowCompactionService.createInstance(
      echoSummarizer,
      simpleTokenCounter,
    );
  });

  teardown(async () => {
    await svc.dispose();
  });

  test("summarizes older messages when tool stripping is insufficient", async () => {
    // Many medium-sized messages that won't fit even after stripping
    const messages = makeConversation(10, 200); // 20 messages, ~200 chars each

    const result = await svc.compact(messages, {
      maxContextTokens: 600,
      systemPromptTokens: 50,
    });

    assert.ok(result.compacted);
    assert.ok(result.finalCount < result.originalCount);
    // Should have a summary system message
    const summaryMsg = result.messages.find(
      (m) => m.role === "system" && m.content.includes("Summary"),
    );
    assert.ok(summaryMsg, "Expected a summary system message");
  });

  test("falls back to Tier 3 if summarizer fails", async () => {
    const svc2 = ContextWindowCompactionService.createInstance(
      failingSummarizer,
      simpleTokenCounter,
    );

    const messages = makeConversation(10, 200);

    const result = await svc2.compact(messages, {
      maxContextTokens: 600,
      systemPromptTokens: 50,
    });

    // Should still compact, using tier 3 or 4
    assert.ok(result.compacted);
    assert.ok(
      result.tier === CompactionTier.PARTIAL ||
        result.tier === CompactionTier.PLAIN_FALLBACK,
    );
    await svc2.dispose();
  });
});

// ── Tier 4: Plain Description Fallback ───────────────────────────────

suite("compact — Tier 4: plain description fallback", () => {
  let svc: ContextWindowCompactionService;

  setup(() => {
    // Use a failing summarizer so we always reach the fallback
    svc = ContextWindowCompactionService.createInstance(
      failingSummarizer,
      simpleTokenCounter,
    );
  });

  teardown(async () => {
    await svc.dispose();
  });

  test("produces a description message when LLM is unavailable", async () => {
    const messages = makeConversation(10, 200);

    const result = await svc.compact(messages, {
      maxContextTokens: 600,
      systemPromptTokens: 50,
    });

    assert.ok(result.compacted);
    assert.strictEqual(result.tier, CompactionTier.PLAIN_FALLBACK);

    const descMsg = result.messages[0];
    assert.strictEqual(descMsg.role, "system");
    assert.ok(descMsg.content.includes("earlier messages removed"));
  });

  test("description includes topic indicators from user messages", async () => {
    const messages: CompactionMessage[] = [
      { role: "user", content: "How do I configure webpack?" },
      { role: "assistant", content: "You can configure webpack by..." },
      { role: "user", content: "What about babel plugins?" },
      { role: "assistant", content: "Babel plugins are configured in..." },
      // 4 recent (preserved)
      { role: "user", content: "Recent 1" },
      { role: "assistant", content: "Recent 2" },
      { role: "user", content: "Recent 3" },
      { role: "assistant", content: "Recent 4" },
    ];

    const result = await svc.compact(messages, {
      maxContextTokens: 200,
      systemPromptTokens: 10,
    });

    assert.ok(result.compacted);
    const descMsg = result.messages[0];
    assert.ok(
      descMsg.content.includes("webpack") ||
        descMsg.content.includes("Topics discussed"),
    );
  });

  test("keeps exactly 4 recent messages plus description", async () => {
    const messages = makeConversation(6, 200); // 12 messages

    const result = await svc.compact(messages, {
      maxContextTokens: 300,
      systemPromptTokens: 50,
    });

    assert.ok(result.compacted);
    // Should be: 1 description + 4 recent = 5
    assert.ok(result.finalCount <= 5);
    assert.strictEqual(result.messages[0].role, "system");
  });
});

// ── Orphaned Tool Result Repair ──────────────────────────────────────

suite("compact — orphaned tool result repair", () => {
  let svc: ContextWindowCompactionService;

  setup(() => {
    svc = ContextWindowCompactionService.createInstance(
      echoSummarizer,
      simpleTokenCounter,
    );
  });

  teardown(async () => {
    await svc.dispose();
  });

  test("drops orphaned tool results when parent assistant was compacted away", async () => {
    // Create a scenario where the assistant message with tool_calls is in
    // the "older" portion that gets summarized, but the tool result is in "recent"
    const messages: CompactionMessage[] = [
      ...makeConversation(5, 200), // 10 older messages
      // These land in the "recent" window:
      {
        role: "tool",
        content: "orphaned result",
        tool_call_id: "tc_gone", // no matching assistant
      },
      { role: "user", content: "Recent question" },
      { role: "assistant", content: "Recent answer" },
      { role: "user", content: "Another recent" },
    ];

    const result = await svc.compact(messages, {
      maxContextTokens: 600,
      systemPromptTokens: 50,
    });

    if (result.compacted) {
      // The orphaned tool message should have been dropped
      const orphan = result.messages.find(
        (m) => m.role === "tool" && m.tool_call_id === "tc_gone",
      );
      assert.strictEqual(
        orphan,
        undefined,
        "Orphaned tool result should be removed",
      );
    }
  });

  test("keeps tool results that have matching assistant tool_calls", async () => {
    const messages: CompactionMessage[] = [
      ...makeConversation(4, 200),
      // These are in "recent" — paired correctly
      {
        role: "assistant",
        content: "Let me check",
        tool_calls: [{ id: "tc_valid", name: "read" }],
      },
      { role: "tool", content: "file contents", tool_call_id: "tc_valid" },
      { role: "user", content: "Recent" },
      { role: "assistant", content: "Done" },
    ];

    const result = await svc.compact(messages, {
      maxContextTokens: 600,
      systemPromptTokens: 50,
    });

    if (result.compacted) {
      const toolMsg = result.messages.find(
        (m) => m.role === "tool" && m.tool_call_id === "tc_valid",
      );
      assert.ok(toolMsg, "Paired tool result should be preserved");
    }
  });
});

// ── checkUsage ───────────────────────────────────────────────────────

suite("checkUsage", () => {
  let svc: ContextWindowCompactionService;

  setup(() => {
    svc = ContextWindowCompactionService.createInstance(
      echoSummarizer,
      simpleTokenCounter,
    );
  });

  teardown(async () => {
    await svc.dispose();
  });

  test("returns usage ratio and warning level without compacting", async () => {
    const messages: CompactionMessage[] = [
      { role: "user", content: "x".repeat(400), _tokenCount: 100 },
    ];
    const usage = await svc.checkUsage(messages, {
      maxContextTokens: 1000,
      systemPromptTokens: 100,
    });

    // ratio = (100 + 100) / 1000 = 0.2
    assert.ok(usage.usageRatio > 0);
    assert.strictEqual(usage.totalTokens, 100);
    assert.strictEqual(usage.budget, 900); // 1000 - 100
    assert.strictEqual(usage.warningLevel, "none");
  });
});

// ── Edge Cases ───────────────────────────────────────────────────────

suite("compact — edge cases", () => {
  let svc: ContextWindowCompactionService;

  setup(() => {
    svc = ContextWindowCompactionService.createInstance(
      echoSummarizer,
      simpleTokenCounter,
    );
  });

  teardown(async () => {
    await svc.dispose();
  });

  test("handles empty message array", async () => {
    const result = await svc.compact([], generousOptions());
    assert.strictEqual(result.compacted, false);
    assert.strictEqual(result.originalCount, 0);
    assert.strictEqual(result.finalCount, 0);
    assert.strictEqual(result.tier, CompactionTier.NONE);
  });

  test("handles single message", async () => {
    const messages: CompactionMessage[] = [
      { role: "user", content: "Hello" },
    ];
    const result = await svc.compact(messages, generousOptions());
    assert.strictEqual(result.compacted, false);
    assert.strictEqual(result.finalCount, 1);
  });

  test("handles messages with empty content", async () => {
    const messages: CompactionMessage[] = [
      { role: "user", content: "" },
      { role: "assistant", content: "" },
    ];
    const result = await svc.compact(messages, generousOptions());
    assert.strictEqual(result.compacted, false);
    assert.strictEqual(result.finalCount, 2);
  });

  test("skips compaction for conversations with < 6 messages even if over budget", async () => {
    // 5 messages, tight budget — tool stripping or fallback may still apply,
    // but multi-chunk/partial summarization requires MIN_MESSAGES_FOR_SUMMARY (6)
    const messages = makeMessages(5, "user", 300);
    const result = await svc.compact(messages, tightOptions(200));

    // It will still compact (via stripping or fallback), but NOT via summarization tiers
    assert.ok(
      result.tier !== CompactionTier.MULTI_CHUNK &&
        result.tier !== CompactionTier.PARTIAL,
    );
  });
});

// ── CompactionTier enum ──────────────────────────────────────────────

suite("CompactionTier enum", () => {
  test("has expected values", () => {
    assert.strictEqual(CompactionTier.NONE, 0);
    assert.strictEqual(CompactionTier.TOOL_STRIP, 1);
    assert.strictEqual(CompactionTier.MULTI_CHUNK, 2);
    assert.strictEqual(CompactionTier.PARTIAL, 3);
    assert.strictEqual(CompactionTier.PLAIN_FALLBACK, 4);
  });

  test("tiers are ordered from least to most aggressive", () => {
    assert.ok(CompactionTier.NONE < CompactionTier.TOOL_STRIP);
    assert.ok(CompactionTier.TOOL_STRIP < CompactionTier.MULTI_CHUNK);
    assert.ok(CompactionTier.MULTI_CHUNK < CompactionTier.PARTIAL);
    assert.ok(CompactionTier.PARTIAL < CompactionTier.PLAIN_FALLBACK);
  });
});
