/**
 * Minimal interface for security policy checks.
 * Used for dependency injection so consumers (DeepTerminalService,
 * browser-handler, etc.) don't need to import the concrete
 * ExternalSecurityConfigService — avoiding circular dependencies.
 */
export interface ISecurityPolicy {
  /** Returns `true` if the command should be blocked. */
  isCommandBlocked(command: string): boolean;
  /** Returns `true` if the URL is allowed to be fetched. */
  isUrlAllowed(url: string): boolean;
  /** Returns `true` if the filesystem path is sensitive / blocked. */
  isPathBlocked(filePath: string): boolean;
  /** Checks whether an external path (outside the workspace) is explicitly allowed. */
  isExternalPathAllowed(filePath: string): {
    allowed: boolean;
    readWrite: boolean;
  };
}
