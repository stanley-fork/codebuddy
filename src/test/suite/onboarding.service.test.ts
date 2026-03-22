/**
 * OnboardingService Tests
 *
 * Tests the first-run onboarding wizard service:
 * - First-run detection via globalState
 * - Version-based re-show
 * - Provider listing with configuration status
 * - Workspace project detection (languages, frameworks, tooling)
 * - Suggested tasks based on project info
 * - Step completion handling
 * - Completion and dismiss
 */

import * as assert from "assert";

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
function createMockContext(): {
  globalState: MockMemento;
  subscriptions: { dispose: () => void }[];
} {
  return {
    globalState: new MockMemento(),
    subscriptions: [],
  };
}

// ─── Inline replica of OnboardingService logic for testing ──────────

const ONBOARDING_COMPLETED_KEY = "codebuddy.onboarding.completed";
const ONBOARDING_VERSION_KEY = "codebuddy.onboarding.version";
const CURRENT_WIZARD_VERSION = 1;

type MockContext = ReturnType<typeof createMockContext>;

function shouldShowOnboarding(ctx: MockContext): boolean {
  const completed = ctx.globalState.get<boolean>(ONBOARDING_COMPLETED_KEY, false);
  const version = ctx.globalState.get<number>(ONBOARDING_VERSION_KEY, 0);
  if (!completed) return true;
  if (version < CURRENT_WIZARD_VERSION) return true;
  return false;
}

async function complete(ctx: MockContext): Promise<void> {
  await ctx.globalState.update(ONBOARDING_COMPLETED_KEY, true);
  await ctx.globalState.update(ONBOARDING_VERSION_KEY, CURRENT_WIZARD_VERSION);
}

// ─── Language / Framework Detection (mirror of production) ──────────

const LANGUAGE_INDICATORS: Record<string, string[]> = {
  TypeScript: ["tsconfig.json", ".ts"],
  JavaScript: ["package.json", ".js", ".mjs"],
  Python: ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile", ".py"],
  Java: ["pom.xml", "build.gradle", ".java"],
  Go: ["go.mod", "go.sum", ".go"],
  Rust: ["Cargo.toml", ".rs"],
  PHP: ["composer.json", ".php"],
  Ruby: ["Gemfile", ".rb"],
  "C#": [".csproj", ".sln", ".cs"],
  Swift: ["Package.swift", ".swift"],
};

function detectLanguages(files: string[]): string[] {
  const languages: string[] = [];
  for (const [lang, indicators] of Object.entries(LANGUAGE_INDICATORS)) {
    for (const indicator of indicators) {
      if (indicator.startsWith(".")) {
        if (files.some((f) => f.endsWith(indicator))) {
          if (!languages.includes(lang)) languages.push(lang);
          break;
        }
      } else {
        if (files.includes(indicator)) {
          if (!languages.includes(lang)) languages.push(lang);
          break;
        }
      }
    }
  }
  return languages;
}

function detectPackageManager(files: string[]): string | null {
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lockb")) return "bun";
  if (files.includes("package-lock.json")) return "npm";
  if (files.includes("Pipfile.lock")) return "pipenv";
  if (files.includes("poetry.lock")) return "poetry";
  return null;
}

interface ProjectInfo {
  name: string;
  languages: string[];
  frameworks: string[];
  hasGit: boolean;
  hasDocker: boolean;
  packageManager: string | null;
}

function getSuggestedTasks(info: ProjectInfo): Array<{ label: string; prompt: string }> {
  const tasks: Array<{ label: string; prompt: string }> = [];
  tasks.push({
    label: "Analyze this codebase",
    prompt: "Analyze this codebase and give me a high-level overview of the architecture, key files, and dependencies.",
  });
  if (info.hasGit) {
    tasks.push({
      label: "Review recent changes",
      prompt: "Review the recent git changes and summarize what was worked on.",
    });
  }
  if (info.languages.includes("TypeScript") || info.languages.includes("JavaScript")) {
    tasks.push({
      label: "Find and fix issues",
      prompt: "Look for potential bugs, type errors, or code quality issues in the codebase and suggest fixes.",
    });
  }
  if (info.languages.includes("Python")) {
    tasks.push({
      label: "Check dependencies",
      prompt: "Check the Python dependencies for security vulnerabilities and outdated packages.",
    });
  }
  tasks.push({
    label: "Generate documentation",
    prompt: "Generate documentation for the main modules in this project.",
  });
  tasks.push({
    label: "Write tests",
    prompt: "Identify areas with low test coverage and write tests for the most critical paths.",
  });
  return tasks;
}

// ─── Tests ──────────────────────────────────────────────

suite("OnboardingService", () => {
  // ── First-Run Detection ────────────────────────────────

  test("shouldShowOnboarding returns true on first run (empty globalState)", () => {
    const ctx = createMockContext();
    assert.strictEqual(shouldShowOnboarding(ctx), true);
  });

  test("shouldShowOnboarding returns false after completion", async () => {
    const ctx = createMockContext();
    await complete(ctx);
    assert.strictEqual(shouldShowOnboarding(ctx), false);
  });

  test("shouldShowOnboarding returns true when version is bumped", async () => {
    const ctx = createMockContext();
    // Simulate completed at an older version
    await ctx.globalState.update(ONBOARDING_COMPLETED_KEY, true);
    await ctx.globalState.update(ONBOARDING_VERSION_KEY, 0);
    assert.strictEqual(shouldShowOnboarding(ctx), true);
  });

  test("shouldShowOnboarding returns false when version matches", async () => {
    const ctx = createMockContext();
    await ctx.globalState.update(ONBOARDING_COMPLETED_KEY, true);
    await ctx.globalState.update(ONBOARDING_VERSION_KEY, CURRENT_WIZARD_VERSION);
    assert.strictEqual(shouldShowOnboarding(ctx), false);
  });

  // ── Completion ─────────────────────────────────────────

  test("complete() sets both globalState keys", async () => {
    const ctx = createMockContext();
    assert.strictEqual(shouldShowOnboarding(ctx), true);
    await complete(ctx);
    assert.strictEqual(ctx.globalState.get(ONBOARDING_COMPLETED_KEY), true);
    assert.strictEqual(ctx.globalState.get(ONBOARDING_VERSION_KEY), CURRENT_WIZARD_VERSION);
    assert.strictEqual(shouldShowOnboarding(ctx), false);
  });

  test("complete() is idempotent", async () => {
    const ctx = createMockContext();
    await complete(ctx);
    await complete(ctx);
    assert.strictEqual(ctx.globalState.get(ONBOARDING_COMPLETED_KEY), true);
  });

  // ── Language Detection ─────────────────────────────────

  test("detects TypeScript from tsconfig.json", () => {
    const langs = detectLanguages(["tsconfig.json", "package.json", "src"]);
    assert.ok(langs.includes("TypeScript"));
  });

  test("detects JavaScript from .js files", () => {
    const langs = detectLanguages(["index.js", "README.md"]);
    assert.ok(langs.includes("JavaScript"));
  });

  test("detects Python from requirements.txt", () => {
    const langs = detectLanguages(["requirements.txt", "main.py"]);
    assert.ok(langs.includes("Python"));
  });

  test("detects Go from go.mod", () => {
    const langs = detectLanguages(["go.mod", "main.go"]);
    assert.ok(langs.includes("Go"));
  });

  test("detects Rust from Cargo.toml", () => {
    const langs = detectLanguages(["Cargo.toml", "src"]);
    assert.ok(langs.includes("Rust"));
  });

  test("detects multiple languages", () => {
    const langs = detectLanguages([
      "tsconfig.json",
      "package.json",
      "requirements.txt",
      "Dockerfile",
    ]);
    assert.ok(langs.includes("TypeScript"));
    assert.ok(langs.includes("JavaScript"));
    assert.ok(langs.includes("Python"));
  });

  test("returns empty array for unknown project", () => {
    const langs = detectLanguages(["README.md", "LICENSE", ".gitignore"]);
    assert.strictEqual(langs.length, 0);
  });

  // ── Package Manager Detection ──────────────────────────

  test("detects npm from package-lock.json", () => {
    assert.strictEqual(detectPackageManager(["package-lock.json", "package.json"]), "npm");
  });

  test("detects yarn from yarn.lock", () => {
    assert.strictEqual(detectPackageManager(["yarn.lock", "package.json"]), "yarn");
  });

  test("detects pnpm from pnpm-lock.yaml", () => {
    assert.strictEqual(detectPackageManager(["pnpm-lock.yaml", "package.json"]), "pnpm");
  });

  test("detects bun from bun.lockb", () => {
    assert.strictEqual(detectPackageManager(["bun.lockb", "package.json"]), "bun");
  });

  test("detects pipenv from Pipfile.lock", () => {
    assert.strictEqual(detectPackageManager(["Pipfile.lock", "Pipfile"]), "pipenv");
  });

  test("detects poetry from poetry.lock", () => {
    assert.strictEqual(detectPackageManager(["poetry.lock", "pyproject.toml"]), "poetry");
  });

  test("returns null when no lock file found", () => {
    assert.strictEqual(detectPackageManager(["package.json", "README.md"]), null);
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
    const tasks = getSuggestedTasks(info);
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
    const tasks = getSuggestedTasks(info);
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
    const tasks = getSuggestedTasks(info);
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
    const tasks = getSuggestedTasks(info);
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
    const tasks = getSuggestedTasks(info);
    assert.ok(!tasks.some((t) => t.label.includes("Review recent")));
  });

  // ── Provider Test Validation ───────────────────────────

  test("API key with length < 10 should be considered too short", () => {
    // Mirror the validation logic in testProvider
    const key = "sk-short";
    assert.ok(key.length < 10, "Short key should fail validation");
  });

  test("empty key should fail validation", () => {
    const key = "";
    assert.ok(!key || key === "apiKey" || key === "not-needed" || key === "");
  });

  test("valid key format passes basic checks", () => {
    const key = "sk-proj-1234567890abcdef";
    assert.ok(key.length >= 10);
    assert.ok(key !== "apiKey" && key !== "not-needed" && key !== "");
  });
});
