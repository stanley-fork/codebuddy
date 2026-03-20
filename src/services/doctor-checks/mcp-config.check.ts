import * as vscode from "vscode";
import type { MCPServersConfig } from "../../MCP/types";
import type {
  DoctorCheckModule,
  DoctorCheckContext,
  DoctorFinding,
} from "./types";

/** Env var names that commonly hold secrets. */
const SECRET_ENV_PATTERNS = [
  /api.?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /credential/i,
  /auth/i,
];

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
            envValue.length > 0 &&
            !envValue.startsWith("${") && // not a variable reference
            !envValue.startsWith("$");
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
