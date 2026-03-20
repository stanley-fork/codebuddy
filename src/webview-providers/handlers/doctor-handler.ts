import { WebviewMessageHandler, HandlerContext } from "./types";
import { DoctorService } from "../../services/doctor.service";
import type { DoctorFinding } from "../../services/doctor-checks/types";

// ── Discriminated union for doctor messages ────────────────────────
type DoctorRunMessage = { command: "doctor-run" };
type DoctorAutoFixMessage = { command: "doctor-auto-fix" };
type DoctorHydrateMessage = { command: "doctor-hydrate" };

type DoctorMessage =
  | DoctorRunMessage
  | DoctorAutoFixMessage
  | DoctorHydrateMessage;

const DOCTOR_COMMANDS = [
  "doctor-run",
  "doctor-auto-fix",
  "doctor-hydrate",
] as const;

function isDoctorMessage(msg: unknown): msg is DoctorMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "command" in msg &&
    typeof (msg as Record<string, unknown>).command === "string" &&
    DOCTOR_COMMANDS.includes(
      (msg as Record<string, unknown>)
        .command as (typeof DOCTOR_COMMANDS)[number],
    )
  );
}

/** Serialisable subset of DoctorFinding (strips the fix callback). */
interface DoctorFindingDTO {
  id: string;
  check: string;
  severity: "info" | "warn" | "critical";
  message: string;
  autoFixable: boolean;
}

function toDTO(f: DoctorFinding, index: number): DoctorFindingDTO {
  return {
    id: `${f.check}-${index}`,
    check: f.check,
    severity: f.severity,
    message: f.message,
    autoFixable: f.autoFixable,
  };
}

export class DoctorHandler implements WebviewMessageHandler {
  readonly commands = [...DOCTOR_COMMANDS];

  async handle(message: unknown, ctx: HandlerContext): Promise<void> {
    if (!isDoctorMessage(message)) {
      ctx.logger.warn("DoctorHandler received invalid message shape");
      return;
    }

    const svc = DoctorService.getInstance();

    switch (message.command) {
      case "doctor-hydrate":
      case "doctor-run": {
        try {
          const findings = await svc.execute();

          ctx.webview.webview.postMessage({
            command: "doctor-results",
            findings: findings.map(toDTO),
            timestamp: Date.now(),
          });
        } catch (err) {
          ctx.logger.error(
            `DoctorHandler run failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          ctx.webview.webview.postMessage({
            command: "doctor-results",
            findings: [],
            timestamp: Date.now(),
            error: err instanceof Error ? err.message : "Doctor scan failed",
          });
        }
        break;
      }

      case "doctor-auto-fix": {
        try {
          // Use service-level cache — consistent across all panels
          const findingsToFix = svc.getCachedFindings();
          const applied = await svc.autoFixAll(findingsToFix);

          // Re-run checks after fix to get updated state
          const updated = await svc.execute();

          ctx.webview.webview.postMessage({
            command: "doctor-results",
            findings: updated.map(toDTO),
            timestamp: Date.now(),
            fixesApplied: applied,
          });
        } catch (err) {
          const errorMessage =
            err instanceof Error ? err.message : "Auto-fix failed";
          ctx.logger.error(`DoctorHandler auto-fix failed: ${errorMessage}`);
          // Always unblock the UI
          ctx.webview.webview.postMessage({
            command: "doctor-results",
            findings: svc.getCachedFindings().map(toDTO),
            timestamp: Date.now(),
            error: errorMessage,
            fixesApplied: 0,
          });
        }
        break;
      }
    }
  }
}
