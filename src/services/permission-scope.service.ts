import * as fs from "fs";
import { readFile, access, stat } from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../infrastructure/logger/logger";

// ─── Types ───────────────────────────────────────────────────────────

/**
 * Permission profiles control what tools and operations are available.
 *
 * - `restricted`: Read-only access. No terminal, no file writes.
 * - `standard`: Read/write with safe terminal commands. Dangerous commands denied.
 * - `trusted`: Full access. Auto-approves known safe tools.
 */
export type PermissionProfile = "restricted" | "standard" | "trusted";

/**
 * Shape of `.codebuddy/permissions.json`.
 */
export interface PermissionConfig {
  /** Active permission profile. Defaults to `standard`. */
  profile?: PermissionProfile;
  /** Extra commands to deny on top of the built-in deny list (regex strings). */
  commandDenyPatterns?: string[];
  /** Tool names that are explicitly allowed regardless of profile restrictions. */
  toolAllowlist?: string[];
  /** Tool names that are explicitly blocked regardless of profile. */
  toolBlocklist?: string[];
}

export interface PermissionDiagnostic {
  severity: "info" | "warn" | "critical";
  message: string;
  code?:
    | "no-config"
    | "config-loaded"
    | "invalid-profile"
    | "invalid-regex"
    | "blocklist-overlap";
}

// ─── Constants ───────────────────────────────────────────────────────

const CONFIG_FILENAME = "permissions.json";
const CODEBUDDY_DIR = ".codebuddy";
const VALID_PROFILES: readonly PermissionProfile[] = [
  "restricted",
  "standard",
  "trusted",
];

/**
 * Maximum length of a single regex pattern supplied by the user.
 * Prevents ReDoS from pathologically large expressions.
 */
const MAX_PATTERN_LENGTH = 200;

/**
 * Built-in dangerous command patterns — always enforced on `restricted`
 * and `standard` profiles. The external-security-config has its own set;
 * these are evaluated independently as an additional gate in the
 * permission layer.
 */
const DANGEROUS_COMMAND_PATTERNS: readonly string[] = [
  // Destructive file operations
  String.raw`rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?/`,
  String.raw`rm\s+-rf\b`,
  String.raw`rmdir\s+/`,
  // Disk / partition
  String.raw`\bmkfs\b`,
  String.raw`\bdd\s+.*of=/dev/`,
  // Fork bomb
  String.raw`:\(\)\s*\{`,
  // Piped execution (RCE)
  String.raw`curl\s.*\|\s*(bash|sh|zsh|python)`,
  String.raw`wget\s.*\|\s*(bash|sh|zsh|python)`,
  // Privilege escalation
  String.raw`\bchmod\s+777\b`,
  String.raw`\bchown\s+root\b`,
  // Data exfiltration patterns
  String.raw`\beval\b.*\$`,
];

/**
 * Tools that are read-only and safe in any profile.
 * Used by `restricted` profile to limit available tools.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "search_files",
  "list_files",
  "search_vector_db",
  "ripgrep_search",
  "search_symbols",
  "get_diagnostics",
  "get_architecture_knowledge",
  "think",
  "travily_search",
  "search_vector_db",
  "open_web_preview",
  "standup_intelligence",
  "team_graph",
]);

/**
 * Tools requiring terminal access — blocked in `restricted` profile.
 */
const TERMINAL_TOOLS: ReadonlySet<string> = new Set([
  "terminal",
  "manage_terminal",
  "run_tests",
]);

/**
 * Write-capable tools — blocked in `restricted` profile.
 */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "compose_files",
  "git",
  "manage_tasks",
  "manage_core_memory",
]);

// ─── Service ─────────────────────────────────────────────────────────

const logger = Logger.initialize("PermissionScopeService", {
  minLevel: LogLevel.DEBUG,
  enableConsole: true,
  enableFile: true,
  enableTelemetry: true,
});

export class PermissionScopeService implements vscode.Disposable {
  private static instance: PermissionScopeService | undefined;

  private activeProfile: PermissionProfile = "standard";
  private config: PermissionConfig = {};
  private compiledDenyPatterns: RegExp[] = [];
  private configWatcher: vscode.FileSystemWatcher | undefined;
  private workspacePath: string | undefined;
  private isInitialized = false;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  /** Event fired when the active permission profile changes. */
  private readonly _onProfileChanged =
    new vscode.EventEmitter<PermissionProfile>();
  public readonly onProfileChanged = this._onProfileChanged.event;

  private constructor() {}

  public static getInstance(): PermissionScopeService {
    if (!PermissionScopeService.instance) {
      PermissionScopeService.instance = new PermissionScopeService();
    }
    return PermissionScopeService.instance;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Load `.codebuddy/permissions.json` from the workspace (if present)
   * and start watching for changes.
   */
  public async initialize(workspacePath?: string): Promise<void> {
    this.workspacePath = workspacePath;

    // Also read the VS Code setting as the base profile
    const settingProfile = vscode.workspace
      .getConfiguration("codebuddy")
      .get<PermissionProfile>("permissionScope.defaultProfile", "standard");

    if (VALID_PROFILES.includes(settingProfile)) {
      this.activeProfile = settingProfile;
    }

    // Try loading workspace config (overrides setting if present)
    if (workspacePath) {
      await this.loadConfig(workspacePath);
      this.startWatching(workspacePath);
    }

    this.isInitialized = true;
    logger.info(`Permission scope initialized: profile=${this.activeProfile}`);
  }

  public dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.configWatcher?.dispose();
    this._onProfileChanged.dispose();
  }

  // ── Config Loading ───────────────────────────────────────────────

  private async loadConfig(workspacePath: string): Promise<void> {
    const configPath = path.join(workspacePath, CODEBUDDY_DIR, CONFIG_FILENAME);

    try {
      await access(configPath, fs.constants.R_OK);
    } catch {
      logger.debug("No permissions.json found — using defaults");
      return;
    }

    try {
      const raw = await readFile(configPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        logger.warn("permissions.json root must be an object — ignoring");
        return;
      }

      const cfg = parsed as Record<string, unknown>;
      this.config = {};

      // Profile
      if (typeof cfg.profile === "string") {
        if (VALID_PROFILES.includes(cfg.profile as PermissionProfile)) {
          this.config.profile = cfg.profile as PermissionProfile;
          this.activeProfile = this.config.profile;
        } else {
          logger.warn(
            `Invalid profile "${cfg.profile}" in permissions.json — ignoring (valid: ${VALID_PROFILES.join(", ")})`,
          );
        }
      }

      // commandDenyPatterns
      if (Array.isArray(cfg.commandDenyPatterns)) {
        this.config.commandDenyPatterns = cfg.commandDenyPatterns.filter(
          (p): p is string => typeof p === "string",
        );
      }

      // toolAllowlist / toolBlocklist
      if (Array.isArray(cfg.toolAllowlist)) {
        this.config.toolAllowlist = cfg.toolAllowlist.filter(
          (t): t is string => typeof t === "string",
        );
      }
      if (Array.isArray(cfg.toolBlocklist)) {
        this.config.toolBlocklist = cfg.toolBlocklist.filter(
          (t): t is string => typeof t === "string",
        );
      }

      // If the config file specifies a profile, use it over the VS Code setting
      if (this.config.profile) {
        const old = this.activeProfile;
        this.activeProfile = this.config.profile;
        if (old !== this.activeProfile) {
          this._onProfileChanged.fire(this.activeProfile);
        }
      }

      // Compile deny patterns
      this.compileDenyPatterns();

      logger.info(
        `Loaded permissions.json: profile=${this.activeProfile}, ` +
          `denyPatterns=${this.compiledDenyPatterns.length}, ` +
          `allowlist=${this.config.toolAllowlist?.length ?? 0}, ` +
          `blocklist=${this.config.toolBlocklist?.length ?? 0}`,
      );
    } catch (err) {
      logger.warn(
        `Failed to parse permissions.json: ${(err as Error).message}`,
      );
    }
  }

  private compileDenyPatterns(): void {
    this.compiledDenyPatterns = [];
    const sources = [
      ...DANGEROUS_COMMAND_PATTERNS,
      ...(this.config.commandDenyPatterns ?? []),
    ];

    for (const src of sources) {
      if (src.length > MAX_PATTERN_LENGTH) {
        logger.warn(
          `Skipping deny pattern (exceeds ${MAX_PATTERN_LENGTH} chars): ${src.slice(0, 40)}…`,
        );
        continue;
      }
      try {
        this.compiledDenyPatterns.push(new RegExp(src, "i"));
      } catch {
        logger.warn(`Invalid regex in deny pattern: ${src}`);
      }
    }
  }

  private startWatching(workspacePath: string): void {
    const pattern = new vscode.RelativePattern(
      workspacePath,
      `${CODEBUDDY_DIR}/${CONFIG_FILENAME}`,
    );
    this.configWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    const reload = () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.loadConfig(workspacePath).catch((err) => {
          logger.error(`Failed to reload permissions.json: ${err}`);
        });
      }, 500);
    };

    this.configWatcher.onDidChange(reload);
    this.configWatcher.onDidCreate(reload);
    this.configWatcher.onDidDelete(() => {
      logger.info("permissions.json deleted — reverting to defaults");
      this.config = {};
      this.compiledDenyPatterns = [];

      const settingProfile = vscode.workspace
        .getConfiguration("codebuddy")
        .get<PermissionProfile>("permissionScope.defaultProfile", "standard");
      const old = this.activeProfile;
      this.activeProfile = VALID_PROFILES.includes(settingProfile)
        ? settingProfile
        : "standard";
      if (old !== this.activeProfile) {
        this._onProfileChanged.fire(this.activeProfile);
      }
    });
  }

  // ── Queries ──────────────────────────────────────────────────────

  /** Returns the currently active permission profile. */
  public getActiveProfile(): PermissionProfile {
    return this.activeProfile;
  }

  /**
   * Programmatically switch the active profile (e.g. from a command).
   * Fires the `onProfileChanged` event.
   */
  public setActiveProfile(profile: PermissionProfile): void {
    if (!VALID_PROFILES.includes(profile)) return;
    const old = this.activeProfile;
    this.activeProfile = profile;
    if (old !== this.activeProfile) {
      this._onProfileChanged.fire(this.activeProfile);
      logger.info(`Permission profile changed: ${old} → ${this.activeProfile}`);
    }
  }

  /**
   * Check whether a tool is allowed under the current profile.
   *
   * Evaluation order:
   * 1. Explicit blocklist → always blocked
   * 2. Explicit allowlist → always allowed
   * 3. Profile-based rules (restricted = read-only, standard = no dangerous, trusted = all)
   */
  public isToolAllowed(toolName: string): boolean {
    const name = toolName.toLowerCase();

    // 1. Blocklist always wins
    if (this.config.toolBlocklist?.some((b) => b.toLowerCase() === name)) {
      return false;
    }

    // 2. Allowlist overrides profile restrictions
    if (this.config.toolAllowlist?.some((a) => a.toLowerCase() === name)) {
      return true;
    }

    // 3. Profile-based restrictions
    switch (this.activeProfile) {
      case "restricted":
        // Only explicitly read-only tools
        return READ_ONLY_TOOLS.has(name);

      case "standard":
        // Everything except explicitly dangerous terminal tools
        // (DeepTerminalService handles command-level deny separately)
        return true;

      case "trusted":
        return true;

      default:
        return true;
    }
  }

  /**
   * Check whether a command should be denied by the permission layer.
   * This is evaluated in addition to the existing ExternalSecurityConfig
   * deny patterns — it adds the permission-scope deny list on top.
   *
   * - `restricted`: All terminal commands denied.
   * - `standard`: Built-in + custom deny patterns enforced.
   * - `trusted`: Only custom blocklist patterns enforced (built-in skipped).
   */
  public isCommandDenied(command: string): boolean {
    if (this.activeProfile === "restricted") {
      return true; // No terminal at all in restricted mode
    }

    if (this.activeProfile === "trusted") {
      // Trusted only enforces user-supplied deny patterns
      const customPatterns = this.config.commandDenyPatterns ?? [];
      for (const src of customPatterns) {
        try {
          if (new RegExp(src, "i").test(command)) return true;
        } catch {
          // Skip invalid patterns
        }
      }
      return false;
    }

    // Standard profile: full deny list
    for (const re of this.compiledDenyPatterns) {
      if (re.test(command)) return true;
    }
    return false;
  }

  /**
   * Whether HITL approval should be auto-granted for this profile.
   * Only `trusted` profile auto-approves.
   */
  public shouldAutoApprove(): boolean {
    return this.activeProfile === "trusted";
  }

  /**
   * Filter a list of tools by the active permission profile.
   * Returns only tools allowed under the current scope.
   */
  public filterTools<T extends { name: string }>(tools: T[]): T[] {
    return tools.filter((t) => this.isToolAllowed(t.name));
  }

  /**
   * Returns diagnostics for the current permission configuration.
   * Consumed by the Doctor service.
   */
  public getDiagnostics(): PermissionDiagnostic[] {
    const diags: PermissionDiagnostic[] = [];

    if (!this.workspacePath) {
      diags.push({
        severity: "info",
        message:
          "No workspace open — using VS Code setting for permission profile.",
        code: "no-config",
      });
      return diags;
    }

    const configPath = path.join(
      this.workspacePath,
      CODEBUDDY_DIR,
      CONFIG_FILENAME,
    );
    if (!fs.existsSync(configPath)) {
      diags.push({
        severity: "info",
        message: `No ${CODEBUDDY_DIR}/${CONFIG_FILENAME} found — using default profile "${this.activeProfile}".`,
        code: "no-config",
      });
    } else {
      diags.push({
        severity: "info",
        message: `Loaded permissions config: profile="${this.activeProfile}"`,
        code: "config-loaded",
      });
    }

    // Check for blocklist/allowlist overlap
    const allowSet = new Set(
      (this.config.toolAllowlist ?? []).map((t) => t.toLowerCase()),
    );
    const overlap = (this.config.toolBlocklist ?? []).filter((t) =>
      allowSet.has(t.toLowerCase()),
    );
    if (overlap.length > 0) {
      diags.push({
        severity: "warn",
        message: `Tools in both allowlist and blocklist (blocklist wins): ${overlap.join(", ")}`,
        code: "blocklist-overlap",
      });
    }

    // Check for invalid deny patterns
    for (const src of this.config.commandDenyPatterns ?? []) {
      if (src.length > MAX_PATTERN_LENGTH) {
        diags.push({
          severity: "warn",
          message: `Deny pattern exceeds ${MAX_PATTERN_LENGTH} chars and was skipped.`,
          code: "invalid-regex",
        });
      } else {
        try {
          new RegExp(src);
        } catch {
          diags.push({
            severity: "warn",
            message: `Invalid regex denied pattern: "${src}"`,
            code: "invalid-regex",
          });
        }
      }
    }

    return diags;
  }

  // ── Testing ──────────────────────────────────────────────────────

  /** @internal — for test isolation only. */
  public static _resetForTesting(): void {
    if (process.env.NODE_ENV !== "test") return;
    const inst = PermissionScopeService.instance;
    if (inst) {
      inst.dispose();
    }
    PermissionScopeService.instance = undefined;
  }
}
