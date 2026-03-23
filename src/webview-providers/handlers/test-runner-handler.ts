import { WebviewMessageHandler, HandlerContext } from "./types";
import {
  TestRunnerService,
  TestResult,
} from "../../services/test-runner.service";

const TEST_COMMANDS = ["test-run"] as const;

function isTestMessage(msg: unknown): msg is {
  command: (typeof TEST_COMMANDS)[number];
  testPath?: string;
  testName?: string;
} {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "command" in msg &&
    typeof (msg as Record<string, unknown>).command === "string" &&
    TEST_COMMANDS.includes(
      (msg as Record<string, unknown>)
        .command as (typeof TEST_COMMANDS)[number],
    )
  );
}

export class TestRunnerHandler implements WebviewMessageHandler {
  readonly commands = [...TEST_COMMANDS];

  async handle(
    message: Record<string, unknown>,
    ctx: HandlerContext,
  ): Promise<void> {
    if (!isTestMessage(message)) return;

    const service = TestRunnerService.getInstance();

    // Let the webview know tests are starting
    await ctx.webview.webview.postMessage({
      type: "test-run-started",
    });

    try {
      const result: TestResult = await service.runTests(
        typeof message.testPath === "string" ? message.testPath : undefined,
        typeof message.testName === "string" ? message.testName : undefined,
      );

      await ctx.webview.webview.postMessage({
        type: "test-run-result",
        result: {
          framework: result.framework,
          command: result.command,
          passed: result.passed,
          failed: result.failed,
          skipped: result.skipped,
          total: result.total,
          duration: result.duration,
          success: result.success,
          failures: result.failures,
          parseWarning: result.parseWarning ?? null,
        },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Test run failed";

      // Attempt partial parsing from timeout output
      const timeoutMatch = errMsg.match(
        /^Test command timed out after [\d.]+s\. Output so far:\n([\s\S]+)$/,
      );
      if (timeoutMatch) {
        const partialOutput = timeoutMatch[1];
        const partial = service.parseOutput(
          partialOutput,
          "unknown",
          "timed-out",
        );

        if (partial.total > 0 || partial.failures.length > 0) {
          await ctx.webview.webview.postMessage({
            type: "test-run-result",
            result: {
              framework: partial.framework,
              command: partial.command,
              passed: partial.passed,
              failed: partial.failed,
              skipped: partial.skipped,
              total: partial.total,
              duration: partial.duration,
              success: false,
              failures: partial.failures,
              parseWarning:
                "Test command timed out. Results shown are partial.",
            },
          });
          return;
        }
      }

      await ctx.webview.webview.postMessage({
        type: "test-run-error",
        error: errMsg,
      });
    }
  }
}
