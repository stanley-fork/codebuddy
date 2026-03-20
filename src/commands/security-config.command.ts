import * as vscode from "vscode";
import { ExternalSecurityConfigService } from "../services/external-security-config.service";

/**
 * Opens the security config file in the editor, offering to scaffold if absent.
 */
export async function openSecurityConfig(): Promise<void> {
  const svc = ExternalSecurityConfigService.getInstance();
  if (!svc.hasConfig()) {
    const action = await vscode.window.showInformationMessage(
      "No security config found. Create .codebuddy/security.json?",
      "Create",
      "Cancel",
    );
    if (action === "Create") {
      const created = await svc.scaffoldDefaultConfig();
      if (created) {
        const configPath = svc.getConfigPath();
        if (configPath) {
          const doc = await vscode.workspace.openTextDocument(configPath);
          await vscode.window.showTextDocument(doc);
        }
      }
    }
    return;
  }
  const configPath = svc.getConfigPath();
  if (!configPath) return;
  const doc = await vscode.workspace.openTextDocument(configPath);
  await vscode.window.showTextDocument(doc);
}

/**
 * Runs security diagnostics and displays findings in the given output channel.
 */
export async function runSecurityDiagnostics(
  channel: vscode.OutputChannel,
): Promise<void> {
  const svc = ExternalSecurityConfigService.getInstance();
  const diagnostics = await svc.getDiagnostics();
  channel.clear();
  channel.appendLine("=== CodeBuddy Security Diagnostics ===\n");
  for (const d of diagnostics) {
    const icon =
      d.severity === "critical" ? "❌" : d.severity === "warn" ? "⚠️" : "ℹ️";
    channel.appendLine(`${icon} [${d.severity.toUpperCase()}] ${d.message}`);
  }
  channel.appendLine(`\nTotal: ${diagnostics.length} finding(s)`);
  channel.show();
}
