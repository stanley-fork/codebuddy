import type {
  DoctorCheckModule,
  DoctorCheckContext,
  DoctorFinding,
} from "./types";
import {
  PermissionScopeService,
  type PermissionDiagnostic,
} from "../permission-scope.service";

/**
 * Delegates to PermissionScopeService.getDiagnostics() and maps
 * the results into DoctorFinding shape.
 */
export const permissionScopeCheck: DoctorCheckModule = {
  name: "permission-scope",

  async run(ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
    let diagnostics: PermissionDiagnostic[];
    try {
      diagnostics = PermissionScopeService.getInstance().getDiagnostics();
    } catch (err) {
      ctx.logger.debug(
        `PermissionScopeService not initialized — skipping check: ${err}`,
      );
      return [];
    }

    return diagnostics.map(
      (d: PermissionDiagnostic): DoctorFinding => ({
        check: "permission-scope",
        severity: d.severity,
        message: d.message,
        autoFixable: false,
      }),
    );
  },
};
