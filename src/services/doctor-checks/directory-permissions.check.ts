import { stat, chmod } from "fs/promises";
import * as path from "path";
import type {
  DoctorCheckModule,
  DoctorCheckContext,
  DoctorFinding,
} from "./types";

const CODEBUDDY_DIR = ".codebuddy";

export const directoryPermissionsCheck: DoctorCheckModule = {
  name: "directory-permissions",

  async run(ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
    const findings: DoctorFinding[] = [];
    const platform = ctx.platform ?? process.platform;

    // Skip on Windows — POSIX mode bits are meaningless
    if (platform === "win32") {
      findings.push({
        check: "directory-permissions",
        severity: "info",
        message: "Directory permission check skipped on Windows",
        autoFixable: false,
      });
      return findings;
    }

    const dirPath = path.join(ctx.workspacePath, CODEBUDDY_DIR);

    try {
      const dirStat = await stat(dirPath);

      // Check directory permissions — warn if group/other have any access
      const dirMode = dirStat.mode & 0o777;
      if (dirMode & 0o077) {
        findings.push({
          check: "directory-permissions",
          severity: "warn",
          message: `.codebuddy/ is accessible by group/others (mode: ${dirMode.toString(8)}). Recommended: 700`,
          autoFixable: true,
          fix: () => chmod(dirPath, 0o700),
        });
      } else {
        findings.push({
          check: "directory-permissions",
          severity: "info",
          message: `.codebuddy/ permissions are correct (mode: ${dirMode.toString(8)})`,
          autoFixable: false,
        });
      }

      // Check security.json permissions
      const configPath = path.join(dirPath, "security.json");
      try {
        const fileStat = await stat(configPath);
        const fileMode = fileStat.mode & 0o777;
        if (fileMode & 0o077) {
          findings.push({
            check: "directory-permissions",
            severity: "warn",
            message: `security.json is accessible by group/others (mode: ${fileMode.toString(8)}). Recommended: 600`,
            autoFixable: true,
            fix: () => chmod(configPath, 0o600),
          });
        }
      } catch {
        // security.json doesn't exist — handled by security-config check
      }
    } catch {
      findings.push({
        check: "directory-permissions",
        severity: "info",
        message: ".codebuddy/ directory does not exist yet",
        autoFixable: false,
      });
    }

    return findings;
  },
};
