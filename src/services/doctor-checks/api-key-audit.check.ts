import * as vscode from "vscode";
import { APP_CONFIG } from "../../application/constant";
import type {
  DoctorCheckModule,
  DoctorCheckContext,
  DoctorFinding,
} from "./types";

/** The 9 API key config keys that SecretStorageService manages. */
const API_KEY_CONFIGS: readonly string[] = [
  APP_CONFIG.geminiKey,
  APP_CONFIG.groqApiKey,
  APP_CONFIG.anthropicApiKey,
  APP_CONFIG.deepseekApiKey,
  APP_CONFIG.openaiApiKey,
  APP_CONFIG.qwenApiKey,
  APP_CONFIG.glmApiKey,
  APP_CONFIG.tavilyApiKey,
  APP_CONFIG.localApiKey,
];

/** Sentinel values that represent "no real key". */
const NON_KEY_VALUES = new Set(["apiKey", "not-needed", ""]);

export const apiKeyAuditCheck: DoctorCheckModule = {
  name: "api-key-audit",

  async run(ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
    const findings: DoctorFinding[] = [];
    let plaintextCount = 0;
    let migratedCount = 0;
    let dualStoredCount = 0;

    for (const configKey of API_KEY_CONFIGS) {
      const settingsValue = vscode.workspace
        .getConfiguration()
        .get<string>(configKey);
      const isRealSettingsValue =
        settingsValue && !NON_KEY_VALUES.has(settingsValue);
      const secretValue = ctx.secretStorage.getApiKey(configKey);

      if (isRealSettingsValue && !secretValue) {
        // Key in settings but NOT in SecretStorage — needs migration
        plaintextCount++;
        findings.push({
          check: "api-key-audit",
          severity: "critical",
          message: `${configKey} has a plaintext API key in settings — not yet migrated to SecretStorage`,
          autoFixable: true,
          fix: async () => {
            // Re-read at fix time — never hold the raw secret in a closure longer than needed
            const currentValue = vscode.workspace
              .getConfiguration()
              .get<string>(configKey);
            if (!currentValue || NON_KEY_VALUES.has(currentValue)) {
              ctx.logger.warn(
                `Doctor auto-fix: ${configKey} no longer has a value to migrate`,
              );
              return;
            }
            await ctx.secretStorage.storeApiKey(configKey, currentValue);
            // Never log the secret value — only log the key name
            ctx.logger.info(
              `Doctor auto-fix: migrated ${configKey} to SecretStorage`,
            );
          },
        });
      } else if (isRealSettingsValue && secretValue) {
        // Key in BOTH places — migrated but settings not cleaned
        dualStoredCount++;
        findings.push({
          check: "api-key-audit",
          severity: "warn",
          message: `${configKey} exists in both settings and SecretStorage — consider removing the settings value`,
          autoFixable: false,
        });
      } else if (secretValue) {
        // Already migrated properly
        migratedCount++;
      }
      // No key at all — nothing to report
    }

    if (plaintextCount === 0 && dualStoredCount === 0) {
      findings.push({
        check: "api-key-audit",
        severity: "info",
        message:
          migratedCount > 0
            ? `${migratedCount} API key(s) properly stored in SecretStorage`
            : "No API keys configured",
        autoFixable: false,
      });
    }

    return findings;
  },
};
