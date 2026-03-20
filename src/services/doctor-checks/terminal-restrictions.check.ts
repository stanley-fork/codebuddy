import type {
  DoctorCheckModule,
  DoctorCheckContext,
  DoctorFinding,
} from "./types";

/** Number of hardcoded default patterns in ExternalSecurityConfigService. */
const DEFAULT_PATTERN_COUNT = 5;

export const terminalRestrictionsCheck: DoctorCheckModule = {
  name: "terminal-restrictions",

  async run(ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
    const findings: DoctorFinding[] = [];

    const patterns = ctx.securityConfig.getCommandDenyPatterns();
    const totalCount = patterns.length;
    const customCount = totalCount - DEFAULT_PATTERN_COUNT;

    if (customCount > 0) {
      findings.push({
        check: "terminal-restrictions",
        severity: "info",
        message: `${customCount} custom command deny pattern(s) configured (${totalCount} total including defaults)`,
        autoFixable: false,
      });
    } else {
      findings.push({
        check: "terminal-restrictions",
        severity: "warn",
        message:
          "No custom command deny patterns configured — only default protections active. Consider adding project-specific restrictions in .codebuddy/security.json",
        autoFixable: false,
      });
    }

    return findings;
  },
};
