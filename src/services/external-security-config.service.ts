import * as fs from "fs";
import { readFile, access, stat, mkdir, writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../infrastructure/logger/logger";
import { ISecurityPolicy } from "./security-policy.interface";

// ─── Types ───────────────────────────────────────────────────────────

export interface SecurityDiagnostic {
  severity: "info" | "warn" | "critical";
  message: string;
  autoFixable: boolean;
  /** Semantic code for programmatic matching (avoids brittle string checks). */
  code?:
    | "no-config"
    | "config-loaded"
    | "config-permissions"
    | "custom-deny-patterns"
    | "network-allowlist"
    | "external-paths"
    | "invalid-regex";
}

// ─── Schema ──────────────────────────────────────────────────────────

/**
 * Top-level shape of `.codebuddy/security.json`.
 * Lives inside the workspace `.codebuddy/` directory alongside other
 * workspace-scoped configuration (rules, skills, permissions).
 */
export interface ExternalSecurityConfig {
  /** Directories the agent is allowed to access outside the workspace. */
  allowedPaths?: AllowedPath[];
  /** Extra regex patterns that the terminal tool must reject (merged with defaults). */
  commandDenyPatterns?: string[];
  /** URL patterns the agent may fetch. If present, only matching URLs are allowed. */
  networkAllowPatterns?: string[];
  /** URL patterns the agent must never fetch (evaluated before allow). */
  networkDenyPatterns?: string[];
  /** Sensitive path components that are always blocked from directory reads. */
  blockedPathPatterns?: string[];
}

export interface AllowedPath {
  /** Absolute or `~`-relative path. */
  path: string;
  /** `true` = read-write, `false` = read-only. Defaults to `false`. */
  allowReadWrite?: boolean;
  /** Human-readable note. */
  description?: string;
}

// ─── Defaults ────────────────────────────────────────────────────────

const CONFIG_FILENAME = "security.json";
const CODEBUDDY_DIR = ".codebuddy";

/**
 * Hardcoded blocked path components — always merged with user config.
 * These patterns match against individual path segments (not the full
 * path string) to prevent accidental reads of credentials and secrets.
 */
const DEFAULT_BLOCKED_PATH_PATTERNS: readonly string[] = [
  // Cloud credentials
  ".ssh",
  ".gnupg",
  ".gpg",
  ".aws",
  ".azure",
  ".gcloud",
  ".kube",
  ".docker",
  // Auth & token files
  "credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  // Private keys
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "private_key",
  ".secret",
  // Environment variable files (common credential leakage vector)
  ".env",
  ".env.local",
  ".env.production",
  ".env.staging",
  ".env.development",
  // Token / password stores
  ".token",
  ".htpasswd",
];

/**
 * Hardcoded command deny patterns that are always compiled and enforced
 * on top of any user-supplied patterns. These mirror the most critical
 * entries from `DEFAULT_BLOCKED_PATTERNS` in deep-terminal.service.ts
 * but are maintained here as regex *source strings* so that external
 * config can extend the set uniformly.
 */
const DEFAULT_COMMAND_DENY_PATTERNS: readonly string[] = [
  // Fork bomb
  String.raw`:\(\)\s*\{[^}]*:\s*\|\s*:\s*\}`,
  // Remote code execution via curl/wget pipe
  String.raw`\b(curl|wget)\b.*\|\s*(ba)?sh`,
  String.raw`\b(curl|wget)\b.*\|\s*python`,
  // Disk destruction
  String.raw`\bmkfs\b`,
  String.raw`\bdd\s+.*\bof=\/dev\/`,
];

const DEFAULT_NETWORK_DENY_PATTERNS: readonly string[] = [
  // Block metadata endpoints (cloud SSRF)
  String.raw`^https?://169\.254\.169\.254`,
  String.raw`^https?://metadata\.google\.internal`,
  // Block localhost-range with credentials (unless explicitly allowed)
  String.raw`^https?://0\.0\.0\.0`,
];

// ─── Service ─────────────────────────────────────────────────────────

export class ExternalSecurityConfigService
  implements vscode.Disposable, ISecurityPolicy
{
  private static instance: ExternalSecurityConfigService;
  private readonly logger: Logger;

  /** Maximum number of user-supplied patterns per category. */
  private static readonly MAX_USER_PATTERNS = 50;
  /** Maximum input length for regex testing (ReDoS mitigation). */
  private static readonly MAX_INPUT_LENGTH = 10_000;

  private config: ExternalSecurityConfig = {};
  private compiledCommandDenyPatterns: RegExp[] = [];
  private compiledNetworkAllowPatterns: RegExp[] = [];
  private compiledNetworkDenyPatterns: RegExp[] = [];
  private compiledPathBlockPatterns: RegExp[] = [];
  private mergedBlockedPathPatterns: Set<string> = new Set(
    DEFAULT_BLOCKED_PATH_PATTERNS,
  );
  private invalidPatterns: Array<{
    category: string;
    pattern: string;
    error: string;
  }> = [];
  private configFileExists = false;
  private loadConfigPromise: Promise<void> | null = null;

  private configDir = "";
  private configFile = "";
  private workspaceRoot = "";
  private vsCodeWatcher: vscode.FileSystemWatcher | undefined;
  private reloadDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor() {
    this.logger = Logger.initialize("ExternalSecurityConfigService", {
      minLevel: LogLevel.DEBUG,
      enableConsole: true,
      enableFile: true,
      enableTelemetry: true,
    });
  }

  // ── Singleton ────────────────────────────────────────────────────

  public static getInstance(): ExternalSecurityConfigService {
    if (!ExternalSecurityConfigService.instance) {
      ExternalSecurityConfigService.instance =
        new ExternalSecurityConfigService();
    }
    return ExternalSecurityConfigService.instance;
  }

  /** @internal – for test isolation. Clear reference before dispose to prevent re-entrant getInstance(). */
  public static resetInstance(): void {
    const inst = ExternalSecurityConfigService.instance;
    ExternalSecurityConfigService.instance =
      undefined as unknown as ExternalSecurityConfigService;
    inst?.dispose();
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Loads the config from disk and starts a file-system watcher so
   * edits are picked up without restarting VS Code.
   *
   * @param workspacePath — root of the active workspace. When omitted the
   *   service falls back to the first open workspace folder.
   */
  public async initialize(workspacePath?: string): Promise<void> {
    const root =
      workspacePath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (root) {
      this.configDir = path.join(root, CODEBUDDY_DIR);
      this.configFile = path.join(this.configDir, CONFIG_FILENAME);
      this.workspaceRoot = root;
    } else {
      this.logger.warn(
        "No workspace folder available — security config will use defaults only",
      );
    }

    await this.loadConfig();
    this.startWatcher();

    let fileExists = false;
    if (this.configFile) {
      try {
        await access(this.configFile, fs.constants.R_OK);
        fileExists = true;
      } catch {
        // Auto-scaffold security.json on first use
        const created = await this.scaffoldDefaultConfig();
        if (created) {
          fileExists = true;
          this.logger.info(
            "Auto-created default security config at " + this.configFile,
          );
        }
      }
    }
    this.logger.info(
      `Security config initialised (file exists: ${fileExists})`,
    );
  }

  public dispose(): void {
    clearTimeout(this.reloadDebounceTimer);
    this.vsCodeWatcher?.dispose();
    this.vsCodeWatcher = undefined;
  }

  // ── Config loading ───────────────────────────────────────────────

  /** Serialize concurrent calls to prevent torn state. */
  private loadConfig(): Promise<void> {
    this.loadConfigPromise = (this.loadConfigPromise ?? Promise.resolve())
      .then(() => this._loadConfigInternal())
      .catch((err) => {
        this.logger.error(`loadConfig chain error: ${err}`);
      });
    return this.loadConfigPromise;
  }

  private async _loadConfigInternal(): Promise<void> {
    if (!this.configFile) {
      this.config = {};
      this.configFileExists = false;
      this.compilePatterns();
      return;
    }

    // Use async I/O to avoid blocking the extension host
    try {
      await access(this.configFile, fs.constants.R_OK);
    } catch {
      this.config = {};
      this.configFileExists = false;
      this.compilePatterns();
      return;
    }

    try {
      const raw = await readFile(this.configFile, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!this.isValidConfig(parsed)) {
        this.logger.warn(
          "External security config has invalid structure — falling back to defaults",
        );
        this.config = {};
      } else {
        this.config = parsed;
      }
      this.configFileExists = true;
    } catch (err) {
      this.logger.error(
        `Failed to load external security config: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.config = {};
      this.configFileExists = false;
    }

    this.compilePatterns();
  }

  /**
   * Minimal structural validation (not a full JSON-schema check, but
   * enough to reject garbage).
   */
  private isValidConfig(value: unknown): value is ExternalSecurityConfig {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const obj = value as Record<string, unknown>;

    // Each optional array field must be an array if present
    for (const key of [
      "commandDenyPatterns",
      "networkAllowPatterns",
      "networkDenyPatterns",
      "blockedPathPatterns",
    ]) {
      if (key in obj && !Array.isArray(obj[key])) {
        return false;
      }
    }
    if ("allowedPaths" in obj) {
      if (!Array.isArray(obj.allowedPaths)) return false;
      for (const entry of obj.allowedPaths as unknown[]) {
        if (
          typeof entry !== "object" ||
          entry === null ||
          typeof (entry as Record<string, unknown>).path !== "string"
        ) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Pre-compile all regex patterns so hot-path checks are fast.
   * User patterns with invalid regex syntax are silently dropped
   * (logged as warnings) so a typo doesn't disable security.
   */
  private compilePatterns(): void {
    const limit = ExternalSecurityConfigService.MAX_USER_PATTERNS;
    this.invalidPatterns = [];

    const userCommandPatterns = this.truncatePatterns(
      this.config.commandDenyPatterns,
      limit,
      "commandDenyPatterns",
    );
    this.compiledCommandDenyPatterns = this.compileRegexArray(
      [...DEFAULT_COMMAND_DENY_PATTERNS, ...userCommandPatterns],
      "commandDenyPatterns",
      "", // case-SENSITIVE for shell commands
    );

    const userNetworkAllow = this.truncatePatterns(
      this.config.networkAllowPatterns,
      limit,
      "networkAllowPatterns",
    );
    this.compiledNetworkAllowPatterns = this.compileRegexArray(
      userNetworkAllow,
      "networkAllowPatterns",
      "i", // case-insensitive for URLs
    );

    const userNetworkDeny = this.truncatePatterns(
      this.config.networkDenyPatterns,
      limit,
      "networkDenyPatterns",
    );
    this.compiledNetworkDenyPatterns = this.compileRegexArray(
      [...DEFAULT_NETWORK_DENY_PATTERNS, ...userNetworkDeny],
      "networkDenyPatterns",
      "i", // case-insensitive for URLs
    );

    // Merge blocked path patterns (exact segment matches)
    this.mergedBlockedPathPatterns = new Set([
      ...DEFAULT_BLOCKED_PATH_PATTERNS,
      ...(this.config.blockedPathPatterns?.slice(0, limit) ?? []),
    ]);

    // Compile user-supplied blocked path patterns as regex for flexible matching
    this.compiledPathBlockPatterns = this.compileRegexArray(
      this.config.blockedPathPatterns?.slice(0, limit) ?? [],
      "blockedPathPatterns",
    );
  }

  private truncatePatterns(
    patterns: string[] | undefined,
    limit: number,
    name: string,
  ): string[] {
    if (!patterns) return [];
    if (patterns.length > limit) {
      this.logger.warn(`${name} exceeds limit of ${limit}; truncated`);
      return patterns.slice(0, limit);
    }
    return patterns;
  }

  private compileRegexArray(
    sources: readonly string[],
    category: string = "unknown",
    flags: string = "i",
  ): RegExp[] {
    const MAX_PATTERN_LENGTH = 200;
    const result: RegExp[] = [];
    for (const src of sources) {
      if (src.length > MAX_PATTERN_LENGTH) {
        this.logger.warn(
          `Regex in ${category} exceeds ${MAX_PATTERN_LENGTH} chars, skipped: ${src.slice(0, 40)}…`,
        );
        this.invalidPatterns.push({
          category,
          pattern: src.slice(0, 40) + "…",
          error: `Pattern exceeds ${MAX_PATTERN_LENGTH} character limit`,
        });
        continue;
      }
      try {
        result.push(new RegExp(src, flags));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Invalid regex in ${category}, skipped: ${src} — ${message}`,
        );
        this.invalidPatterns.push({ category, pattern: src, error: message });
      }
    }
    return result;
  }

  // ── File watcher ─────────────────────────────────────────────────

  private startWatcher(): void {
    if (!this.configDir) {
      return;
    }

    try {
      // Watch the parent workspace for directory creation
      // (covers the case where .codebuddy/ is created after initialization)
      const pattern = new vscode.RelativePattern(
        this.workspaceRoot || this.configDir,
        `${CODEBUDDY_DIR}/${CONFIG_FILENAME}`,
      );
      this.vsCodeWatcher = vscode.workspace.createFileSystemWatcher(pattern);

      const scheduleReload = (event: string) => {
        clearTimeout(this.reloadDebounceTimer);
        this.reloadDebounceTimer = setTimeout(() => {
          this.logger.info(`Security config ${event} — reloading`);
          this.loadConfig().catch((err) => {
            this.logger.error(`Reload failed: ${err}`);
          });
        }, 300);
      };

      this.vsCodeWatcher.onDidChange(() => scheduleReload("changed"));
      this.vsCodeWatcher.onDidCreate(() => scheduleReload("created"));
      this.vsCodeWatcher.onDidDelete(() => {
        clearTimeout(this.reloadDebounceTimer);
        this.logger.warn("Security config deleted — reverting to defaults");
        this.config = {};
        this.configFileExists = false;
        this.compilePatterns();
      });
    } catch (err) {
      this.logger.warn(
        `Could not start file watcher for security config: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Public query API ─────────────────────────────────────────────

  /**
   * Returns `true` if the command should be blocked.
   * @param command — Pre-normalized command string from the caller.
   *   Applies only minimal safety trimming — callers own normalization.
   */
  public isCommandBlocked(command: string): boolean {
    const input = command.trim();
    return this.compiledCommandDenyPatterns.some((rx) =>
      this.safeTest(rx, input),
    );
  }

  /** Returns the extra deny patterns (frozen copy — callers cannot mutate). */
  public getCommandDenyPatterns(): readonly RegExp[] {
    return Object.freeze([...this.compiledCommandDenyPatterns]);
  }

  /** Returns only the user-defined custom deny patterns (excludes built-in defaults). */
  public getCustomCommandDenyPatterns(): readonly RegExp[] {
    const customStartIndex = DEFAULT_COMMAND_DENY_PATTERNS.length;
    return Object.freeze(
      this.compiledCommandDenyPatterns.slice(customStartIndex),
    );
  }

  /**
   * Returns `true` if the URL is allowed.
   * - If no `networkAllowPatterns` are configured, all URLs are allowed
   *   (except those matching `networkDenyPatterns`).
   * - If `networkAllowPatterns` are configured, the URL must match at
   *   least one of them *and* must not match any deny pattern.
   *
   * Deny patterns are always evaluated first (deny wins).
   */
  public isUrlAllowed(url: string): boolean {
    // Deny always wins
    if (this.compiledNetworkDenyPatterns.some((rx) => this.safeTest(rx, url))) {
      return false;
    }
    // If no allow list, everything (not denied) is allowed
    if (this.compiledNetworkAllowPatterns.length === 0) {
      return true;
    }
    return this.compiledNetworkAllowPatterns.some((rx) =>
      this.safeTest(rx, url),
    );
  }

  /**
   * Returns `true` if the given filesystem path looks like it touches
   * a sensitive location (e.g. `.ssh/`, `.aws/`, credential files).
   * Uses both exact segment matching and full-path substring checks
   * to prevent bypass via near-matching directory names.
   */
  public isPathBlocked(filePath: string): boolean {
    const expanded = this.expandPath(filePath);
    // Normalize to forward slashes for consistent matching
    const normalized = expanded.split(path.sep).join("/");
    const segments = normalized.split("/");

    for (const pattern of this.mergedBlockedPathPatterns) {
      // 1. Exact segment match (original behavior — fastest)
      if (segments.some((seg) => seg === pattern)) {
        return true;
      }
      // 2. Pattern appears as a path component (catches near-matches)
      if (
        normalized.includes(`/${pattern}/`) ||
        normalized.endsWith(`/${pattern}`)
      ) {
        return true;
      }
    }

    // 3. User-supplied regex patterns for flexible path blocking
    if (
      this.compiledPathBlockPatterns.some((rx) => this.safeTest(rx, normalized))
    ) {
      return true;
    }

    return false;
  }

  /**
   * Checks whether an *external* path (outside the workspace) is
   * explicitly allowed by the security config.
   *
   * @returns `{ allowed: true, readWrite }` or `{ allowed: false }`.
   */
  public isExternalPathAllowed(filePath: string): {
    allowed: boolean;
    readWrite: boolean;
  } {
    // Reject null bytes — defense against filesystem exploits
    if (filePath.includes("\0")) {
      this.logger.warn(
        `Null byte in path rejected: ${JSON.stringify(filePath)}`,
      );
      return { allowed: false, readWrite: false };
    }

    if (!this.config.allowedPaths || this.config.allowedPaths.length === 0) {
      return { allowed: false, readWrite: false };
    }

    const resolved = this.resolvePath(filePath);

    for (const entry of this.config.allowedPaths) {
      const allowedRoot = this.resolvePath(entry.path);
      const relative = path.relative(allowedRoot, resolved);

      // path.relative returns ".." prefix for paths outside allowedRoot
      // path.isAbsolute catches edge cases on Windows where relative might be absolute
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        // Re-verify via real path resolution to catch symlink escapes
        try {
          const allowedRootReal = fs.realpathSync.native(allowedRoot);
          if (
            resolved === allowedRootReal ||
            resolved.startsWith(allowedRootReal + path.sep)
          ) {
            return { allowed: true, readWrite: entry.allowReadWrite ?? false };
          }
        } catch {
          // allowedRoot doesn't exist — trust path.relative check only
          return { allowed: true, readWrite: entry.allowReadWrite ?? false };
        }
      }
    }

    return { allowed: false, readWrite: false };
  }

  /** Returns `true` if a config file exists and is readable (cached from last load). */
  public hasConfig(): boolean {
    return this.configFileExists;
  }

  /** Returns a diagnostic summary for the Doctor command. */
  public async getDiagnostics(): Promise<SecurityDiagnostic[]> {
    const diagnostics: SecurityDiagnostic[] = [];

    let configExists = false;
    if (this.configFile) {
      try {
        await access(this.configFile, fs.constants.R_OK);
        configExists = true;
      } catch {
        // file doesn't exist or not readable
      }
    }

    if (!configExists) {
      diagnostics.push({
        severity: "info",
        message:
          "No security config found. Create .codebuddy/security.json for workspace security policies.",
        autoFixable: true,
        code: "no-config",
      });
    } else {
      diagnostics.push({
        severity: "info",
        message: `Security config loaded from ${this.configFile}`,
        autoFixable: false,
        code: "config-loaded",
      });

      // Check permissions on the config file (async)
      try {
        const fileStat = await stat(this.configFile);
        const mode = fileStat.mode & 0o777;
        if (mode & 0o022) {
          diagnostics.push({
            severity: "warn",
            message: `Security config is writable by group/others (mode: ${mode.toString(8)}). Consider: chmod 600 ${this.configFile}`,
            autoFixable: true,
          });
        }
      } catch {
        // stat failed — skip permission check
      }

      const denyCount =
        this.compiledCommandDenyPatterns.length -
        DEFAULT_COMMAND_DENY_PATTERNS.length;
      if (denyCount > 0) {
        diagnostics.push({
          severity: "info",
          message: `${denyCount} custom command deny pattern(s) loaded`,
          autoFixable: false,
        });
      }

      if (this.compiledNetworkAllowPatterns.length > 0) {
        diagnostics.push({
          severity: "info",
          message: `Network allowlist active with ${this.compiledNetworkAllowPatterns.length} pattern(s)`,
          autoFixable: false,
        });
      }

      if ((this.config.allowedPaths?.length ?? 0) > 0) {
        diagnostics.push({
          severity: "info",
          message: `${this.config.allowedPaths!.length} external path(s) allowed`,
          autoFixable: false,
        });
      }
    }

    // Surface invalid regex patterns (#8)
    for (const inv of this.invalidPatterns) {
      diagnostics.push({
        severity: "warn",
        message: `Invalid regex in ${inv.category}, pattern skipped: "${inv.pattern}" — ${inv.error}`,
        autoFixable: false,
      });
    }

    return diagnostics;
  }

  /**
   * Creates a default security config if one doesn't already exist.
   * Returns `true` if a new file was created.
   */
  public async scaffoldDefaultConfig(): Promise<boolean> {
    if (!this.configFile) {
      this.logger.warn("Cannot scaffold security config — no workspace folder");
      return false;
    }

    // Async existence check
    try {
      await access(this.configFile, fs.constants.F_OK);
      return false; // Already exists
    } catch {
      // Does not exist — proceed
    }

    const defaultConfig = {
      $schema:
        "https://raw.githubusercontent.com/olasunkanmi-SE/codebuddy/main/schemas/security-config-v1.json",
      version: 1,
      allowedPaths: [
        {
          path: this.workspaceRoot,
          allowReadWrite: true,
          description: path.basename(this.workspaceRoot),
        },
      ],
      commandDenyPatterns: [] as string[],
      networkAllowPatterns: [] as string[],
      networkDenyPatterns: [] as string[],
      blockedPathPatterns: [] as string[],
    };

    await mkdir(this.configDir, { recursive: true });
    await writeFile(
      this.configFile,
      JSON.stringify(defaultConfig, null, 2) + "\n",
      { encoding: "utf-8", mode: 0o600 },
    );

    // Reload after creation
    await this.loadConfig();
    return true;
  }

  /** Returns the raw loaded config (for display in Doctor/UI). */
  public getConfig(): Readonly<ExternalSecurityConfig> {
    return { ...this.config };
  }

  /** Returns the path to the config file, or `undefined` if no workspace. */
  public getConfigPath(): string | undefined {
    return this.configFile || undefined;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /**
   * Tests a regex against input with ReDoS mitigation: rejects
   * oversized inputs and resets lastIndex for global/sticky regexes.
   */
  private safeTest(rx: RegExp, input: string): boolean {
    if (input.length > ExternalSecurityConfigService.MAX_INPUT_LENGTH) {
      this.logger.warn(
        `Input too long for regex test (${input.length} chars), skipping`,
      );
      return false;
    }
    try {
      rx.lastIndex = 0;
      return rx.test(input);
    } catch {
      return false;
    }
  }

  private expandPath(p: string): string {
    if (p.startsWith("~")) {
      return path.join(os.homedir(), p.slice(1));
    }
    return p;
  }

  /**
   * Resolves a path canonically, following all symlinks.
   * For non-existent paths, resolves the deepest existing ancestor
   * and appends the remaining segments — prevents symlink escape.
   */
  private resolvePath(p: string): string {
    const expanded = this.expandPath(p);
    try {
      return fs.realpathSync.native(expanded);
    } catch {
      // File doesn't exist yet — resolve the deepest existing ancestor
      const parts = expanded.split(path.sep);
      for (let i = parts.length - 1; i > 0; i--) {
        const partial = parts.slice(0, i).join(path.sep);
        try {
          const real = fs.realpathSync.native(partial);
          return path.join(real, ...parts.slice(i));
        } catch {
          continue;
        }
      }
      return path.resolve(expanded);
    }
  }
}
