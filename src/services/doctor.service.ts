import * as vscode from "vscode";
import { Logger, LogLevel } from "../infrastructure/logger/logger";
import type { SecretStorageService } from "./secret-storage";
import type { ExternalSecurityConfigService } from "./external-security-config.service";
import type {
  DoctorFinding,
  DoctorCheckModule,
  DoctorCheckContext,
} from "./doctor-checks/types";

// Import all checks
import { securityConfigCheck } from "./doctor-checks/security-config.check";
import { mcpConfigCheck } from "./doctor-checks/mcp-config.check";
import { directoryPermissionsCheck } from "./doctor-checks/directory-permissions.check";
import { terminalRestrictionsCheck } from "./doctor-checks/terminal-restrictions.check";
import { inputValidatorCheck } from "./doctor-checks/input-validator.check";
import { apiKeyAuditCheck } from "./doctor-checks/api-key-audit.check";
import { credentialProxyCheck } from "./doctor-checks/credential-proxy.check";
import { permissionScopeCheck } from "./doctor-checks/permission-scope.check";

// Re-export types for external consumers
export type { DoctorFinding } from "./doctor-checks/types";

const SEVERITY_ORDER: Record<DoctorFinding["severity"], number> = {
  critical: 0,
  warn: 1,
  info: 2,
};

export class DoctorService implements vscode.Disposable {
  private static instance: DoctorService | undefined;
  private readonly logger: Logger;
  private readonly outputChannel: vscode.OutputChannel;
  private readonly statusBarItem: vscode.StatusBarItem;
  private isDisposed = false;
  private isConfigured = false;
  private activeExecution: Promise<DoctorFinding[]> | undefined;
  private cachedFindings: DoctorFinding[] = [];

  private readonly checks: DoctorCheckModule[] = [
    apiKeyAuditCheck,
    inputValidatorCheck,
    terminalRestrictionsCheck,
    directoryPermissionsCheck,
    mcpConfigCheck,
    securityConfigCheck,
    credentialProxyCheck,
    permissionScopeCheck,
  ];

  private secretStorage: SecretStorageService | undefined;
  private securityConfig: ExternalSecurityConfigService | undefined;
  private workspacePath = "";

  private constructor() {
    this.logger = Logger.initialize("DoctorService", {
      minLevel: LogLevel.DEBUG,
      enableConsole: true,
      enableFile: true,
      enableTelemetry: true,
    });
    this.outputChannel = vscode.window.createOutputChannel("CodeBuddy Doctor");
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      -100,
    );
    this.statusBarItem.command = "codebuddy.runDoctor";
  }

  public static getInstance(): DoctorService {
    if (!DoctorService.instance) {
      DoctorService.instance = new DoctorService();
    }
    return DoctorService.instance;
  }

  /** @internal — test isolation */
  public static async resetInstance(): Promise<void> {
    const inst = DoctorService.instance;
    // Clear the static reference before any async/throwing operations
    DoctorService.instance = undefined;

    if (!inst) return;

    // Wait for in-flight work to settle before disposing resources
    await inst.activeExecution?.catch(() => {});

    try {
      inst.dispose();
    } catch {
      // Swallow — resetInstance is used in test teardown;
      // a dispose failure shouldn't break subsequent tests
    }
  }

  /** Inject dependencies after construction. */
  public configure(deps: {
    secretStorage: SecretStorageService;
    securityConfig: ExternalSecurityConfigService;
    workspacePath: string;
  }): void {
    this.secretStorage = deps.secretStorage;
    this.securityConfig = deps.securityConfig;
    this.workspacePath = deps.workspacePath;
    this.isConfigured = true;
  }

  private assertConfigured(): void {
    if (!this.isConfigured || !this.secretStorage || !this.securityConfig) {
      throw new Error(
        "DoctorService.configure() must be called before execute(). " +
          "Ensure it is called during extension activation before runBackground().",
      );
    }
  }

  public dispose(): void {
    this.isDisposed = true;
    this.outputChannel.dispose();
    this.statusBarItem.dispose();
  }

  // ── Core ─────────────────────────────────────────────────────────

  /** Returns the findings from the most recent execute() call. */
  public getCachedFindings(): DoctorFinding[] {
    return this.cachedFindings;
  }

  /** Run all checks and return sorted findings. Concurrent calls are deduplicated. */
  public async execute(): Promise<DoctorFinding[]> {
    this.assertConfigured();

    // If a scan is already in progress, join it rather than starting a new one
    if (this.activeExecution) {
      this.logger.debug("Doctor execute(): joining in-flight scan");
      return this.activeExecution;
    }

    this.activeExecution = this._executeInternal().finally(() => {
      this.activeExecution = undefined;
    });

    return this.activeExecution;
  }

  private async _executeInternal(): Promise<DoctorFinding[]> {
    this.assertConfigured();
    // Safe after assertConfigured() confirms both are defined
    const context: DoctorCheckContext = {
      workspacePath: this.workspacePath,
      secretStorage: this.secretStorage!,
      securityConfig: this.securityConfig!,
      logger: this.logger,
    };

    const results = await Promise.allSettled(
      this.checks.map((check) =>
        check.run(context).catch((err) => {
          this.logger.error(`Doctor check "${check.name}" failed: ${err}`);
          return [
            {
              check: check.name,
              severity: "warn" as const,
              message: `Check failed: ${err instanceof Error ? err.message : String(err)}`,
              autoFixable: false as const,
            },
          ];
        }),
      ),
    );

    const findings: DoctorFinding[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        findings.push(...result.value);
      }
    }

    // Sort: critical → warn → info
    findings.sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );

    this.cachedFindings = findings;
    return findings;
  }

  /** Display findings in the output channel. */
  public displayFindings(
    findings: DoctorFinding[],
    options: { showChannel?: boolean; preserveFocus?: boolean } = {},
  ): void {
    const { showChannel = true, preserveFocus = true } = options;
    if (this.isDisposed) return;

    const critical = findings.filter((f) => f.severity === "critical");
    const warnings = findings.filter((f) => f.severity === "warn");
    const infos = findings.filter((f) => f.severity === "info");

    this.outputChannel.appendLine(
      `\n${"─".repeat(40)}\n=== CodeBuddy Doctor — ${new Date().toLocaleTimeString()} ===`,
    );
    this.outputChannel.appendLine(
      `Ran ${this.checks.length} checks • Found ${critical.length} critical, ${warnings.length} warning, ${infos.length} info\n`,
    );

    if (critical.length > 0) {
      this.outputChannel.appendLine("❌ CRITICAL");
      for (const f of critical) {
        const fixTag = f.autoFixable ? " (auto-fixable)" : "";
        this.outputChannel.appendLine(`  [${f.check}] ${f.message}${fixTag}`);
      }
      this.outputChannel.appendLine("");
    }

    if (warnings.length > 0) {
      this.outputChannel.appendLine("⚠️  WARNING");
      for (const f of warnings) {
        const fixTag = f.autoFixable ? " (auto-fixable)" : "";
        this.outputChannel.appendLine(`  [${f.check}] ${f.message}${fixTag}`);
      }
      this.outputChannel.appendLine("");
    }

    if (infos.length > 0) {
      this.outputChannel.appendLine("ℹ️  INFO");
      for (const f of infos) {
        this.outputChannel.appendLine(`  [${f.check}] ${f.message}`);
      }
      this.outputChannel.appendLine("");
    }

    const fixableCount = findings.filter((f) => f.autoFixable).length;
    if (fixableCount > 0) {
      this.outputChannel.appendLine("---");
      this.outputChannel.appendLine(
        `${fixableCount} issue(s) are auto-fixable. Run "CodeBuddy: Doctor Auto-Fix" to apply.`,
      );
    }

    if (showChannel) {
      this.outputChannel.show(preserveFocus);
    }
  }

  /** Apply all auto-fixable findings. Returns count of fixes applied. */
  public async autoFixAll(findings: DoctorFinding[]): Promise<number> {
    if (this.isDisposed) return 0;
    const fixable = findings.filter(
      (f): f is Extract<DoctorFinding, { autoFixable: true }> => f.autoFixable,
    );
    let applied = 0;

    for (const f of fixable) {
      try {
        await f.fix();
        applied++;
        this.logger.info(`Auto-fixed: [${f.check}] ${f.message}`);
      } catch (err) {
        this.logger.error(
          `Auto-fix failed for [${f.check}]: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return applied;
  }

  /** Apply all auto-fixable findings, then re-run checks. Returns applied count + updated findings. */
  public async runAutoFixWithRefresh(): Promise<{
    applied: number;
    updated: DoctorFinding[];
  }> {
    const findingsToFix = this.getCachedFindings();
    const applied = await this.autoFixAll(findingsToFix);
    const updated = await this.execute();
    return { applied, updated };
  }

  /** Run silently on activation — only show status bar for critical issues. */
  public async runBackground(): Promise<void> {
    try {
      const findings = await this.execute();
      const critical = findings.filter((f) => f.severity === "critical");

      if (critical.length > 0) {
        this.updateStatusBar(critical.length);
        this.logger.warn(
          `Doctor background scan: ${critical.length} critical finding(s)`,
        );
      } else {
        this.clearStatusBar();
      }
    } catch (err) {
      this.logger.error(
        `Doctor background scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Status bar ───────────────────────────────────────────────────

  private updateStatusBar(criticalCount: number): void {
    this.statusBarItem.text = `$(shield) Doctor: ${criticalCount} critical`;
    this.statusBarItem.tooltip = `CodeBuddy Doctor found ${criticalCount} critical issue(s). Click to view.`;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground",
    );
    this.statusBarItem.show();
  }

  private clearStatusBar(): void {
    this.statusBarItem.hide();
  }
}
