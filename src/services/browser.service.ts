/**
 * BrowserService — Agent-facing browser automation built on the MCP Playwright layer.
 *
 * Wraps MCPService.callTool() calls to the "playwright" MCP server, adding:
 *  - SSRF validation via NavigationGuard on every navigation
 *  - Typed action methods that map to browser_* MCP tools
 *  - Structured result parsing (text + image content)
 *  - Timeout protection on all MCP calls
 *  - Audit logging for security-sensitive operations (evaluate)
 *
 * The Playwright MCP server is started on-demand by MCPService (stdio transport).
 */
import { Logger, LogLevel } from "../infrastructure/logger/logger";
import { MCPService } from "../MCP/service";
import { MCPToolResult } from "../MCP/types";
import { assertNavigationAllowed } from "./navigation-guard";

const MCP_SERVER = "playwright";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_EXPRESSION_LENGTH = 4096;
const MIN_WAIT_MS = 0;
const MAX_WAIT_MS = 30_000;

export interface BrowserActionResult {
  success: boolean;
  content: string;
  imageData?: { base64: string; mimeType: string };
}

/**
 * Race an MCP call against a timeout.
 * Prevents indefinite hangs when the Playwright MCP server is unresponsive.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`Browser action timed out after ${ms}ms: ${label}`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Parse an MCPToolResult into a BrowserActionResult.
 */
function parseResult(result: MCPToolResult): BrowserActionResult {
  if (result.isError) {
    const text = result.content
      .map((c) => c.text ?? JSON.stringify(c))
      .join("\n");
    return { success: false, content: text || "Unknown MCP error" };
  }

  let text = "";
  let imageData: { base64: string; mimeType: string } | undefined;

  for (const entry of result.content) {
    if (entry.type === "image" && entry.data && entry.mimeType) {
      imageData = { base64: entry.data, mimeType: entry.mimeType };
    } else if (entry.text) {
      text += (text ? "\n" : "") + entry.text;
    } else {
      text += (text ? "\n" : "") + JSON.stringify(entry);
    }
  }

  return { success: true, content: text || "(empty response)", imageData };
}

export class BrowserService {
  private static instance: BrowserService | null = null;
  private readonly mcp: MCPService;
  private readonly logger: Logger;

  private constructor(mcp?: MCPService, logger?: Logger) {
    this.mcp = mcp ?? MCPService.getInstance();
    this.logger =
      logger ??
      Logger.initialize("BrowserService", {
        minLevel: LogLevel.DEBUG,
        enableConsole: true,
        enableFile: true,
        enableTelemetry: true,
      });
  }

  static getInstance(): BrowserService {
    if (!BrowserService.instance) {
      BrowserService.instance = new BrowserService();
    }
    return BrowserService.instance;
  }

  /** For testing — bypasses the singleton cache. */
  static createForTest(mcp: MCPService, logger?: Logger): BrowserService {
    return new BrowserService(mcp, logger);
  }

  // ── Core Actions ────────────────────────────────────────────────────────

  async navigate(url: string): Promise<BrowserActionResult> {
    const safeUrl = assertNavigationAllowed(url);
    this.logger.info(`browser_navigate → ${safeUrl}`);
    const result = await withTimeout(
      this.mcp.callTool("browser_navigate", { url: safeUrl }, MCP_SERVER),
      DEFAULT_TIMEOUT_MS,
      "navigate",
    );
    return parseResult(result);
  }

  async click(ref: string): Promise<BrowserActionResult> {
    this.logger.info(`browser_click → ref=${ref}`);
    const result = await withTimeout(
      this.mcp.callTool("browser_click", { ref }, MCP_SERVER),
      DEFAULT_TIMEOUT_MS,
      "click",
    );
    return parseResult(result);
  }

  async type(ref: string, text: string): Promise<BrowserActionResult> {
    this.logger.info(`browser_type → ref=${ref}`);
    const result = await withTimeout(
      this.mcp.callTool("browser_type", { ref, text }, MCP_SERVER),
      DEFAULT_TIMEOUT_MS,
      "type",
    );
    return parseResult(result);
  }

  async selectOption(ref: string, value: string): Promise<BrowserActionResult> {
    this.logger.info(`browser_select_option → ref=${ref}`);
    const result = await withTimeout(
      this.mcp.callTool(
        "browser_select_option",
        { ref, values: [value] },
        MCP_SERVER,
      ),
      DEFAULT_TIMEOUT_MS,
      "select_option",
    );
    return parseResult(result);
  }

  async hover(ref: string): Promise<BrowserActionResult> {
    this.logger.info(`browser_hover → ref=${ref}`);
    const result = await withTimeout(
      this.mcp.callTool("browser_hover", { ref }, MCP_SERVER),
      DEFAULT_TIMEOUT_MS,
      "hover",
    );
    return parseResult(result);
  }

  async pressKey(key: string): Promise<BrowserActionResult> {
    this.logger.info(`browser_press_key → ${key}`);
    const result = await withTimeout(
      this.mcp.callTool("browser_press_key", { key }, MCP_SERVER),
      DEFAULT_TIMEOUT_MS,
      "press_key",
    );
    return parseResult(result);
  }

  async screenshot(): Promise<BrowserActionResult> {
    this.logger.info("browser_screenshot");
    const result = await withTimeout(
      this.mcp.callTool("browser_screenshot", {}, MCP_SERVER),
      DEFAULT_TIMEOUT_MS,
      "screenshot",
    );
    return parseResult(result);
  }

  async snapshot(): Promise<BrowserActionResult> {
    this.logger.info("browser_snapshot");
    const result = await withTimeout(
      this.mcp.callTool("browser_snapshot", {}, MCP_SERVER),
      DEFAULT_TIMEOUT_MS,
      "snapshot",
    );
    return parseResult(result);
  }

  async evaluate(expression: string): Promise<BrowserActionResult> {
    if (expression.length > MAX_EXPRESSION_LENGTH) {
      return {
        success: false,
        content: `Error: expression exceeds maximum length (${MAX_EXPRESSION_LENGTH} chars).`,
      };
    }

    // Audit log — security-critical operation
    this.logger.warn(
      `browser_evaluate — expression length=${expression.length}`,
      {
        expressionPreview: expression.slice(0, 120),
      },
    );

    const result = await withTimeout(
      this.mcp.callTool("browser_evaluate", { expression }, MCP_SERVER),
      DEFAULT_TIMEOUT_MS,
      "evaluate",
    );
    return parseResult(result);
  }

  async goBack(): Promise<BrowserActionResult> {
    this.logger.info("browser_go_back");
    const result = await withTimeout(
      this.mcp.callTool("browser_go_back", {}, MCP_SERVER),
      DEFAULT_TIMEOUT_MS,
      "go_back",
    );
    return parseResult(result);
  }

  async goForward(): Promise<BrowserActionResult> {
    this.logger.info("browser_go_forward");
    const result = await withTimeout(
      this.mcp.callTool("browser_go_forward", {}, MCP_SERVER),
      DEFAULT_TIMEOUT_MS,
      "go_forward",
    );
    return parseResult(result);
  }

  async wait(time: number): Promise<BrowserActionResult> {
    if (!Number.isFinite(time) || time < MIN_WAIT_MS) {
      return {
        success: false,
        content: `Error: wait time must be a finite number >= ${MIN_WAIT_MS}ms.`,
      };
    }
    const clampedTime = Math.min(time, MAX_WAIT_MS);
    if (clampedTime !== time) {
      this.logger.warn(`browser_wait: clamped ${time}ms to ${MAX_WAIT_MS}ms`);
    }
    this.logger.info(`browser_wait → ${clampedTime}ms`);
    const result = await withTimeout(
      this.mcp.callTool("browser_wait", { time: clampedTime }, MCP_SERVER),
      DEFAULT_TIMEOUT_MS,
      "wait",
    );
    return parseResult(result);
  }

  async tabList(): Promise<BrowserActionResult> {
    this.logger.info("browser_tab_list");
    const result = await withTimeout(
      this.mcp.callTool("browser_tab_list", {}, MCP_SERVER),
      DEFAULT_TIMEOUT_MS,
      "tab_list",
    );
    return parseResult(result);
  }

  async tabNew(url?: string): Promise<BrowserActionResult> {
    if (url) {
      const safeUrl = assertNavigationAllowed(url);
      this.logger.info(`browser_tab_new → ${safeUrl}`);
      const result = await withTimeout(
        this.mcp.callTool("browser_tab_new", { url: safeUrl }, MCP_SERVER),
        DEFAULT_TIMEOUT_MS,
        "tab_new",
      );
      return parseResult(result);
    }
    this.logger.info("browser_tab_new (blank)");
    const result = await withTimeout(
      this.mcp.callTool("browser_tab_new", {}, MCP_SERVER),
      DEFAULT_TIMEOUT_MS,
      "tab_new",
    );
    return parseResult(result);
  }

  async tabClose(): Promise<BrowserActionResult> {
    this.logger.info("browser_tab_close");
    const result = await withTimeout(
      this.mcp.callTool("browser_tab_close", {}, MCP_SERVER),
      DEFAULT_TIMEOUT_MS,
      "tab_close",
    );
    return parseResult(result);
  }
}
