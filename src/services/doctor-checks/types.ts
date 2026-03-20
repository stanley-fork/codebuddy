import { Logger } from "../../infrastructure/logger/logger";
import type { SecretStorageService } from "../secret-storage";
import type { ExternalSecurityConfigService } from "../external-security-config.service";

// ─── Types ───────────────────────────────────────────────────────────

export interface DoctorFinding {
  /** Which check produced this finding (e.g. "api-key-audit"). */
  check: string;
  severity: "info" | "warn" | "critical";
  message: string;
  autoFixable: boolean;
  /** Optional auto-fix callback — only present when `autoFixable` is true. */
  fix?: () => Promise<void>;
}

export interface DoctorCheckContext {
  workspacePath: string;
  secretStorage: SecretStorageService;
  securityConfig: ExternalSecurityConfigService;
  logger: Logger;
}

export interface DoctorCheckModule {
  /** Human-readable name used as the `check` field in findings. */
  name: string;
  run(context: DoctorCheckContext): Promise<DoctorFinding[]>;
}
