/**
 * ProxyContext — a narrow interface that decouples utility functions
 * (e.g. getAPIKeyAndModel) from the CredentialProxyService singleton.
 *
 * The context is set once on startup by extension.ts, and consumed by
 * utils.ts without importing or calling getInstance().
 */

import { SESSION_TOKEN_HEADER } from "./credential-proxy.service";

export interface ProxyContext {
  isRunning(): boolean;
  getProxyUrl(provider: string): string;
  getSessionToken(): string;
}

let currentContext: ProxyContext | undefined;

/** Set by extension.ts after proxy.start() — wired once per activation. */
export function setProxyContext(ctx: ProxyContext): void {
  currentContext = ctx;
}

/** Consumed by utils.ts — returns undefined when proxy is not active. */
export function getProxyContext(): ProxyContext | undefined {
  return currentContext;
}

/** Clear proxy context (e.g. on deactivation or dispose). */
export function clearProxyContext(): void {
  currentContext = undefined;
}

/**
 * Build default headers map for proxy session token.
 * Returns undefined when the proxy is not active or token is absent.
 */
export function buildProxyHeaders(
  token?: string,
): Record<string, string> | undefined {
  return token ? { [SESSION_TOKEN_HEADER]: token } : undefined;
}
