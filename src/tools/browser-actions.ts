/**
 * Single source of truth for all browser automation actions.
 * Used by BrowserTool (Gemini schema), LangChainBrowserTool (zod schema),
 * and the BrowserAction TypeScript type.
 */
export const BROWSER_ACTIONS = [
  "navigate",
  "click",
  "type",
  "screenshot",
  "snapshot",
  "evaluate",
  "hover",
  "select_option",
  "press_key",
  "go_back",
  "go_forward",
  "wait",
  "tab_list",
  "tab_new",
  "tab_close",
] as const;

export type BrowserAction = (typeof BROWSER_ACTIONS)[number];
