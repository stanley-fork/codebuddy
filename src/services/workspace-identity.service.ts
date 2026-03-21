import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../infrastructure/logger/logger";

// ─── Constants ───────────────────────────────────────────────────────

/** Global rules directory: `~/.codebuddy/` */
const GLOBAL_CODEBUDDY_DIR = path.join(os.homedir(), ".codebuddy");

/** Global rules file: `~/.codebuddy/rules.md` */
const GLOBAL_RULES_FILE = path.join(GLOBAL_CODEBUDDY_DIR, "rules.md");

// ─── Service ─────────────────────────────────────────────────────────

// ── Helpers ──────────────────────────────────────────────────────────

/** Resolve symlinks, falling back to `p` only when the path does not exist yet. */
function tryRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch (err: any) {
    if (err.code === "ENOENT") return p; // Not yet created — lexical is fine
    throw err; // EACCES, ELOOP, etc. — must not silently bypass
  }
}

/**
 * Service to generate stable, workspace-scoped identifiers.
 *
 * Produces a short hash of the workspace root path so that chat history,
 * sessions, and other per-workspace data don't collide across projects.
 *
 * The hash is deterministic: the same workspace folder always produces
 * the same prefix regardless of platform or session.
 *
 * @remarks Currently always uses `workspaceFolders[0]`. Multi-root
 * workspace support is a future enhancement.
 */
export class WorkspaceIdentityService {
  private static instance: WorkspaceIdentityService | undefined;

  /** SHA-256 hash prefix (first 12 hex chars) of the workspace root path. */
  private workspaceHash: string | undefined;
  /** Resolved workspace root path (first workspace folder). */
  private workspaceRoot: string | undefined;
  /** Whether initialize() has been called. */
  private initialized = false;
  /** Lazy-initialized logger (avoids module-level init before VS Code context). */
  private _logger?: Logger;

  private constructor() {}

  private get logger(): Logger {
    if (!this._logger) {
      this._logger = Logger.initialize("WorkspaceIdentityService", {
        minLevel: LogLevel.DEBUG,
        enableConsole: true,
        enableFile: true,
        enableTelemetry: false,
      });
    }
    return this._logger;
  }

  public static getInstance(): WorkspaceIdentityService {
    if (!WorkspaceIdentityService.instance) {
      WorkspaceIdentityService.instance = new WorkspaceIdentityService();
    }
    return WorkspaceIdentityService.instance;
  }

  /**
   * Initialize with the current workspace root.
   * Call once during extension activation (after workspace folders are available).
   * Subsequent calls are ignored — use `reinitialize()` for intentional changes.
   */
  public initialize(workspacePath?: string): void {
    if (this.initialized) {
      this.logger.warn(
        "WorkspaceIdentityService.initialize() called more than once — ignored. " +
          "Use reinitialize() to intentionally change the workspace.",
      );
      return;
    }
    this._doInitialize(workspacePath);
    this.initialized = true;
  }

  /**
   * Explicitly reinitialize after a workspace folder change.
   * Callers are responsible for resetting any cached agent IDs.
   */
  public reinitialize(workspacePath?: string): void {
    this.initialized = false;
    this.initialize(workspacePath);
  }

  private _doInitialize(workspacePath?: string): void {
    this.workspaceRoot =
      workspacePath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (this.workspaceRoot) {
      const resolved = path.resolve(this.workspaceRoot);
      /**
       * Take the first 12 hex characters (48 bits) of the SHA-256 hash.
       * Birthday-collision probability at N=1,000 workspaces ≈ 0.18%.
       * Increase to 16 chars (64 bits) if enterprise-scale deployment is needed.
       */
      this.workspaceHash = crypto
        .createHash("sha256")
        .update(resolved)
        .digest("hex")
        .slice(0, 12);
      this.logger.info(
        `Workspace identity: ${path.basename(resolved)} → ${this.workspaceHash}`,
      );
    } else {
      this.workspaceHash = undefined;
      this.logger.warn("No workspace root — agent IDs will be global");
    }
  }

  // ── Accessors ──────────────────────────────────────────────────────

  /**
   * Get the workspace-scoped agent ID.
   *
   * Format: `agentId-<hash>` when a workspace is open,
   *         `agentId`        as a fallback (no workspace).
   *
   * This is the **only** place the agent ID is constructed — all callers
   * should use this instead of hardcoding `"agentId"`.
   */
  public getAgentId(): string {
    return this.workspaceHash ? `agentId-${this.workspaceHash}` : "agentId";
  }

  /**
   * Get the short hash of the workspace root path.
   * Returns `undefined` if no workspace is open.
   */
  public getWorkspaceHash(): string | undefined {
    return this.workspaceHash;
  }

  /**
   * Get the resolved workspace root path.
   */
  public getWorkspaceRoot(): string | undefined {
    return this.workspaceRoot;
  }

  /**
   * Get a human-readable workspace name (folder basename).
   */
  public getWorkspaceName(): string {
    if (!this.workspaceRoot) return "No Workspace";
    return path.basename(this.workspaceRoot);
  }

  /**
   * Path to the global rules file: `~/.codebuddy/rules.md`.
   */
  public static getGlobalRulesPath(): string {
    return GLOBAL_RULES_FILE;
  }

  /**
   * Path to the global CodeBuddy directory: `~/.codebuddy/`.
   */
  public static getGlobalDir(): string {
    return GLOBAL_CODEBUDDY_DIR;
  }

  /**
   * Resolve a relative path within the workspace root, guarding against
   * path-traversal attacks (inspired by nanoclaw/src/group-folder.ts).
   * Resolves symlinks to prevent escape via indirection.
   *
   * Throws if the resolved path escapes the workspace root.
   */
  public resolveWorkspacePath(relativePath: string): string {
    if (!this.workspaceRoot) {
      throw new Error("No workspace root — cannot resolve path");
    }
    const lexicalResolved = path.resolve(this.workspaceRoot, relativePath);
    const realResolved = tryRealpath(lexicalResolved);
    const realRoot = tryRealpath(this.workspaceRoot);

    const rel = path.relative(realRoot, realResolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Path escapes workspace root: ${relativePath}`);
    }
    return realResolved;
  }

  /**
   * Validate that a file path (absolute or relative) is within the workspace.
   * Resolves symlinks to prevent escape via indirection.
   *
   * Returns the resolved absolute path if valid, or `undefined` if:
   * - the path escapes the workspace root, or
   * - no workspace is open (callers should fall back to permissive behavior).
   *
   * This is the non-throwing variant for use in LLM tool boundaries.
   */
  public validatePathWithinWorkspace(filePath: string): string | undefined {
    if (!this.workspaceRoot) return undefined;
    const lexicalResolved = path.resolve(this.workspaceRoot, filePath);

    let realResolved: string;
    let realRoot: string;
    try {
      realResolved = tryRealpath(lexicalResolved);
      realRoot = tryRealpath(this.workspaceRoot);
    } catch (err: any) {
      if (err.code === "EACCES") {
        this.logger.warn(
          `Permission denied resolving path "${filePath}" — treating as invalid`,
        );
      } else if (err.code === "ELOOP") {
        this.logger.warn(
          `Circular symlink detected for "${filePath}" — blocking`,
        );
      } else {
        this.logger.warn(
          `Unexpected path error for "${filePath}": ${err.message}`,
        );
      }
      return undefined;
    }

    const rel = path.relative(realRoot, realResolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      this.logger.warn(`Blocked path traversal attempt: ${filePath}`);
      return undefined;
    }
    return realResolved;
  }

  /**
   * @internal Only available in test/development environments.
   * Reset singleton state for unit tests.
   */
  public static _resetForTesting(): void {
    if (
      typeof process !== "undefined" &&
      process.env.NODE_ENV === "production"
    ) {
      throw new Error("_resetForTesting() must not be called in production");
    }
    if (WorkspaceIdentityService.instance) {
      WorkspaceIdentityService.instance._logger = undefined;
    }
    WorkspaceIdentityService.instance = undefined;
  }
}

/**
 * Module-level convenience — single source of truth for the workspace agent ID.
 * Import this instead of duplicating `WorkspaceIdentityService.getInstance().getAgentId()`.
 */
export function getWorkspaceAgentId(): string {
  return WorkspaceIdentityService.getInstance().getAgentId();
}
