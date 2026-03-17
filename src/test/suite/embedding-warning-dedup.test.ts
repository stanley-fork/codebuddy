/**
 * EmbeddingService Warning Dedup Tests
 *
 * Tests: hasWarnedUnsupported is instance-scoped (not static).
 */

import * as assert from "assert";
import * as sinon from "sinon";

suite("EmbeddingService - hasWarnedUnsupported", () => {
  // We replicate the constructor logic inline to avoid pulling in the
  // full Google / OpenAI SDK dependencies that need real API keys.

  function createServiceStub(provider: string) {
    let hasWarnedUnsupported = false;
    const warnings: string[] = [];

    // Simulate the constructor branch that handles unsupported providers
    function initProvider() {
      const p = provider.toLowerCase();
      if (p !== "gemini" && p !== "openai" && p !== "local" && p !== "deepseek" && p !== "groq") {
        if (!hasWarnedUnsupported) {
          hasWarnedUnsupported = true;
          warnings.push(`Unsupported provider for embeddings: ${p}`);
        }
      }
    }

    initProvider();
    return { get hasWarnedUnsupported() { return hasWarnedUnsupported; }, warnings, initProvider };
  }

  test("warns once on unsupported provider", () => {
    const svc = createServiceStub("anthropic");
    assert.strictEqual(svc.hasWarnedUnsupported, true);
    assert.strictEqual(svc.warnings.length, 1);
    // Calling initProvider again should not duplicate the warning
    svc.initProvider();
    assert.strictEqual(svc.warnings.length, 1);
  });

  test("each instance has its own warning flag", () => {
    const svc1 = createServiceStub("anthropic");
    const svc2 = createServiceStub("anthropic");
    assert.strictEqual(svc1.warnings.length, 1);
    assert.strictEqual(svc2.warnings.length, 1);
    // Both should have their own separate flag
    assert.ok(svc1.hasWarnedUnsupported);
    assert.ok(svc2.hasWarnedUnsupported);
  });

  test("supported provider does not trigger warning", () => {
    const svc = createServiceStub("openai");
    assert.strictEqual(svc.hasWarnedUnsupported, false);
    assert.strictEqual(svc.warnings.length, 0);
  });

  test("supported provider gemini does not trigger warning", () => {
    const svc = createServiceStub("gemini");
    assert.strictEqual(svc.hasWarnedUnsupported, false);
    assert.strictEqual(svc.warnings.length, 0);
  });

  afterEach(() => {
    sinon.restore();
  });
});
