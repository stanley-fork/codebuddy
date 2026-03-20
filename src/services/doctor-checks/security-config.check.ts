import type {
  DoctorCheckModule,
  DoctorCheckContext,
  DoctorFinding,
} from "./types";
import type { SecurityDiagnostic } from "../external-security-config.service";

/**
 * Delegates to ExternalSecurityConfigService.getDiagnostics() and maps
 * the results into DoctorFinding shape. Offers scaffoldDefaultConfig()
 * as auto-fix when no config exists.
 */
export const securityConfigCheck: DoctorCheckModule = {
  name: "security-config",

  async run(ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
    const diagnostics = await ctx.securityConfig.getDiagnostics();

    return diagnostics.map((d: SecurityDiagnostic) => ({
      check: "security-config",
      severity: d.severity,
      message: d.message,
      autoFixable: d.autoFixable,
      ...(d.autoFixable && d.code === "no-config"
        ? {
            fix: () =>
              ctx.securityConfig.scaffoldDefaultConfig().then(() => {}),
          }
        : {}),
    }));
  },
};
