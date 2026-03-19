/**
 * Sanitize a text string coming from untrusted sources (e.g. LLM output).
 * Strips HTML angle-brackets and enforces max length.
 */
export function sanitizeText(input: unknown, maxLength = 500): string {
  if (typeof input !== "string") return "";
  return input
    .slice(0, maxLength)
    .replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"))
    .trim();
}
