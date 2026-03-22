import { z } from "zod";
import { Logger, LogLevel } from "../../../infrastructure/logger/logger";
import { BrowserTool } from "../../../tools/tools";
import { BROWSER_ACTIONS } from "../../../tools/browser-actions";
import { StructuredTool } from "@langchain/core/tools";

const browserSchema = z.object({
  action: z.enum(BROWSER_ACTIONS).describe("The browser action to perform."),
  url: z.string().optional().describe("URL for navigate/tab_new actions."),
  ref: z
    .string()
    .optional()
    .describe(
      "Element reference from a previous snapshot (for click, type, hover, select_option).",
    ),
  text: z.string().optional().describe("Text to type (for type action)."),
  value: z
    .string()
    .optional()
    .describe("Value to select (for select_option action)."),
  expression: z
    .string()
    .optional()
    .describe("JavaScript expression to evaluate in the page context."),
  key: z
    .string()
    .optional()
    .describe(
      "Key to press (for press_key action, e.g. 'Enter', 'Tab', 'ArrowDown').",
    ),
  time: z
    .number()
    .optional()
    .describe("Time to wait in ms (for wait action, default 2000)."),
});

type BrowserToolInput = z.infer<typeof browserSchema>;

// StructuredTool<any> is intentional — StructuredTool<typeof browserSchema>
// triggers TS2589 ("Type instantiation is excessively deep"). All tools
// in this codebase use <any> for the same reason.
export class LangChainBrowserTool extends StructuredTool<any> {
  private readonly logger: Logger;
  constructor(private readonly toolInstance: BrowserTool) {
    super();
    this.logger = Logger.initialize("LangChainBrowserTool", {
      minLevel: LogLevel.DEBUG,
      enableConsole: true,
      enableFile: true,
      enableTelemetry: true,
    });
  }

  name = "browser";
  description =
    "Control a headless browser via Playwright. Navigate pages, click elements, type text, take screenshots, read page snapshots (accessibility tree), and execute JavaScript. " +
    "Workflow: 1) navigate to a URL, 2) snapshot to see the page structure and element refs, 3) interact using refs from the snapshot.";

  schema = browserSchema;

  async _call(input: BrowserToolInput): Promise<string> {
    this.logger.info(
      `Executing tool: ${this.name} with action: ${input.action}`,
    );
    try {
      const result = await this.toolInstance.execute(input);
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error in tool ${this.name}: ${message}`, { input });
      return `Error: ${message}`;
    }
  }
}
