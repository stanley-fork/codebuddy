import { readFile, stat } from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { execFile } from "child_process";
import { Logger, LogLevel } from "../infrastructure/logger/logger";

// ─── Types ───────────────────────────────────────────────────────────

/**
 * Access control mode.
 *
 * - `open`: No restrictions — all users have full agent access.
 * - `allow`: Only users in the allowlist may use the agent.
 * - `deny`: Users in the denylist are blocked; everyone else is allowed.
 */
export type AccessControlMode = "open" | "allow" | "deny";

/**
 * Shape of `.codebuddy/access.json`.
 */
export interface AccessControlConfig {
  /** Access control mode. Defaults to `open`. */
  mode?: AccessControlMode;
  /**
   * User identifiers (emails or GitHub usernames) for the allowlist
   * (when mode=`allow`) or denylist (when mode=`deny`).
   */
  users?: string[];
  /**
   * Users with admin privileges — can bypass restrictions and
   * perform sensitive operations without escalation prompts.
   */
  admins?: string[];
  /** Whether to log denied access attempts. Defaults to true. */
  logDenied?: boolean;
}

export interface AccessAuditEntry {
  timestamp: number;
  user: string;
  action: string;
  allowed: boolean;
}

export interface AccessDiagnostic {
  severity: "info" | "warn" | "critical";
  message: string;
  code?:
    | "no-config"
    | "config-loaded"
    | "no-user-identity"
    | "empty-user-list"
    | "user-denied"
    | "user-allowed";
}

// ─── Constants ───────────────────────────────────────────────────────

const CONFIG_FILENAME = "access.json";
const CODEBUDDY_DIR = ".codebuddy";
const VALID_MODES: readonly AccessControlMode[] = ["open", "allow", "deny"];

/** Maximum config file size (64 KB). */
const MAX_CONFIG_FILE_BYTES = 64 * 1024;

/** Maximum audit log entries kept in memory. */
const MAX_AUDIT_ENTRIES = 500;

/** Maximum number of users in allow/deny list. */
const MAX_USERS = 200;

// ─── Service ─────────────────────────────────────────────────────────

const logger = Logger.initialize("AccessControlService", {
  minLevel: LogLevel.DEBUG,
  enableConsole: true,
  enableFile: true,
  enableTelemetry: false,
});

export class AccessControlService implements vscode.Disposable {
  private static instance: AccessControlService | undefined;

  private mode: AccessControlMode = "open";
  private config: AccessControlConfig = {};
  /** Normalized user list (lowercase) for O(1) lookups. */
  private normalizedUsers: Set<string> = new Set();
  /** Normalized admin list (lowercase) for O(1) lookups. */
  private normalizedAdmins: Set<string> = new Set();
  private logDenied = true;
  private configLoaded = false;
  private configWatcher: vscode.FileSystemWatcher | undefined;
  private workspacePath: string | undefined;
  private loadInFlight: Promise<void> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  /** Cached current user identity. */
  private currentUser: string | undefined;
  /** In-memory audit log (bounded). */
  private auditLog: AccessAuditEntry[] = [];

  /** Event fired when the access mode or user list changes. */
  private readonly _onAccessChanged =
    new vscode.EventEmitter<AccessControlMode>();
  public readonly onAccessChanged = this._onAccessChanged.event;

  private constructor() {}

  public static getInstance(): AccessControlService {
    if (!AccessControlService.instance) {
      AccessControlService.instance = new AccessControlService();
    }
    return AccessControlService.instance;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Load `.codebuddy/access.json` from the workspace (if present),
   * resolve the current user identity, and start file watching.
   */
  public async initialize(workspacePath?: string): Promise<void> {
    this.workspacePath = workspacePath;

    // Read VS Code setting for default mode
    const settingMode = vscode.workspace
      .getConfiguration("codebuddy")
      .get<AccessControlMode>("accessControl.defaultMode", "open");

    if (VALID_MODES.includes(settingMode)) {
      this.mode = settingMode;
    }

    // Resolve current user identity
    await this.resolveCurrentUser();

    // Try loading workspace config (overrides setting if present)
    if (workspacePath) {
      await this.loadConfig(workspacePath);
      this.startWatching(workspacePath);
    }

    logger.info(
      `Access control initialized: mode=${this.mode}, ` +
        `user=${this.currentUser ?? "unknown"}, ` +
        `users=${this.normalizedUsers.size}`,
    );
  }

  public dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.configWatcher?.dispose();
    this._onAccessChanged.dispose();
  }

  /** Reset singleton state for unit tests. */
  public static _resetForTesting(): void {
    AccessControlService.instance?.dispose();
    AccessControlService.instance = undefined;
  }

  // ── User Identity ────────────────────────────────────────────────

  /**
   * Resolve the current user via (in order):
   * 1. GitHub authentication session (if available)
   * 2. Git config user.email
   * Falls back to "unknown" if neither is available.
   */
  private async resolveCurrentUser(): Promise<void> {
    // Try GitHub auth first (non-interactive — don't force login)
    try {
      const session = await vscode.authentication.getSession(
        "github",
        ["user:email"],
        { createIfNone: false },
      );
      if (session?.account?.label) {
        this.currentUser = session.account.label.toLowerCase();
        logger.debug(`User identity from GitHub: ${this.currentUser}`);
        return;
      }
    } catch {
      // GitHub auth not available or user declined
    }

    // Fall back to git config
    try {
      const email = await this.getGitEmail();
      if (email) {
        this.currentUser = email.toLowerCase();
        logger.debug(`User identity from git config: ${this.currentUser}`);
        return;
      }
    } catch {
      // git not available
    }

    this.currentUser = undefined;
    logger.warn("Could not resolve user identity for access control");
  }

  private getGitEmail(): Promise<string | undefined> {
    return new Promise((resolve) => {
      execFile(
        "git",
        ["config", "user.email"],
        {
          encoding: "utf8",
          timeout: 3000,
          cwd: this.workspacePath ?? undefined,
        },
        (err, stdout) => {
          if (err) {
            resolve(undefined);
            return;
          }
          const email = (stdout as string)?.trim();
          resolve(email || undefined);
        },
      );
    });
  }

  /**
   * Get the resolved current user identity.
   * Returns undefined if no identity could be determined.
   */
  public getCurrentUser(): string | undefined {
    return this.currentUser;
  }

  // ── Config Loading ───────────────────────────────────────────────

  /**
   * Load access config with concurrency serialization.
   * If a load is already in-flight, the caller awaits the same promise.
   */
  private async loadConfig(workspacePath: string): Promise<void> {
    if (this.loadInFlight) {
      await this.loadInFlight;
      return;
    }
    this.loadInFlight = this._loadConfigInner(workspacePath);
    try {
      await this.loadInFlight;
    } finally {
      this.loadInFlight = undefined;
    }
  }

  private async _loadConfigInner(workspacePath: string): Promise<void> {
    const configPath = path.join(workspacePath, CODEBUDDY_DIR, CONFIG_FILENAME);

    // Path traversal guard
    const resolved = path.resolve(configPath);
    if (!resolved.startsWith(path.resolve(workspacePath))) {
      logger.warn("Access config path escapes workspace — ignoring");
      return;
    }

    try {
      const fileStat = await stat(resolved);
      if (fileStat.size > MAX_CONFIG_FILE_BYTES) {
        logger.warn(
          `Access config too large (${fileStat.size} bytes, max ${MAX_CONFIG_FILE_BYTES}) — ignoring`,
        );
        return;
      }
    } catch {
      // File doesn't exist — use defaults
      this.config = {};
      this.configLoaded = false;
      this.applyConfig();
      return;
    }

    // Reset before parse — if parse fails, we stay on safe defaults
    this.config = {};
    this.configLoaded = false;

    try {
      const raw = await readFile(resolved, "utf-8");
      const parsed = JSON.parse(raw);

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        logger.warn("Access config is not a JSON object — ignoring");
        this.applyConfig();
        return;
      }

      this.config = parsed as AccessControlConfig;
      this.configLoaded = true;

      // Validate mode
      if (this.config.mode && VALID_MODES.includes(this.config.mode)) {
        this.mode = this.config.mode;
      }

      this.applyConfig();
      logger.info(`Access config loaded: mode=${this.mode}`);
    } catch (err) {
      logger.warn(`Failed to parse access config: ${err}`);
      this.applyConfig();
    }
  }

  /**
   * Pre-compute normalized lookup sets from config.
   */
  private applyConfig(): void {
    const users = this.config.users;
    this.normalizedUsers = new Set(
      Array.isArray(users)
        ? users
            .filter((u): u is string => typeof u === "string" && u.length > 0)
            .slice(0, MAX_USERS)
            .map((u) => u.toLowerCase())
        : [],
    );

    const admins = this.config.admins;
    this.normalizedAdmins = new Set(
      Array.isArray(admins)
        ? admins
            .filter((u): u is string => typeof u === "string" && u.length > 0)
            .slice(0, MAX_USERS)
            .map((u) => u.toLowerCase())
        : [],
    );

    this.logDenied = this.config.logDenied !== false;
  }

  // ── File Watching ────────────────────────────────────────────────

  private startWatching(workspacePath: string): void {
    if (this.configWatcher) return; // idempotent

    const pattern = new vscode.RelativePattern(
      workspacePath,
      `${CODEBUDDY_DIR}/${CONFIG_FILENAME}`,
    );
    this.configWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    const reload = () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.loadConfig(workspacePath).catch((err) =>
          logger.warn(`Access config reload failed: ${err}`),
        );
      }, 500);
    };

    this.configWatcher.onDidChange(reload);
    this.configWatcher.onDidCreate(reload);
    this.configWatcher.onDidDelete(() => {
      this.config = {};
      this.configLoaded = false;
      const oldMode = this.mode;
      this.mode = "open";
      this.applyConfig();
      if (oldMode !== this.mode) {
        this._onAccessChanged.fire(this.mode);
      }
      logger.info("Access config deleted — reverting to open mode");
    });
  }

  // ── Access Control Queries ───────────────────────────────────────

  /**
   * Get the current access control mode.
   */
  public getMode(): AccessControlMode {
    return this.mode;
  }

  /**
   * Check whether the current user is allowed to use the agent.
   *
   * - `open` mode: always allowed.
   * - `allow` mode: only users in the list are allowed.
   * - `deny` mode: users in the list are blocked; everyone else allowed.
   *
   * If user identity is unknown and mode is not `open`, access is denied
   * for safety.
   */
  public isCurrentUserAllowed(): boolean {
    return this.isUserAllowed(this.currentUser);
  }

  /**
   * Check if a specific user is allowed.
   */
  public isUserAllowed(user: string | undefined): boolean {
    if (this.mode === "open") return true;

    if (!user) {
      // Can't identify user in a restricted mode — deny for safety
      if (this.logDenied) {
        logger.warn("Access denied: user identity unknown in restricted mode");
      }
      return false;
    }

    const normalizedUser = user.toLowerCase();

    // Admins always allowed
    if (this.normalizedAdmins.has(normalizedUser)) return true;

    switch (this.mode) {
      case "allow":
        return this.normalizedUsers.has(normalizedUser);
      case "deny":
        return !this.normalizedUsers.has(normalizedUser);
      default:
        return true;
    }
  }

  /**
   * Check if the current user is an admin.
   */
  public isAdmin(): boolean {
    if (!this.currentUser) return false;
    return this.normalizedAdmins.has(this.currentUser);
  }

  /**
   * Check access and record an audit entry.
   * Returns true if the action is allowed.
   */
  public checkAccess(action: string): boolean {
    const allowed = this.isCurrentUserAllowed();

    this.recordAudit(action, allowed);

    if (!allowed && this.logDenied) {
      logger.warn(
        `Access denied: user="${this.currentUser ?? "unknown"}" ` +
          `action="${action}" mode=${this.mode}`,
      );
    }

    return allowed;
  }

  // ── Audit Log ────────────────────────────────────────────────────

  private recordAudit(action: string, allowed: boolean): void {
    this.auditLog.push({
      timestamp: Date.now(),
      user: this.currentUser ?? "unknown",
      action,
      allowed,
    });

    // Bounded: drop oldest when limit reached
    if (this.auditLog.length > MAX_AUDIT_ENTRIES) {
      this.auditLog = this.auditLog.slice(-MAX_AUDIT_ENTRIES);
    }
  }

  /**
   * Get the audit log (newest last).
   */
  public getAuditLog(): readonly AccessAuditEntry[] {
    return this.auditLog;
  }

  /**
   * Get recent denied entries (for diagnostics / doctor check).
   */
  public getRecentDenied(count = 10): AccessAuditEntry[] {
    return this.auditLog.filter((e) => !e.allowed).slice(-count);
  }

  // ── Mode Switching ───────────────────────────────────────────────

  /**
   * Set the access control mode programmatically.
   * Fires `onAccessChanged` if the mode actually changes.
   */
  public setMode(mode: AccessControlMode, persist = true): void {
    if (!VALID_MODES.includes(mode)) return;
    const old = this.mode;
    this.mode = mode;
    if (old !== this.mode) {
      this._onAccessChanged.fire(this.mode);
      logger.info(`Access control mode changed: ${old} → ${this.mode}`);

      if (persist) {
        vscode.workspace
          .getConfiguration("codebuddy")
          .update(
            "accessControl.defaultMode",
            mode,
            vscode.ConfigurationTarget.Workspace,
          )
          .then(undefined, (err) =>
            logger.warn(`Could not persist access control mode: ${err}`),
          );
      }
    }
  }

  // ── Diagnostics ──────────────────────────────────────────────────

  /**
   * Provide diagnostics for the Doctor check.
   */
  public getDiagnostics(): AccessDiagnostic[] {
    const diags: AccessDiagnostic[] = [];

    // Config presence
    if (!this.configLoaded) {
      diags.push({
        severity: "info",
        message:
          "No .codebuddy/access.json found. Access control defaults to open mode.",
        code: "no-config",
      });
    } else {
      diags.push({
        severity: "info",
        message: `Access config loaded. Mode: ${this.mode}, users: ${this.normalizedUsers.size}, admins: ${this.normalizedAdmins.size}.`,
        code: "config-loaded",
      });
    }

    // User identity
    if (!this.currentUser) {
      diags.push({
        severity: this.mode === "open" ? "info" : "warn",
        message:
          "Could not resolve user identity (no GitHub auth or git config). " +
          (this.mode === "open"
            ? "No impact in open mode."
            : "All users will be denied in current restricted mode."),
        code: "no-user-identity",
      });
    }

    // Empty user list in restricted mode
    if (this.mode !== "open" && this.normalizedUsers.size === 0) {
      diags.push({
        severity: "warn",
        message:
          `Access mode is "${this.mode}" but users list is empty. ` +
          (this.mode === "allow"
            ? "No one can use the agent except admins."
            : "The deny list is empty — everyone is allowed."),
        code: "empty-user-list",
      });
    }

    // Current user access status
    if (this.currentUser && this.mode !== "open") {
      const allowed = this.isCurrentUserAllowed();
      diags.push({
        severity: allowed ? "info" : "critical",
        message: allowed
          ? `Current user "${this.currentUser}" is allowed.`
          : `Current user "${this.currentUser}" is DENIED access.`,
        code: allowed ? "user-allowed" : "user-denied",
      });
    }

    return diags;
  }
}
