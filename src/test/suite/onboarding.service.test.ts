/**
 * OnboardingService Tests
 *
 * Tests the real OnboardingService singleton:
 * - First-run detection via globalState
 * - Version-based re-show
 * - Provider listing with configuration status
 * - Suggested tasks based on project info
 * - Provider ID validation
 * - Completion and dismiss
 * - getState() accuracy
 */

import * as assert from "assert";
import {
  OnboardingService,
  ONBOARDING_STEPS,
  type ProjectInfo,
} from "../../services/onboarding.service";

// ─── Minimal mocks ─────────────────────────────────────

/** Mock globalState that mimics vscode.Memento. */
class MockMemento {
  private store = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    return (this.store.has(key) ? this.store.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }

  setKeysForSync(_keys: readonly string[]): void {
    // no-op
  }
}

/** Mock ExtensionContext with only the fields OnboardingService uses. */
function createMockContext() {
  return {
    globalState: new MockMemento(),
    subscriptions: [] as { dispose: () => void }[],
  } as any; // cast to ExtensionContext shape
}

// ─── Tests ──────────────────────────────────────────────

suite("OnboardingService", () => {
  let service: OnboardingService;

  setup(() => {
    // Reset singleton for each test
    (OnboardingService as any).instance = undefined;
    service = OnboardingService.getInstance();
  });

  teardown(() => {
    service.dispose();
  });

  // ── First-Run Detection ────────────────────────────────

  test("shouldShowOnboarding returns false when not initialized", () => {
    assert.strictEqual(service.shouldShowOnboarding(), false);
  });

  test("shouldShowOnboarding returns true on first run (empty globalState)", () => {
    service.initialize(createMockContext());
    assert.strictEqual(service.shouldShowOnboarding(), true);
  });

  test("shouldShowOnboarding returns false after completion", async () => {
    service.initialize(createMockContext());
    await service.complete();
    assert.strictEqual(service.shouldShowOnboarding(), false);
  });

  test("shouldShowOnboarding returns true when version is bumped", () => {
    const ctx = createMockContext();
    ctx.globalState.update("codebuddy.onboarding.completed", true);
    ctx.globalState.update("codebuddy.onboarding.version", 0);
    service.initialize(ctx);
    assert.strictEqual(service.shouldShowOnboarding(), true);
  });

  test("shouldShowOnboarding returns false when version matches", () => {
    const ctx = createMockContext();
    ctx.globalState.update("codebuddy.onboarding.completed", true);
    ctx.globalState.update("codebuddy.onboarding.version", 1);
    service.initialize(ctx);
    assert.strictEqual(service.shouldShowOnboarding(), false);
  });

  // ── Completion ─────────────────────────────────────────

  test("complete() sets both globalState keys correctly", async () => {
    const ctx = createMockContext();
    service.initialize(ctx);
    assert.strictEqual(service.shouldShowOnboarding(), true);
    await service.complete();
    assert.strictEqual(service.shouldShowOnboarding(), false);
  });

  test("complete() is idempotent", async () => {
    service.initialize(createMockContext());
    await service.complete();
    await service.complete();
    assert.strictEqual(service.shouldShowOnboarding(), false);
  });

  // ── getState() ─────────────────────────────────────────

  test("getState returns completed: false when not initialized", () => {
    const state = service.getState();
    assert.strictEqual(state.completed, false);
    assert.strictEqual(state.version, 0);
  });

  test("getState returns completed: true after completion", async () => {
    service.initialize(createMockContext());
    await service.complete();
    const state = service.getState();
    assert.strictEqual(state.completed, true);
    assert.ok(state.version >= 1);
  });

  // ── Provider Validation ────────────────────────────────

  test("isValidProviderId accepts known providers", () => {
    assert.strictEqual(service.isValidProviderId("anthropic"), true);
    assert.strictEqual(service.isValidProviderId("openai"), true);
    assert.strictEqual(service.isValidProviderId("gemini"), true);
    assert.strictEqual(service.isValidProviderId("groq"), true);
    assert.strictEqual(service.isValidProviderId("deepseek"), true);
    assert.strictEqual(service.isValidProviderId("qwen"), true);
    assert.strictEqual(service.isValidProviderId("glm"), true);
    assert.strictEqual(service.isValidProviderId("local"), true);
  });

  test("isValidProviderId rejects unknown providers", () => {
    assert.strictEqual(service.isValidProviderId("unknown"), false);
    assert.strictEqual(service.isValidProviderId(""), false);
    assert.strictEqual(service.isValidProviderId("OPENAI"), false);
  });

  // ── Step Constants ─────────────────────────────────────

  test("ONBOARDING_STEPS are sequential from 0 to 4", () => {
    assert.strictEqual(ONBOARDING_STEPS.WELCOME, 0);
    assert.strictEqual(ONBOARDING_STEPS.PROVIDER, 1);
    assert.strictEqual(ONBOARDING_STEPS.WORKSPACE, 2);
    assert.strictEqual(ONBOARDING_STEPS.SECURITY, 3);
    assert.strictEqual(ONBOARDING_STEPS.FIRST_TASK, 4);
  });

  // ── Provider List ──────────────────────────────────────

  test("getProviders returns 8 providers when initialized", () => {
    service.initialize(createMockContext());
    const providers = service.getProviders();
    assert.strictEqual(providers.length, 8);
    assert.ok(providers.some((p) => p.id === "anthropic"));
    assert.ok(providers.some((p) => p.id === "openai"));
    assert.ok(providers.some((p) => p.id === "local"));
  });

  test("getProviders returns providers with expected shape", () => {
    service.initialize(createMockContext());
    const providers = service.getProviders();
    for (const p of providers) {
      assert.ok(typeof p.id === "string");
      assert.ok(typeof p.name === "string");
      assert.ok(typeof p.configured === "boolean");
      assert.ok(typeof p.isActive === "boolean");
    }
  });

  // ── Suggested Tasks ────────────────────────────────────

  test("always includes codebase analysis and documentation tasks", () => {
    const info: ProjectInfo = {
      name: "test",
      languages: [],
      frameworks: [],
      hasGit: false,
      hasDocker: false,
      packageManager: null,
    };
    const tasks = service.getSuggestedTasks(info);
    assert.ok(tasks.some((t) => t.label.includes("Analyze")));
    assert.ok(tasks.some((t) => t.label.includes("documentation")));
    assert.ok(tasks.some((t) => t.label.includes("tests")));
  });

  test("includes git review task when git is detected", () => {
    const info: ProjectInfo = {
      name: "test",
      languages: [],
      frameworks: [],
      hasGit: true,
      hasDocker: false,
      packageManager: null,
    };
    const tasks = service.getSuggestedTasks(info);
    assert.ok(tasks.some((t) => t.label.includes("Review recent")));
  });

  test("includes bug finding task for TypeScript projects", () => {
    const info: ProjectInfo = {
      name: "test",
      languages: ["TypeScript"],
      frameworks: [],
      hasGit: false,
      hasDocker: false,
      packageManager: null,
    };
    const tasks = service.getSuggestedTasks(info);
    assert.ok(tasks.some((t) => t.label.includes("Find and fix")));
  });

  test("includes dependency check for Python projects", () => {
    const info: ProjectInfo = {
      name: "test",
      languages: ["Python"],
      frameworks: [],
      hasGit: false,
      hasDocker: false,
      packageManager: null,
    };
    const tasks = service.getSuggestedTasks(info);
    assert.ok(tasks.some((t) => t.label.includes("dependencies")));
  });

  test("does not include git task when no git", () => {
    const info: ProjectInfo = {
      name: "test",
      languages: [],
      frameworks: [],
      hasGit: false,
      hasDocker: false,
      packageManager: null,
    };
    const tasks = service.getSuggestedTasks(info);
    assert.ok(!tasks.some((t) => t.label.includes("Review recent")));
  });

  // ── testProvider ───────────────────────────────────────

  test("testProvider returns error for unknown provider", async () => {
    service.initialize(createMockContext());
    const result = await service.testProvider("unknown");
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, "Unknown provider");
  });

  test("testProvider returns no key configured when no key stored", async () => {
    service.initialize(createMockContext());
    const result = await service.testProvider("openai");
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error?.includes("No API key") || result.error?.includes("too short"),
    );
  });

  // ── Singleton ──────────────────────────────────────────

  test("getInstance returns the same instance", () => {
    const a = OnboardingService.getInstance();
    const b = OnboardingService.getInstance();
    assert.strictEqual(a, b);
  });

  test("dispose clears the singleton", () => {
    const a = OnboardingService.getInstance();
    a.dispose();
    const b = OnboardingService.getInstance();
    assert.notStrictEqual(a, b);
  });
});
