import { WebviewMessageHandler, HandlerContext } from "./types";
import {
  OnboardingService,
  ONBOARDING_STEPS,
} from "../../services/onboarding.service";
import * as vscode from "vscode";
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
type OnboardingRequestKeyInputMessage = {
  command: "onboarding-request-key-input";
  provider: string;
};
type OnboardingDetectProjectMessage = { command: "onboarding-detect-project" };

type OnboardingMessage =
  | OnboardingHydrateMessage
  | OnboardingStepCompleteMessage
  | OnboardingSkipMessage
  | OnboardingDismissMessage
  | OnboardingTestProviderMessage
  | OnboardingRequestKeyInputMessage
  | OnboardingDetectProjectMessage;

const ONBOARDING_COMMANDS = [
  "onboarding-hydrate",
  "onboarding-step-complete",
  "onboarding-skip",
  "onboarding-dismiss",
  "onboarding-test-provider",
  "onboarding-request-key-input",
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
  completed: boolean;
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

          // Always detect project info so the WelcomeScreen can show it
          const projectInfo = await svc.detectProjectInfo();
          const suggestedTasks = svc.getSuggestedTasks(projectInfo);

          const dto: OnboardingStateDTO = {
            shouldShow,
            completed: !shouldShow,
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
              completed: false,
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
          if (message.step === ONBOARDING_STEPS.PROVIDER) {
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

      case "onboarding-request-key-input": {
        try {
          if (!svc.isValidProviderId(message.provider)) {
            ctx.logger.warn(`Rejected unknown provider: ${message.provider}`);
            return;
          }

          // Use VS Code's secure input box — key NEVER enters the message bus
          const providerName =
            svc.getProviders().find((p) => p.id === message.provider)?.name ??
            message.provider;
          const apiKey = await vscode.window.showInputBox({
            prompt: `Enter your ${providerName} API key`,
            password: true,
            ignoreFocusOut: true,
            validateInput: (v) =>
              v && v.length >= 10 ? null : "Key must be at least 10 characters",
          });

          if (apiKey) {
            await svc.saveProviderConfig(message.provider, apiKey);
            ctx.webview.webview.postMessage({
              command: "onboarding-providers-updated",
              providers: svc.getProviders(),
              savedProvider: message.provider,
            });
          } else {
            // User cancelled — notify webview
            ctx.webview.webview.postMessage({
              command: "onboarding-key-input-cancelled",
              provider: message.provider,
            });
          }
        } catch (err) {
          ctx.logger.error(
            `OnboardingHandler key input failed: ${err instanceof Error ? err.message : String(err)}`,
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
