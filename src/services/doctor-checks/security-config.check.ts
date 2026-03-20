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

    return diagnostics.map((d: SecurityDiagnostic): DoctorFinding => {
      if (d.autoFixable && d.code === "no-config") {
        return {
          check: "security-config",
          severity: d.severity,
          message: d.message,
          autoFixable: true as const,
          fix: () => ctx.securityConfig.scaffoldDefaultConfig().then(() => {}),
        };
      }
      return {
        check: "security-config",
        severity: d.severity,
        message: d.message,
        autoFixable: false as const,
      };
    });
  },
};
