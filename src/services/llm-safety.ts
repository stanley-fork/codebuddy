/**
 * Shared LLM output sanitization — single source of truth for injection patterns.
 * Used by EnhancedPromptBuilderService (ask mode) and LangChainTeamGraphTool (agent mode).
 */

/** Patterns to redact from text before it reaches an LLM prompt or agent context. */
export const INJECTION_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Direct instruction override
  [/ignore\s+(previous|all|prior)\s+instructions?/gi, "[REDACTED]"],
  [/disregard\s+(all\s+)?previous/gi, "[REDACTED]"],
  [/forget\s+(everything|all|prior)/gi, "[REDACTED]"],
  // Role/persona hijacking
  [/you\s+are\s+now\s+/gi, "[REDACTED]"],
  [/act\s+as\s+(a\s+)?(?:jailbreak|DAN|evil|unrestricted)/gi, "[REDACTED]"],
  [/pretend\s+(you\s+are|to\s+be)/gi, "[REDACTED]"],
  // Special tokens (model-specific)
  [/\[INST\]/gi, "[REDACTED]"],
  [/\[\/INST\]/gi, "[REDACTED]"],
  [/<\|im_start\|>/gi, "[REDACTED]"],
  [/<\|im_end\|>/gi, "[REDACTED]"],
  [/<>/gi, "[REDACTED]"],
  // Structural markers that could confuse prompt parsing
  [/system\s*:/gi, "[REDACTED]"],
  [/assistant\s*:/gi, "[REDACTED]"],
  [/human\s*:/gi, "[REDACTED]"],
  [
    /<\/?(?:system|assistant|human|prompt|context|instruction)>/gi,
    "[REDACTED]",
  ],
];

/**
 * Sanitize text before it reaches an LLM.
 * Applies Unicode normalization + injection pattern redaction + hard char cap.
 */
export function sanitizeForLLM(raw: string, maxChars = 8_000): string {
  let sanitized = raw.normalize("NFKC");
  for (const [pattern, replacement] of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized.slice(0, maxChars);
}
