import { WebviewMessageHandler, HandlerContext } from "./types";
import { OnboardingService } from "../../services/onboarding.service";
import type {
  OnboardingStepResult,
  ProviderTestResult,
  ProjectInfo,
} from "../../services/onboarding.service";

// ─── Message Types ──────────────────────────────────────

type OnboardingHydrateMessage = { command: "onboarding-hydrate" };
type OnboardingStepCompleteMessage = {
  command: "onboarding-step-complete";
  step: number;
  data: Record<string, unknown>;
};
type OnboardingSkipMessage = { command: "onboarding-skip" };
type OnboardingDismissMessage = { command: "onboarding-dismiss" };
type OnboardingTestProviderMessage = {
  command: "onboarding-test-provider";
  provider: string;
};
type OnboardingStoreProviderKeyMessage = {
  command: "onboarding-store-provider-key";
  provider: string;
  apiKey: string;
};
type OnboardingDetectProjectMessage = { command: "onboarding-detect-project" };

type OnboardingMessage =
  | OnboardingHydrateMessage
  | OnboardingStepCompleteMessage
  | OnboardingSkipMessage
  | OnboardingDismissMessage
  | OnboardingTestProviderMessage
  | OnboardingStoreProviderKeyMessage
  | OnboardingDetectProjectMessage;

const ONBOARDING_COMMANDS = [
  "onboarding-hydrate",
  "onboarding-step-complete",
  "onboarding-skip",
  "onboarding-dismiss",
  "onboarding-test-provider",
  "onboarding-store-provider-key",
  "onboarding-detect-project",
] as const;

function isOnboardingMessage(msg: unknown): msg is OnboardingMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "command" in msg &&
    typeof (msg as Record<string, unknown>).command === "string" &&
    ONBOARDING_COMMANDS.includes(
      (msg as Record<string, unknown>)
        .command as (typeof ONBOARDING_COMMANDS)[number],
    )
  );
}

// ─── Response DTOs ──────────────────────────────────────

interface OnboardingStateDTO {
  shouldShow: boolean;
  providers: Array<{
    id: string;
    name: string;
    configured: boolean;
    isActive: boolean;
  }>;
  projectInfo: ProjectInfo | null;
  suggestedTasks: Array<{ label: string; prompt: string }>;
}

// ─── Handler ────────────────────────────────────────────

export class OnboardingHandler implements WebviewMessageHandler {
  readonly commands = [...ONBOARDING_COMMANDS];

  async handle(message: unknown, ctx: HandlerContext): Promise<void> {
    if (!isOnboardingMessage(message)) {
      ctx.logger.warn("OnboardingHandler received invalid message shape");
      return;
    }

    const svc = OnboardingService.getInstance();

    switch (message.command) {
      case "onboarding-hydrate": {
        try {
          const shouldShow = svc.shouldShowOnboarding();
          const providers = svc.getProviders();
          let projectInfo: ProjectInfo | null = null;
          let suggestedTasks: Array<{ label: string; prompt: string }> = [];

          if (shouldShow) {
            projectInfo = await svc.detectProjectInfo();
            suggestedTasks = svc.getSuggestedTasks(projectInfo);
          }

          const dto: OnboardingStateDTO = {
            shouldShow,
            providers,
            projectInfo,
            suggestedTasks,
          };

          ctx.webview.webview.postMessage({
            command: "onboarding-state",
            data: dto,
          });
        } catch (err) {
          ctx.logger.error(
            `OnboardingHandler hydrate failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          ctx.webview.webview.postMessage({
            command: "onboarding-state",
            data: {
              shouldShow: false,
              providers: [],
              projectInfo: null,
              suggestedTasks: [],
            } as OnboardingStateDTO,
          });
        }
        break;
      }

      case "onboarding-step-complete": {
        try {
          const result: OnboardingStepResult = {
            step: message.step,
            data: message.data,
          };
          await svc.completeStep(result);

          // After provider setup, re-send provider list so UI updates
          if (message.step === 1) {
            ctx.webview.webview.postMessage({
              command: "onboarding-providers-updated",
              providers: svc.getProviders(),
            });
          }

          ctx.webview.webview.postMessage({
            command: "onboarding-step-result",
            step: message.step,
            success: true,
          });
        } catch (err) {
          ctx.logger.error(
            `OnboardingHandler step ${message.step} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          ctx.webview.webview.postMessage({
            command: "onboarding-step-result",
            step: message.step,
            success: false,
            error: err instanceof Error ? err.message : "Step failed",
          });
        }
        break;
      }

      case "onboarding-store-provider-key": {
        try {
          if (!svc.isValidProviderId(message.provider)) {
            ctx.logger.warn(`Rejected unknown provider: ${message.provider}`);
            ctx.webview.webview.postMessage({
              command: "onboarding-test-result",
              data: {
                provider: message.provider,
                success: false,
                latencyMs: 0,
                error: "Unknown provider",
              } as ProviderTestResult,
            });
            return;
          }
          if (!message.apiKey || message.apiKey.length < 10) {
            ctx.webview.webview.postMessage({
              command: "onboarding-test-result",
              data: {
                provider: message.provider,
                success: false,
                latencyMs: 0,
                error: "Invalid key format",
              } as ProviderTestResult,
            });
            return;
          }
          await svc.saveProviderConfig(message.provider, message.apiKey);
          ctx.webview.webview.postMessage({
            command: "onboarding-providers-updated",
            providers: svc.getProviders(),
          });
        } catch (err) {
          ctx.logger.error(
            `OnboardingHandler store key failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        break;
      }

      case "onboarding-test-provider": {
        try {
          const result: ProviderTestResult = await svc.testProvider(
            message.provider,
          );
          ctx.webview.webview.postMessage({
            command: "onboarding-test-result",
            data: result,
          });
        } catch (err) {
          ctx.webview.webview.postMessage({
            command: "onboarding-test-result",
            data: {
              provider: message.provider,
              success: false,
              latencyMs: 0,
              error: err instanceof Error ? err.message : "Test failed",
            } as ProviderTestResult,
          });
        }
        break;
      }

      case "onboarding-detect-project": {
        try {
          const projectInfo = await svc.detectProjectInfo();
          const suggestedTasks = svc.getSuggestedTasks(projectInfo);
          ctx.webview.webview.postMessage({
            command: "onboarding-project-detected",
            projectInfo,
            suggestedTasks,
          });
        } catch (err) {
          ctx.logger.error(
            `OnboardingHandler project detection failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        break;
      }

      case "onboarding-skip":
      case "onboarding-dismiss": {
        await svc.complete();
        ctx.webview.webview.postMessage({
          command: "onboarding-completed",
        });
        break;
      }
    }
  }
}
