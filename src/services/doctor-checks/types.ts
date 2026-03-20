import { Logger } from "../../infrastructure/logger/logger";
import type { SecretStorageService } from "../secret-storage";
import type { ExternalSecurityConfigService } from "../external-security-config.service";

// ─── Types ───────────────────────────────────────────────────────────

interface DoctorFindingBase {
  /** Which check produced this finding (e.g. "api-key-audit"). */
  check: string;
  severity: "info" | "warn" | "critical";
  message: string;
}

interface FixableDoctorFinding extends DoctorFindingBase {
  autoFixable: true;
  fix: () => Promise<void>;
}

interface NonFixableDoctorFinding extends DoctorFindingBase {
  autoFixable: false;
  fix?: never;
}

export type DoctorFinding = FixableDoctorFinding | NonFixableDoctorFinding;

export interface DoctorCheckContext {
  workspacePath: string;
  secretStorage: SecretStorageService;
  securityConfig: ExternalSecurityConfigService;
  logger: Logger;
  /** Override for testing — defaults to `process.platform` at runtime. */
  platform?: NodeJS.Platform;
}

export interface DoctorCheckModule {
  /** Human-readable name used as the `check` field in findings. */
  name: string;
  run(context: DoctorCheckContext): Promise<DoctorFinding[]>;
}
