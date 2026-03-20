import type {
  DoctorCheckModule,
  DoctorCheckContext,
  DoctorFinding,
} from "./types";

export const terminalRestrictionsCheck: DoctorCheckModule = {
  name: "terminal-restrictions",

  async run(ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
    const findings: DoctorFinding[] = [];

    // Use the service's own knowledge of custom patterns (single source of truth)
    const customPatterns =
      ctx.securityConfig.getCustomCommandDenyPatterns?.() ?? [];
    const totalCount = ctx.securityConfig.getCommandDenyPatterns().length;
    const customCount = customPatterns.length;

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
