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

  async run(_ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
    let diagnostics: PermissionDiagnostic[];
    try {
      diagnostics = PermissionScopeService.getInstance().getDiagnostics();
    } catch {
      // Service not yet initialised — nothing to report.
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
