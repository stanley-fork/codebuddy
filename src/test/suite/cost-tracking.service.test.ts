import * as assert from "assert";
import { CostTrackingService } from "../../services/cost-tracking.service";

suite("CostTrackingService", () => {
  let service: CostTrackingService;

  setup(() => {
    // Reset singleton state between tests
    service = CostTrackingService.getInstance();
    service.resetAll();
  });

  teardown(() => {
    service.resetAll();
  });

  // ── recordUsage ─────────────────────────────────────────────────

  test("recordUsage tracks a single turn", () => {
    const result = service.recordUsage("t1", "anthropic", "claude-sonnet-4-6", 1000, 500);

    assert.strictEqual(result.inputTokens, 1000);
    assert.strictEqual(result.outputTokens, 500);
    assert.strictEqual(result.totalTokens, 1500);
    assert.strictEqual(result.requestCount, 1);
    assert.strictEqual(result.provider, "anthropic");
    assert.strictEqual(result.model, "claude-sonnet-4-6");
    assert.ok(result.estimatedCostUSD > 0);
  });

  test("recordUsage accumulates across multiple turns", () => {
    service.recordUsage("t1", "anthropic", "claude-sonnet-4-6", 1000, 500);
    const result = service.recordUsage("t1", "anthropic", "claude-sonnet-4-6", 2000, 1000);

    assert.strictEqual(result.inputTokens, 3000);
    assert.strictEqual(result.outputTokens, 1500);
    assert.strictEqual(result.totalTokens, 4500);
    assert.strictEqual(result.requestCount, 2);
  });

  test("recordUsage tracks separate conversations independently", () => {
    service.recordUsage("t1", "anthropic", "claude-sonnet-4-6", 1000, 500);
    service.recordUsage("t2", "openai", "gpt-4o", 2000, 1000);

    const c1 = service.getConversationCost("t1");
    const c2 = service.getConversationCost("t2");

    assert.strictEqual(c1!.inputTokens, 1000);
    assert.strictEqual(c2!.inputTokens, 2000);
    assert.strictEqual(c1!.provider, "anthropic");
    assert.strictEqual(c2!.provider, "openai");
  });

  test("recordUsage uses default pricing for unknown models", () => {
    const result = service.recordUsage("t1", "custom", "some-unknown-model", 1000000, 0);
    // Default pricing: 3/M input → $3.00 for 1M tokens
    assert.strictEqual(result.estimatedCostUSD, 3);
  });

  // ── getConversationCost ─────────────────────────────────────────

  test("getConversationCost returns null for untracked thread", () => {
    assert.strictEqual(service.getConversationCost("nonexistent"), null);
  });

  test("getConversationCost returns data for tracked thread", () => {
    service.recordUsage("t1", "anthropic", "claude-sonnet-4-6", 100, 50);
    const cost = service.getConversationCost("t1");

    assert.ok(cost !== null);
    assert.strictEqual(cost!.inputTokens, 100);
    assert.strictEqual(cost!.outputTokens, 50);
  });

  // ── resetConversation ───────────────────────────────────────────

  test("resetConversation clears a single conversation", () => {
    service.recordUsage("t1", "anthropic", "claude-sonnet-4-6", 100, 50);
    service.recordUsage("t2", "openai", "gpt-4o", 200, 100);

    service.resetConversation("t1");

    assert.strictEqual(service.getConversationCost("t1"), null);
    assert.ok(service.getConversationCost("t2") !== null);
  });

  // ── resetAll ────────────────────────────────────────────────────

  test("resetAll clears all conversations", () => {
    service.recordUsage("t1", "anthropic", "claude-sonnet-4-6", 100, 50);
    service.recordUsage("t2", "openai", "gpt-4o", 200, 100);

    service.resetAll();

    assert.strictEqual(service.getConversationCost("t1"), null);
    assert.strictEqual(service.getConversationCost("t2"), null);
  });

  // ── getCostSummary ──────────────────────────────────────────────

  test("getCostSummary returns zero totals when empty", () => {
    const summary = service.getCostSummary();

    assert.strictEqual(summary.totals.inputTokens, 0);
    assert.strictEqual(summary.totals.outputTokens, 0);
    assert.strictEqual(summary.totals.totalTokens, 0);
    assert.strictEqual(summary.totals.estimatedCostUSD, 0);
    assert.strictEqual(summary.totals.requestCount, 0);
    assert.strictEqual(summary.totals.conversationCount, 0);
    assert.deepStrictEqual(summary.providers, []);
    assert.deepStrictEqual(summary.conversations, []);
  });

  test("getCostSummary aggregates a single conversation", () => {
    service.recordUsage("t1", "anthropic", "claude-sonnet-4-6", 1000, 500);

    const summary = service.getCostSummary();

    assert.strictEqual(summary.totals.inputTokens, 1000);
    assert.strictEqual(summary.totals.outputTokens, 500);
    assert.strictEqual(summary.totals.totalTokens, 1500);
    assert.strictEqual(summary.totals.requestCount, 1);
    assert.strictEqual(summary.totals.conversationCount, 1);
    assert.strictEqual(summary.providers.length, 1);
    assert.strictEqual(summary.providers[0].provider, "anthropic");
    assert.strictEqual(summary.conversations.length, 1);
    assert.strictEqual(summary.conversations[0].threadId, "t1");
  });

  test("getCostSummary aggregates multiple conversations per provider", () => {
    service.recordUsage("t1", "anthropic", "claude-sonnet-4-6", 1000, 500);
    service.recordUsage("t2", "anthropic", "claude-sonnet-4-6", 2000, 1000);

    const summary = service.getCostSummary();

    assert.strictEqual(summary.totals.conversationCount, 2);
    assert.strictEqual(summary.totals.inputTokens, 3000);
    assert.strictEqual(summary.totals.outputTokens, 1500);
    assert.strictEqual(summary.providers.length, 1);
    assert.strictEqual(summary.providers[0].inputTokens, 3000);
    assert.strictEqual(summary.providers[0].requestCount, 2);
  });

  test("getCostSummary groups by provider correctly", () => {
    service.recordUsage("t1", "anthropic", "claude-sonnet-4-6", 1000, 500);
    service.recordUsage("t2", "openai", "gpt-4o", 2000, 1000);
    service.recordUsage("t3", "anthropic", "claude-3-5-haiku-20241022", 500, 250);

    const summary = service.getCostSummary();

    assert.strictEqual(summary.totals.conversationCount, 3);
    assert.strictEqual(summary.providers.length, 2);

    const anthropic = summary.providers.find((p) => p.provider === "anthropic");
    const openai = summary.providers.find((p) => p.provider === "openai");

    assert.ok(anthropic);
    assert.ok(openai);
    assert.strictEqual(anthropic!.inputTokens, 1500);
    assert.strictEqual(openai!.inputTokens, 2000);
    assert.strictEqual(anthropic!.requestCount, 2);
    assert.strictEqual(openai!.requestCount, 1);
  });

  test("getCostSummary rounds cost to 6 decimal places", () => {
    // Use a known model with known pricing to verify rounding
    service.recordUsage("t1", "anthropic", "claude-sonnet-4-6", 1, 1);

    const summary = service.getCostSummary();
    const costStr = summary.totals.estimatedCostUSD.toString();
    const decimals = costStr.includes(".") ? costStr.split(".")[1].length : 0;
    assert.ok(decimals <= 6, `Cost should have at most 6 decimals, got ${decimals}`);
  });
});
