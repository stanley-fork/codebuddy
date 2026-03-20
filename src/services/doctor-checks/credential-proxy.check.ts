import type {
  DoctorCheckModule,
  DoctorCheckContext,
  DoctorFinding,
} from "./types";
import { CredentialProxyService } from "../credential-proxy.service";
import * as vscode from "vscode";

export const credentialProxyCheck: DoctorCheckModule = {
  name: "credential-proxy",

  async run(_ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
    const enabled = vscode.workspace
      .getConfiguration("codebuddy.credentialProxy")
      .get<boolean>("enabled", false);

    if (!enabled) {
      return [
        {
          check: "credential-proxy",
          severity: "info",
          message:
            "Credential proxy is disabled — API keys are passed directly to SDKs. Enable via codebuddy.credentialProxy.enabled for enhanced security.",
          autoFixable: false,
        },
      ];
    }

    // Proxy is enabled — check if it's actually running
    const proxy = CredentialProxyService.getInstance();
    const findings: DoctorFinding[] = [];

    if (proxy.isRunning()) {
      findings.push({
        check: "credential-proxy",
        severity: "info",
        message: `Credential proxy active on port ${proxy.getPort()} — API keys are injected at proxy level`,
        autoFixable: false,
      });
    } else {
      findings.push({
        check: "credential-proxy",
        severity: "critical",
        message:
          "Credential proxy is enabled but not running. LLM calls will fail. Restart the extension.",
        autoFixable: false,
      });
    }

    // Check for API keys leaked into environment variables
    const envPatterns = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GROQ_API_KEY",
      "DEEPSEEK_API_KEY",
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
    ];
    const leakedEnvVars = envPatterns.filter(
      (name) => process.env[name] !== undefined,
    );
    if (leakedEnvVars.length > 0) {
      findings.push({
        check: "credential-proxy",
        severity: "warn",
        message: `Found LLM API keys in environment variables (${leakedEnvVars.join(", ")}). With credential proxy enabled, these are unnecessary and increase exposure risk.`,
        autoFixable: false,
      });
    }

    return findings;
  },
};
