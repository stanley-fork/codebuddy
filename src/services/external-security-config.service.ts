import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../infrastructure/logger/logger";

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
  ".ssh",
  ".gnupg",
  ".gpg",
  ".aws",
  ".azure",
  ".gcloud",
  ".kube",
  ".docker",
  "credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
  "private_key",
  ".secret",
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

export class ExternalSecurityConfigService implements vscode.Disposable {
  private static instance: ExternalSecurityConfigService;
  private readonly logger: Logger;

  private config: ExternalSecurityConfig = {};
  private compiledCommandDenyPatterns: RegExp[] = [];
  private compiledNetworkAllowPatterns: RegExp[] = [];
  private compiledNetworkDenyPatterns: RegExp[] = [];
  private mergedBlockedPathPatterns: Set<string> = new Set(
    DEFAULT_BLOCKED_PATH_PATTERNS,
  );

  private configDir = "";
  private configFile = "";
  private workspaceRoot = "";
  private watcher: fs.FSWatcher | undefined;

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

  /** @internal – for test isolation */
  public static resetInstance(): void {
    ExternalSecurityConfigService.instance?.dispose();
    ExternalSecurityConfigService.instance =
      undefined as unknown as ExternalSecurityConfigService;
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

    // Auto-create security.json if it doesn't exist
    await this.scaffoldDefaultConfig();

    await this.loadConfig();
    this.startWatcher();
    this.logger.info(
      `Security config initialised (file exists: ${this.configFile ? fs.existsSync(this.configFile) : false})`,
    );
  }

  public dispose(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  // ── Config loading ───────────────────────────────────────────────

  private async loadConfig(): Promise<void> {
    if (!this.configFile || !fs.existsSync(this.configFile)) {
      this.config = {};
      this.compilePatterns();
      return;
    }

    try {
      const raw = fs.readFileSync(this.configFile, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!this.isValidConfig(parsed)) {
        this.logger.warn(
          "External security config has invalid structure — falling back to defaults",
        );
        this.config = {};
      } else {
        this.config = parsed;
      }
    } catch (err) {
      this.logger.error(
        `Failed to load external security config: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.config = {};
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
    this.compiledCommandDenyPatterns = this.compileRegexArray([
      ...DEFAULT_COMMAND_DENY_PATTERNS,
      ...(this.config.commandDenyPatterns ?? []),
    ]);

    this.compiledNetworkAllowPatterns = this.compileRegexArray(
      this.config.networkAllowPatterns ?? [],
    );

    this.compiledNetworkDenyPatterns = this.compileRegexArray([
      ...DEFAULT_NETWORK_DENY_PATTERNS,
      ...(this.config.networkDenyPatterns ?? []),
    ]);

    // Merge blocked path patterns
    this.mergedBlockedPathPatterns = new Set([
      ...DEFAULT_BLOCKED_PATH_PATTERNS,
      ...(this.config.blockedPathPatterns ?? []),
    ]);
  }

  private compileRegexArray(sources: string[]): RegExp[] {
    const result: RegExp[] = [];
    for (const src of sources) {
      try {
        result.push(new RegExp(src, "i"));
      } catch {
        this.logger.warn(`Invalid regex in security config, skipped: ${src}`);
      }
    }
    return result;
  }

  // ── File watcher ─────────────────────────────────────────────────

  private startWatcher(): void {
    // Watch the directory (not the file) so we catch creation and renames too.
    if (!this.configDir || !fs.existsSync(this.configDir)) {
      return; // No config dir — nothing to watch
    }

    try {
      this.watcher = fs.watch(this.configDir, (_event, filename) => {
        if (filename === CONFIG_FILENAME) {
          this.logger.info("External security config changed — reloading");
          this.loadConfig().catch((err) => {
            this.logger.error(`Reload failed: ${err}`);
          });
        }
      });
    } catch {
      this.logger.warn("Could not start file watcher for security config");
    }
  }

  // ── Public query API ─────────────────────────────────────────────

  /** Returns `true` if the command should be blocked. */
  public isCommandBlocked(command: string): boolean {
    const normalised = command.trim().toLowerCase();
    return this.compiledCommandDenyPatterns.some((rx) => rx.test(normalised));
  }

  /** Returns the extra deny patterns so callers can merge them. */
  public getCommandDenyPatterns(): readonly RegExp[] {
    return this.compiledCommandDenyPatterns;
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
    if (this.compiledNetworkDenyPatterns.some((rx) => rx.test(url))) {
      return false;
    }
    // If no allow list, everything (not denied) is allowed
    if (this.compiledNetworkAllowPatterns.length === 0) {
      return true;
    }
    return this.compiledNetworkAllowPatterns.some((rx) => rx.test(url));
  }

  /**
   * Returns `true` if the given filesystem path looks like it touches
   * a sensitive location (e.g. `.ssh/`, `.aws/`, credential files).
   */
  public isPathBlocked(filePath: string): boolean {
    const expanded = this.expandPath(filePath);
    const segments = expanded.split(path.sep);
    return segments.some((seg) => this.mergedBlockedPathPatterns.has(seg));
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
    if (!this.config.allowedPaths || this.config.allowedPaths.length === 0) {
      return { allowed: false, readWrite: false };
    }

    const resolved = this.resolvePath(filePath);

    for (const entry of this.config.allowedPaths) {
      const allowedRoot = this.resolvePath(entry.path);
      if (
        resolved === allowedRoot ||
        resolved.startsWith(allowedRoot + path.sep)
      ) {
        return { allowed: true, readWrite: entry.allowReadWrite ?? false };
      }
    }

    return { allowed: false, readWrite: false };
  }

  /** Returns a diagnostic summary for the Doctor command. */
  public getDiagnostics(): SecurityDiagnostic[] {
    const diagnostics: SecurityDiagnostic[] = [];

    if (!this.configFile || !fs.existsSync(this.configFile)) {
      diagnostics.push({
        severity: "info",
        message:
          "No security config found. Create .codebuddy/security.json for workspace security policies.",
        autoFixable: true,
      });
    } else {
      diagnostics.push({
        severity: "info",
        message: `Security config loaded from ${this.configFile}`,
        autoFixable: false,
      });

      // Check permissions on the config file
      try {
        const stat = fs.statSync(this.configFile);
        const mode = stat.mode & 0o777;
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
    if (fs.existsSync(this.configFile)) {
      return false;
    }

    const defaultConfig: ExternalSecurityConfig = {
      allowedPaths: [
        {
          path: this.workspaceRoot,
          allowReadWrite: true,
          description: path.basename(this.workspaceRoot),
        },
      ],
      commandDenyPatterns: [],
      networkAllowPatterns: [],
      networkDenyPatterns: [],
      blockedPathPatterns: [],
    };

    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(
      this.configFile,
      JSON.stringify(defaultConfig, null, 2) + "\n",
      { encoding: "utf-8", mode: 0o600 },
    );

    // Reload after creation
    await this.loadConfig();
    this.startWatcher();
    return true;
  }

  /** Returns the raw loaded config (for display in Doctor/UI). */
  public getConfig(): Readonly<ExternalSecurityConfig> {
    return { ...this.config };
  }

  /** Returns the path to the config file. */
  public getConfigPath(): string {
    return this.configFile;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private expandPath(p: string): string {
    if (p.startsWith("~")) {
      return path.join(os.homedir(), p.slice(1));
    }
    return p;
  }

  private resolvePath(p: string): string {
    const expanded = this.expandPath(p);
    try {
      return fs.realpathSync(expanded);
    } catch {
      return path.resolve(expanded);
    }
  }
}

// ─── Types ───────────────────────────────────────────────────────────

export interface SecurityDiagnostic {
  severity: "info" | "warn" | "critical";
  message: string;
  autoFixable: boolean;
}
