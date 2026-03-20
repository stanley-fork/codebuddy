import type {
  DoctorCheckModule,
  DoctorCheckContext,
  DoctorFinding,
} from "./types";

export const inputValidatorCheck: DoctorCheckModule = {
  name: "input-validator",

  async run(_ctx: DoctorCheckContext): Promise<DoctorFinding[]> {
    const findings: DoctorFinding[] = [];

    try {
      const { InputValidator } = await import("../input-validator");
      const validator = InputValidator.getInstance();

      if (validator) {
        // Verify it's functional by running a benign validation
        const result = validator.validateInput("test", "chat");
        if (result.isValid) {
          findings.push({
            check: "input-validator",
            severity: "info",
            message:
              "InputValidator active — prompt injection protection enabled",
            autoFixable: false,
          });
        } else {
          findings.push({
            check: "input-validator",
            severity: "warn",
            message:
              "InputValidator rejected a benign test input — may be misconfigured",
            autoFixable: false,
          });
        }
      } else {
        findings.push({
          check: "input-validator",
          severity: "warn",
          message:
            "InputValidator instance is null — prompt injection protection may be inactive",
          autoFixable: false,
        });
      }
    } catch (err) {
      findings.push({
        check: "input-validator",
        severity: "warn",
        message: `InputValidator could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
        autoFixable: false,
      });
    }

    return findings;
  },
};
