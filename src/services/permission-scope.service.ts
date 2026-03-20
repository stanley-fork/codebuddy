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

/** Maximum config file size (64 KB). Prevents memory exhaustion from malicious files. */
const MAX_CONFIG_FILE_BYTES = 64 * 1024;

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
 * Catastrophic / irreversible command patterns — enforced in ALL profiles
 * including `trusted`. These prevent unrecoverable system damage even when
 * the user has opted into full access.
 */
const CATASTROPHIC_DENY_PATTERNS: readonly string[] = [
  String.raw`rm\s+-rf\s+/`,
  String.raw`\bmkfs\b`,
  String.raw`\bdd\s+.*of=/dev/`,
  String.raw`:\(\)\s*\{`, // fork bomb
];

/** Pre-compiled catastrophic patterns — evaluated before any profile logic. */
const COMPILED_CATASTROPHIC_DENY: readonly RegExp[] =
  CATASTROPHIC_DENY_PATTERNS.map((p) => new RegExp(p, "i"));

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
  "open_web_preview",
  "standup_intelligence",
  "team_graph",
]);

// ─── Service ─────────────────────────────────────────────────────────

const logger = Logger.initialize("PermissionScopeService", {
  minLevel: LogLevel.DEBUG,
  enableConsole: true,
  enableFile: true,
  enableTelemetry: false,
});

export class PermissionScopeService implements vscode.Disposable {
  private static instance: PermissionScopeService | undefined;

  private activeProfile: PermissionProfile = "standard";
  private config: PermissionConfig = {};
  /** Built-in + custom deny patterns (for standard profile). */
  private compiledDenyPatterns: RegExp[] = [];
  /** Custom-only deny patterns (for trusted profile). Pre-compiled, no per-call allocation. */
  private compiledTrustedPatterns: RegExp[] = [];
  /** Pre-computed lowercase blocklist for O(1) lookup. */
  private normalizedBlocklist: Set<string> = new Set();
  /** Pre-computed lowercase allowlist for O(1) lookup. */
  private normalizedAllowlist: Set<string> = new Set();
  /** Whether a valid config file was loaded (avoids sync I/O in getDiagnostics). */
  private configLoaded = false;
  private configWatcher: vscode.FileSystemWatcher | undefined;
  private workspacePath: string | undefined;
  /** Guards against concurrent loadConfig calls from debounced reloads. */
  private loadInFlight: Promise<void> | undefined;
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

    logger.info(`Permission scope initialized: profile=${this.activeProfile}`);
  }

  public dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.configWatcher?.dispose();
    this.configWatcher = undefined;
    this._onProfileChanged.dispose();
  }

  // ── Config Loading ───────────────────────────────────────────────

  private async loadConfig(workspacePath: string): Promise<void> {
    // Serialize concurrent reloads — if one is in-flight, join it
    if (this.loadInFlight) {
      await this.loadInFlight;
      return;
    }
    this.loadInFlight = this._loadConfigInner(workspacePath).finally(() => {
      this.loadInFlight = undefined;
    });
    await this.loadInFlight;
  }

  private async _loadConfigInner(workspacePath: string): Promise<void> {
    const resolvedWorkspace = path.resolve(workspacePath);
    const configPath = path.resolve(
      resolvedWorkspace,
      CODEBUDDY_DIR,
      CONFIG_FILENAME,
    );

    // Guard against path traversal
    if (!configPath.startsWith(resolvedWorkspace + path.sep)) {
      logger.warn(
        `Config path escaped workspace root — ignoring: ${configPath}`,
      );
      return;
    }

    try {
      await access(configPath, fs.constants.R_OK);
    } catch {
      logger.debug("No permissions.json found — using defaults");
      this.configLoaded = false;
      return;
    }

    // Guard against oversized files before reading into memory
    try {
      const { size } = await stat(configPath);
      if (size > MAX_CONFIG_FILE_BYTES) {
        logger.warn(
          `permissions.json is ${size} bytes (limit: ${MAX_CONFIG_FILE_BYTES}) — ignoring`,
        );
        this.configLoaded = false;
        return;
      }
    } catch (err) {
      logger.warn(`Cannot stat permissions.json: ${(err as Error).message}`);
      this.configLoaded = false;
      return;
    }

    try {
      const raw = await readFile(configPath, "utf-8");

      // Reset before applying — any failure below leaves us in a clean state
      this.config = {};
      this.configLoaded = false;

      const parsed: unknown = JSON.parse(raw);

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        logger.warn("permissions.json root must be an object — ignoring");
        this.applyConfig();
        return;
      }

      const cfg = parsed as Record<string, unknown>;

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

      // Pre-compute derived lookup structures
      this.applyConfig();
      this.configLoaded = true;

      logger.info(
        `Loaded permissions.json: profile=${this.activeProfile}, ` +
          `denyPatterns=${this.compiledDenyPatterns.length}, ` +
          `allowlist=${this.normalizedAllowlist.size}, ` +
          `blocklist=${this.normalizedBlocklist.size}`,
      );
    } catch (err) {
      logger.warn(
        `Failed to parse permissions.json: ${(err as Error).message}`,
      );
      this.applyConfig(); // ensure lookup sets are consistent with reset config
    }
  }

  /**
   * Pre-compute all derived lookup structures from the current config.
   * Called after config load and on config reset.
   */
  private applyConfig(): void {
    this.normalizedBlocklist = new Set(
      (this.config.toolBlocklist ?? []).map((t) => t.toLowerCase()),
    );
    this.normalizedAllowlist = new Set(
      (this.config.toolAllowlist ?? []).map((t) => t.toLowerCase()),
    );
    this.compileDenyPatterns();
  }

  private compileDenyPatterns(): void {
    this.compiledDenyPatterns = [];
    this.compiledTrustedPatterns = [];

    // Custom patterns → compiled into their own list for trusted profile
    for (const src of this.config.commandDenyPatterns ?? []) {
      if (src.length > MAX_PATTERN_LENGTH) {
        logger.warn(
          `Skipping deny pattern (exceeds ${MAX_PATTERN_LENGTH} chars): ${src.slice(0, 40)}…`,
        );
        continue;
      }
      try {
        this.compiledTrustedPatterns.push(new RegExp(src, "i"));
      } catch {
        logger.warn(`Invalid regex in deny pattern: ${src}`);
      }
    }

    // Standard profile: built-in patterns + custom patterns
    const builtIn: RegExp[] = [];
    for (const src of DANGEROUS_COMMAND_PATTERNS) {
      try {
        builtIn.push(new RegExp(src, "i"));
      } catch {
        logger.warn(`Invalid built-in deny pattern: ${src}`);
      }
    }
    this.compiledDenyPatterns = [...builtIn, ...this.compiledTrustedPatterns];
  }

  private startWatching(workspacePath: string): void {
    // Dispose existing watcher before creating a new one (idempotent)
    if (this.configWatcher) {
      this.configWatcher.dispose();
      this.configWatcher = undefined;
    }

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
      // Cancel any pending reload that might race with the delete
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = undefined;
      }

      logger.info("permissions.json deleted — reverting to defaults");
      this.config = {};
      this.configLoaded = false;
      this.applyConfig();

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
   * Fires the `onProfileChanged` event and persists to workspace settings.
   *
   * @param persist Write to VS Code workspace settings (default true; false for tests).
   */
  public setActiveProfile(profile: PermissionProfile, persist = true): void {
    if (!VALID_PROFILES.includes(profile)) return;
    const old = this.activeProfile;
    this.activeProfile = profile;
    if (old !== this.activeProfile) {
      this._onProfileChanged.fire(this.activeProfile);
      logger.info(`Permission profile changed: ${old} → ${this.activeProfile}`);

      if (persist) {
        vscode.workspace
          .getConfiguration("codebuddy")
          .update(
            "permissionScope.defaultProfile",
            profile,
            vscode.ConfigurationTarget.Workspace,
          )
          .then(undefined, (err) =>
            logger.warn(`Could not persist profile setting: ${err}`),
          );
      }
    }
  }

  /**
   * Check whether a tool is allowed under the current profile.
   *
   * Evaluation order:
   * 1. Explicit blocklist → always blocked  (O(1) Set lookup)
   * 2. Explicit allowlist → always allowed   (O(1) Set lookup)
   * 3. Profile-based rules (restricted = read-only, standard/trusted = all)
   */
  public isToolAllowed(toolName: string): boolean {
    const name = toolName.toLowerCase();

    // 1. Blocklist always wins
    if (this.normalizedBlocklist.has(name)) return false;

    // 2. Allowlist overrides profile restrictions
    if (this.normalizedAllowlist.has(name)) return true;

    // 3. Profile-based restrictions
    switch (this.activeProfile) {
      case "restricted":
        return READ_ONLY_TOOLS.has(name);

      case "standard":
      case "trusted":
      default:
        return true;
    }
  }

  /**
   * Check whether a command should be denied by the permission layer.
   * Uses pre-compiled patterns — no per-call RegExp allocation.
   *
   * Catastrophic patterns (rm -rf /, mkfs, dd of=/dev, fork bomb) are
   * enforced in ALL profiles including `trusted` as an irreversible-damage
   * safety floor.
   *
   * - `restricted`: All terminal commands denied.
   * - `standard`: Built-in + custom deny patterns enforced.
   * - `trusted`: Catastrophic patterns + custom deny patterns enforced.
   */
  public isCommandDenied(command: string): boolean {
    // Safety floor: catastrophic patterns always enforced regardless of profile
    if (COMPILED_CATASTROPHIC_DENY.some((re) => re.test(command))) return true;

    switch (this.activeProfile) {
      case "restricted":
        return true;

      case "trusted":
        return this.compiledTrustedPatterns.some((re) => re.test(command));

      case "standard":
      default:
        return this.compiledDenyPatterns.some((re) => re.test(command));
    }
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
   * Consumed by the Doctor service. Uses cached state — no sync I/O.
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

    if (!this.configLoaded) {
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
    const overlap = [...this.normalizedBlocklist].filter((t) =>
      this.normalizedAllowlist.has(t),
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
