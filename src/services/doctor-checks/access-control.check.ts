import type {
  DoctorCheckModule,
  DoctorCheckContext,
  DoctorFinding,
} from "./types";
import { AccessControlService } from "../access-control.service";

export const accessControlCheck: DoctorCheckModule = {
  name: "access-control",

  async run(ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
    try {
      const diagnostics = AccessControlService.getInstance().getDiagnostics();

      return diagnostics.map((d) => ({
        check: "access-control" as const,
        severity: d.severity,
        message: d.message,
        autoFixable: false as const,
      }));
    } catch (err) {
      ctx.logger.debug(`Access control check failed: ${err}`);
      return [];
    }
  },
};
