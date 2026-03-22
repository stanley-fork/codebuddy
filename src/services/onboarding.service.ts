import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { Logger } from "../infrastructure/logger/logger";
import { LogLevel } from "./telemetry";
import { APP_CONFIG, generativeAiModels } from "../application/constant";
import { getConfigValue } from "../utils/utils";

// ─── Types ──────────────────────────────────────────────

export interface OnboardingState {
  completed: boolean;
  version: number;
  currentStep: number;
  /** ISO timestamp of when the wizard was completed / dismissed. */
  completedAt: string | null;
  /** Detected project info for workspace config step. */
  projectInfo: ProjectInfo | null;
  /** Which provider the user selected during onboarding. */
  selectedProvider: string | null;
}

export interface ProjectInfo {
  name: string;
  languages: string[];
  frameworks: string[];
  hasGit: boolean;
  hasDocker: boolean;
  packageManager: string | null;
}

export interface ProviderTestResult {
  provider: string;
  success: boolean;
  latencyMs: number;
  error?: string;
}

export interface OnboardingStepResult {
  step: number;
  data: Record<string, unknown>;
}

// ─── Constants ──────────────────────────────────────────

const ONBOARDING_COMPLETED_KEY = "codebuddy.onboarding.completed";
const ONBOARDING_VERSION_KEY = "codebuddy.onboarding.version";
const CURRENT_WIZARD_VERSION = 1;

const STEP_COUNT = 5;

/** Provider display info, ordered by popularity. */
const PROVIDERS = [
  {
    id: "anthropic",
    name: "Anthropic",
    configKey: APP_CONFIG.anthropicApiKey,
    model: generativeAiModels.ANTHROPIC,
  },
  {
    id: "openai",
    name: "OpenAI",
    configKey: APP_CONFIG.openaiApiKey,
    model: generativeAiModels.OPENAI,
  },
  {
    id: "gemini",
    name: "Google Gemini",
    configKey: APP_CONFIG.geminiKey,
    model: generativeAiModels.GEMINI,
  },
  {
    id: "groq",
    name: "Groq",
    configKey: APP_CONFIG.groqApiKey,
    model: generativeAiModels.GROQ,
  },
  {
    id: "deepseek",
    name: "Deepseek",
    configKey: APP_CONFIG.deepseekApiKey,
    model: generativeAiModels.DEEPSEEK,
  },
  {
    id: "qwen",
    name: "Qwen",
    configKey: APP_CONFIG.qwenApiKey,
    model: generativeAiModels.QWEN,
  },
  {
    id: "glm",
    name: "GLM",
    configKey: APP_CONFIG.glmApiKey,
    model: generativeAiModels.GLM,
  },
  {
    id: "local",
    name: "Local / Ollama",
    configKey: APP_CONFIG.localApiKey,
    model: generativeAiModels.LOCAL,
  },
] as const;

// ─── Language / framework detection heuristics ──────────

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

const FRAMEWORK_INDICATORS: Record<string, string[]> = {
  React: ["react", "react-dom"],
  "Next.js": ["next"],
  Vue: ["vue"],
  Angular: ["@angular/core"],
  Express: ["express"],
  NestJS: ["@nestjs/core"],
  FastAPI: ["fastapi"],
  Django: ["django"],
  Flask: ["flask"],
  Spring: ["spring-boot"],
  Rails: ["rails"],
  Laravel: ["laravel"],
};

// ─── Service ────────────────────────────────────────────

export class OnboardingService implements vscode.Disposable {
  private static instance: OnboardingService | undefined;
  private readonly logger: Logger;
  private readonly disposables: vscode.Disposable[] = [];
  private context: vscode.ExtensionContext | undefined;

  private constructor() {
    this.logger = Logger.initialize("OnboardingService", {
      minLevel: LogLevel.DEBUG,
      enableConsole: true,
      enableFile: true,
      enableTelemetry: false,
    });
  }

  static getInstance(): OnboardingService {
    if (!OnboardingService.instance) {
      OnboardingService.instance = new OnboardingService();
    }
    return OnboardingService.instance;
  }

  /**
   * Initialize with the extension context. Must be called during activation.
   */
  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    this.logger.info("OnboardingService initialized");
  }

  // ─── First-Run Detection ───────────────────────────────

  /**
   * Returns true if the onboarding wizard should be shown.
   * Conditions: not yet completed OR wizard version has been bumped.
   */
  shouldShowOnboarding(): boolean {
    if (!this.context) return false;

    const completed = this.context.globalState.get<boolean>(
      ONBOARDING_COMPLETED_KEY,
      false,
    );
    const version = this.context.globalState.get<number>(
      ONBOARDING_VERSION_KEY,
      0,
    );

    if (!completed) return true;
    if (version < CURRENT_WIZARD_VERSION) return true;

    return false;
  }

  // ─── State ─────────────────────────────────────────────

  getState(): OnboardingState {
    if (!this.context) {
      return {
        completed: false,
        version: 0,
        currentStep: 0,
        completedAt: null,
        projectInfo: null,
        selectedProvider: null,
      };
    }

    return {
      completed: this.context.globalState.get<boolean>(
        ONBOARDING_COMPLETED_KEY,
        false,
      ),
      version: this.context.globalState.get<number>(ONBOARDING_VERSION_KEY, 0),
      currentStep: 0,
      completedAt: null,
      projectInfo: null,
      selectedProvider: null,
    };
  }

  // ─── Step Completion ───────────────────────────────────

  async completeStep(result: OnboardingStepResult): Promise<void> {
    if (!this.context) return;

    switch (result.step) {
      case 1: // Provider Setup
        if (result.data.provider && result.data.apiKey) {
          await this.saveProviderConfig(
            result.data.provider as string,
            result.data.apiKey as string,
          );
        }
        break;

      case 2: // Workspace Config
        if (result.data.createRules) {
          await this.scaffoldRulesFile();
        }
        if (result.data.enableSkills && Array.isArray(result.data.skills)) {
          // Skills enablement is handled by SkillService — just log intent
          this.logger.info(
            `Onboarding: user selected ${(result.data.skills as string[]).length} skills`,
          );
        }
        break;

      case 3: // Security Review
        if (result.data.permissionProfile) {
          await vscode.workspace
            .getConfiguration()
            .update(
              "codebuddy.permissionScope.defaultProfile",
              result.data.permissionProfile,
              vscode.ConfigurationTarget.Global,
            );
          this.logger.info(
            `Onboarding: permission profile set to ${result.data.permissionProfile}`,
          );
        }
        break;

      default:
        break;
    }

    this.logger.info(`Onboarding step ${result.step} completed`);
  }

  /**
   * Mark onboarding as fully completed or dismissed.
   */
  async complete(): Promise<void> {
    if (!this.context) return;

    await this.context.globalState.update(ONBOARDING_COMPLETED_KEY, true);
    await this.context.globalState.update(
      ONBOARDING_VERSION_KEY,
      CURRENT_WIZARD_VERSION,
    );
    this.logger.info("Onboarding wizard completed");
  }

  // ─── Provider Config ───────────────────────────────────

  /**
   * Returns the list of known providers with their current configuration status.
   */
  getProviders(): Array<{
    id: string;
    name: string;
    configured: boolean;
    isActive: boolean;
  }> {
    const activeProvider = getConfigValue(APP_CONFIG.generativeAi) as
      | string
      | undefined;

    return PROVIDERS.map((p) => {
      let configured = false;
      try {
        const { SecretStorageService } = require("./secret-storage");
        const key = SecretStorageService.getInstance().getApiKey(p.configKey);
        if (key && key !== "apiKey" && key !== "not-needed" && key !== "") {
          configured = true;
        }
      } catch {
        // SecretStorage not yet initialized — check settings fallback
        const settingsKey = getConfigValue(p.configKey) as string | undefined;
        if (
          settingsKey &&
          settingsKey !== "apiKey" &&
          settingsKey !== "not-needed" &&
          settingsKey !== ""
        ) {
          configured = true;
        }
      }

      // Local provider is always "configured" if base URL is set
      if (p.id === "local") {
        const baseUrl = getConfigValue(APP_CONFIG.localBaseUrl) as
          | string
          | undefined;
        if (baseUrl && baseUrl !== "") configured = true;
      }

      return {
        id: p.id,
        name: p.name,
        configured,
        isActive:
          activeProvider?.toLowerCase() === p.model.toLowerCase() ||
          activeProvider?.toLowerCase() === p.id,
      };
    });
  }

  /**
   * Save an API key for a provider and set it as active.
   */
  private async saveProviderConfig(
    providerId: string,
    apiKey: string,
  ): Promise<void> {
    const provider = PROVIDERS.find((p) => p.id === providerId);
    if (!provider) {
      this.logger.warn(`Unknown provider: ${providerId}`);
      return;
    }

    // Store the API key securely
    try {
      const { SecretStorageService } = await import("./secret-storage");
      await SecretStorageService.getInstance().storeApiKey(
        provider.configKey,
        apiKey,
      );
    } catch {
      // Fallback to settings
      await vscode.workspace
        .getConfiguration()
        .update(provider.configKey, apiKey, vscode.ConfigurationTarget.Global);
    }

    // Set as active provider
    await vscode.workspace
      .getConfiguration()
      .update(
        APP_CONFIG.generativeAi,
        provider.model,
        vscode.ConfigurationTarget.Global,
      );

    this.logger.info(
      `Onboarding: ${provider.name} configured and set as active`,
    );
  }

  /**
   * Test that a provider's API key works by making a lightweight request.
   */
  async testProvider(
    providerId: string,
    apiKey?: string,
  ): Promise<ProviderTestResult> {
    const provider = PROVIDERS.find((p) => p.id === providerId);
    if (!provider) {
      return {
        provider: providerId,
        success: false,
        latencyMs: 0,
        error: "Unknown provider",
      };
    }

    const start = Date.now();
    try {
      // For now, check that the key is non-empty. A full connection test
      // would require importing each provider SDK which is expensive.
      // The failover service will detect broken keys at first use.
      let key = apiKey;
      if (!key) {
        try {
          const { SecretStorageService } = await import("./secret-storage");
          key = SecretStorageService.getInstance().getApiKey(
            provider.configKey,
          );
        } catch {
          key = getConfigValue(provider.configKey) as string | undefined;
        }
      }

      if (providerId === "local") {
        const baseUrl = getConfigValue(APP_CONFIG.localBaseUrl) as
          | string
          | undefined;
        if (!baseUrl) {
          return {
            provider: providerId,
            success: false,
            latencyMs: Date.now() - start,
            error: "No base URL configured for local provider",
          };
        }
        // Quick reachability check for local provider
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          const resp = await fetch(`${baseUrl}/v1/models`, {
            signal: controller.signal,
            method: "GET",
          });
          clearTimeout(timeout);
          return {
            provider: providerId,
            success: resp.ok,
            latencyMs: Date.now() - start,
            error: resp.ok ? undefined : `HTTP ${resp.status}`,
          };
        } catch (err) {
          return {
            provider: providerId,
            success: false,
            latencyMs: Date.now() - start,
            error: err instanceof Error ? err.message : "Connection failed",
          };
        }
      }

      if (!key || key === "apiKey" || key === "not-needed" || key === "") {
        return {
          provider: providerId,
          success: false,
          latencyMs: Date.now() - start,
          error: "No API key configured",
        };
      }

      // Key format validation (basic sanity check)
      if (key.length < 10) {
        return {
          provider: providerId,
          success: false,
          latencyMs: Date.now() - start,
          error: "API key appears too short",
        };
      }

      return {
        provider: providerId,
        success: true,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        provider: providerId,
        success: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : "Test failed",
      };
    }
  }

  // ─── Workspace Detection ───────────────────────────────

  /**
   * Detect project language, framework, and tooling from workspace files.
   */
  async detectProjectInfo(): Promise<ProjectInfo> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return {
        name: "Unknown",
        languages: [],
        frameworks: [],
        hasGit: false,
        hasDocker: false,
        packageManager: null,
      };
    }

    const root = folder.uri.fsPath;
    const projectName = path.basename(root);
    const languages: string[] = [];
    const frameworks: string[] = [];

    // Detect languages by checking for indicator files
    let topLevelFiles: string[];
    try {
      topLevelFiles = fs.readdirSync(root);
    } catch {
      topLevelFiles = [];
    }

    for (const [lang, indicators] of Object.entries(LANGUAGE_INDICATORS)) {
      for (const indicator of indicators) {
        if (indicator.startsWith(".")) {
          // File extension — check if any top-level file matches
          if (topLevelFiles.some((f) => f.endsWith(indicator))) {
            if (!languages.includes(lang)) languages.push(lang);
            break;
          }
        } else {
          // Exact file — check existence
          if (topLevelFiles.includes(indicator)) {
            if (!languages.includes(lang)) languages.push(lang);
            break;
          }
        }
      }
    }

    // Detect frameworks from package.json dependencies
    const pkgJsonPath = path.join(root, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const raw = fs.readFileSync(pkgJsonPath, "utf-8");
        const pkg = JSON.parse(raw);
        const allDeps = {
          ...(pkg.dependencies || {}),
          ...(pkg.devDependencies || {}),
        };

        for (const [fw, indicators] of Object.entries(FRAMEWORK_INDICATORS)) {
          for (const indicator of indicators) {
            if (indicator in allDeps) {
              frameworks.push(fw);
              break;
            }
          }
        }
      } catch {
        // Invalid package.json — skip
      }
    }

    // Detect Python frameworks from requirements.txt
    const reqPath = path.join(root, "requirements.txt");
    if (fs.existsSync(reqPath)) {
      try {
        const raw = fs.readFileSync(reqPath, "utf-8").toLowerCase();
        for (const [fw, indicators] of Object.entries(FRAMEWORK_INDICATORS)) {
          for (const indicator of indicators) {
            if (raw.includes(indicator)) {
              if (!frameworks.includes(fw)) frameworks.push(fw);
              break;
            }
          }
        }
      } catch {
        // Skip
      }
    }

    const hasGit =
      topLevelFiles.includes(".git") || fs.existsSync(path.join(root, ".git"));
    const hasDocker =
      topLevelFiles.includes("Dockerfile") ||
      topLevelFiles.includes("docker-compose.yml") ||
      topLevelFiles.includes("docker-compose.yaml");

    let packageManager: string | null = null;
    if (topLevelFiles.includes("pnpm-lock.yaml")) packageManager = "pnpm";
    else if (topLevelFiles.includes("yarn.lock")) packageManager = "yarn";
    else if (topLevelFiles.includes("bun.lockb")) packageManager = "bun";
    else if (topLevelFiles.includes("package-lock.json"))
      packageManager = "npm";
    else if (topLevelFiles.includes("Pipfile.lock")) packageManager = "pipenv";
    else if (topLevelFiles.includes("poetry.lock")) packageManager = "poetry";

    return {
      name: projectName,
      languages,
      frameworks,
      hasGit,
      hasDocker,
      packageManager,
    };
  }

  // ─── Rules File Scaffolding ────────────────────────────

  private async scaffoldRulesFile(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;

    const rulesPath = path.join(folder.uri.fsPath, ".codebuddy", "rules.md");
    if (fs.existsSync(rulesPath)) {
      this.logger.info("Rules file already exists, skipping scaffold");
      return;
    }

    const dir = path.dirname(rulesPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const info = await this.detectProjectInfo();
    const langLine =
      info.languages.length > 0
        ? `- **Languages**: ${info.languages.join(", ")}`
        : "- **Languages**: (auto-detected)";
    const fwLine =
      info.frameworks.length > 0
        ? `- **Frameworks**: ${info.frameworks.join(", ")}`
        : "";

    const content = `# Project Rules for CodeBuddy

## Project Context
${langLine}
${fwLine}
- **Package Manager**: ${info.packageManager ?? "unknown"}

## Coding Style
- Follow the existing code style and conventions in this project.
- Use descriptive variable and function names.
- Keep functions focused — one responsibility each.

## Testing
- Write tests for new features and bug fixes.
- Use the project's existing test framework and patterns.

## Safety
- Never commit secrets or API keys.
- Validate all user inputs at system boundaries.
`;

    fs.writeFileSync(rulesPath, content, "utf-8");
    this.logger.info("Scaffolded .codebuddy/rules.md");
  }

  // ─── Suggested First Tasks ─────────────────────────────

  /**
   * Returns a list of suggested first tasks based on the detected project.
   */
  getSuggestedTasks(
    info: ProjectInfo,
  ): Array<{ label: string; prompt: string }> {
    const tasks: Array<{ label: string; prompt: string }> = [];

    tasks.push({
      label: "Analyze this codebase",
      prompt:
        "Analyze this codebase and give me a high-level overview of the architecture, key files, and dependencies.",
    });

    if (info.hasGit) {
      tasks.push({
        label: "Review recent changes",
        prompt:
          "Review the recent git changes and summarize what was worked on.",
      });
    }

    if (
      info.languages.includes("TypeScript") ||
      info.languages.includes("JavaScript")
    ) {
      tasks.push({
        label: "Find and fix issues",
        prompt:
          "Look for potential bugs, type errors, or code quality issues in the codebase and suggest fixes.",
      });
    }

    if (info.languages.includes("Python")) {
      tasks.push({
        label: "Check dependencies",
        prompt:
          "Check the Python dependencies for security vulnerabilities and outdated packages.",
      });
    }

    tasks.push({
      label: "Generate documentation",
      prompt: "Generate documentation for the main modules in this project.",
    });

    tasks.push({
      label: "Write tests",
      prompt:
        "Identify areas with low test coverage and write tests for the most critical paths.",
    });

    return tasks;
  }

  // ─── Lifecycle ─────────────────────────────────────────

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    OnboardingService.instance = undefined;
  }
}
