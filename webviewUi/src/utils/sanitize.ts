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

/**
 * Sanitize a ticket/MR ID — allow only alphanumeric + common separators.
 * This is stricter than sanitizeText because IDs should never contain HTML.
 */
export function sanitizeTicketId(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.replace(/[^a-zA-Z0-9\-_]/g, "").slice(0, 30);
}
