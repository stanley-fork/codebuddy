import * as vscode from "vscode";
import type { MCPServersConfig } from "../../MCP/types";
import type {
  DoctorCheckModule,
  DoctorCheckContext,
  DoctorFinding,
} from "./types";

/** Env var names that commonly hold secrets — anchored to reduce false positives. */
const SECRET_ENV_PATTERNS: RegExp[] = [
  /^api[_-]?key$/i, // API_KEY, APIKEY, API-KEY
  /^.*[_-]api[_-]?key$/i, // OPENAI_API_KEY, MY_API_KEY
  /[_-]secret$/i, // MY_SECRET, APP_SECRET (suffix only)
  /^secret[_-]/i, // SECRET_KEY (prefix only)
  /^.*[_-]?password$/i, // DB_PASSWORD (suffix — not PASSWORD_HINT)
  /[_-]token$/i, // ACCESS_TOKEN, AUTH_TOKEN (suffix)
  /^token[_-]/i, // TOKEN_VALUE
  /^.*[_-]credentials?$/i, // SERVICE_CREDENTIALS (suffix — not CREDENTIAL_HELPER)
  /[_-]auth[_-]?token/i, // AUTH_TOKEN, OAUTH_TOKEN — not bare AUTH
  /private[_-]?key$/i, // PRIVATE_KEY (suffix — not PRIVATE_KEY_ROTATION_DAYS)
];

/** Minimum value length to consider as a potential secret. */
const MIN_SECRET_VALUE_LENGTH = 8;

export const mcpConfigCheck: DoctorCheckModule = {
  name: "mcp-config",

  async run(_ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
    const findings: DoctorFinding[] = [];

    const servers = vscode.workspace
      .getConfiguration("codebuddy")
      .get<MCPServersConfig>("mcpServers");

    if (!servers || Object.keys(servers).length === 0) {
      findings.push({
        check: "mcp-config",
        severity: "info",
        message: "No MCP servers configured",
        autoFixable: false,
      });
      return findings;
    }

    for (const [name, config] of Object.entries(servers)) {
      // Check for missing command
      if (!config.command) {
        findings.push({
          check: "mcp-config",
          severity: "warn",
          message: `MCP server "${name}" has no command specified`,
          autoFixable: false,
        });
        continue;
      }

      // Check for inline secrets in env
      if (config.env) {
        for (const [envKey, envValue] of Object.entries(config.env)) {
          const looksLikeSecret = SECRET_ENV_PATTERNS.some((rx) =>
            rx.test(envKey),
          );
          const hasRawValue =
            typeof envValue === "string" &&
            envValue.length >= MIN_SECRET_VALUE_LENGTH &&
            !envValue.startsWith("${") && // not a variable reference
            !envValue.startsWith("$") &&
            !/^[a-z_]+$/i.test(envValue); // pure identifier-looking values are not secrets
          if (looksLikeSecret && hasRawValue) {
            findings.push({
              check: "mcp-config",
              severity: "critical",
              message: `MCP server "${name}" has suspected inline secret in env var "${envKey}". Use a variable reference or SecretStorage instead.`,
              autoFixable: false,
            });
          }
        }
      }

      // Disabled server
      if (config.enabled === false) {
        findings.push({
          check: "mcp-config",
          severity: "info",
          message: `MCP server "${name}" is disabled`,
          autoFixable: false,
        });
      }
    }

    if (findings.length === 0) {
      findings.push({
        check: "mcp-config",
        severity: "info",
        message: `${Object.keys(servers).length} MCP server(s) configured — no issues found`,
        autoFixable: false,
      });
    }

    return findings;
  },
};
