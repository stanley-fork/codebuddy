import { Logger, LogLevel } from "../infrastructure/logger/logger";
import { getConfigValue } from "../utils/utils";
import * as vscode from "vscode";

/**
 * Context Window Compaction Service
 *
 * Implements staged compaction of conversation history to fit within
 * LLM context windows. Replaces the simple "drop oldest messages" approach
 * with multi-chunk summarization, 3-tier fallback, and safety margins.
 *
 * Architecture:
 * - LangGraph manages message state via checkpoints.
 * - This service is called BEFORE passing messages to the LLM to ensure
 *   the total token count stays within the model's context window.
 * - Summarized messages replace originals, preserving conversational context.
 */

// ── Constants ────────────────────────────────────────────────────────

/** Overhead tokens reserved for the summarization prompt itself. */
export const SUMMARIZATION_OVERHEAD_TOKENS = 4096;

/** Safety margin multiplier applied to all token estimates (20%). */
export const SAFETY_MARGIN = 1.2;

/** Base ratio of context window used per chunk (OpenClaw pattern). */
const BASE_CHUNK_RATIO = 0.4;
const MIN_CHUNK_RATIO = 0.15;

/** Minimum messages required to attempt summarization. */
const MIN_MESSAGES_FOR_SUMMARY = 6;

/** Number of most-recent messages always preserved (never summarized). */
const RECENT_MESSAGES_TO_KEEP = 4;

/** Maximum tokens per summarization chunk to avoid LLM output truncation. */
const MAX_CHUNK_TOKENS = 12_000;

/** Minimum content length (chars) to consider a tool result "large" for stripping. */
const LARGE_CONTENT_THRESHOLD = 200;

/** Default context window fallback when no model or config is found. */
const DEFAULT_CONTEXT_WINDOW = 16_000;

/** Token usage percentage thresholds. */
const WARNING_THRESHOLD = 0.8;
const AUTO_COMPACT_THRESHOLD = 0.9;

/** Maximum character length for a single message sent to the summarization LLM. */
const MAX_SINGLE_MESSAGE_CHARS = 10_000;

/** Role labels for structural wrapping in summarization prompts. */
const ROLE_LABEL: Record<CompactionMessage["role"], string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
  tool: "Tool",
};

// ── Types ────────────────────────────────────────────────────────────

export interface CompactionToolCall {
  id?: string;
  name?: string;
  args?: string | Record<string, unknown>;
  [key: string]: unknown;
}

export interface CompactionMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** Tool call ID, present if role === "tool" */
  tool_call_id?: string;
  /** Tool calls made by the assistant */
  tool_calls?: CompactionToolCall[];
  /** Original timestamp if available */
  timestamp?: number;
  /** Token count cache to avoid recomputation */
  _tokenCount?: number;
}

/** Named constants for compaction tiers — avoids magic number collisions. */
export const CompactionTier = {
  /** No compaction needed. */
  NONE: 0,
  /** Only tool results were stripped. */
  TOOL_STRIP: 1,
  /** Full multi-chunk summarization. */
  MULTI_CHUNK: 2,
  /** Partial summarization (oldest half). */
  PARTIAL: 3,
  /** No LLM — plain description fallback. */
  PLAIN_FALLBACK: 4,
} as const;
export type CompactionTierValue =
  (typeof CompactionTier)[keyof typeof CompactionTier];

export interface CompactionResult {
  messages: CompactionMessage[];
  /** Whether compaction was performed */
  compacted: boolean;
  /** Number of messages before compaction */
  originalCount: number;
  /** Number of messages after compaction */
  finalCount: number;
  /** Estimated tokens before compaction */
  originalTokens: number;
  /** Estimated tokens after compaction */
  finalTokens: number;
  /** Which tier of compaction was used. */
  tier: CompactionTierValue;
  /** Warning level based on token usage */
  warningLevel: "none" | "warning" | "critical";
}

export interface CompactionOptions {
  /** Maximum tokens for the context window (derived from model or config). */
  maxContextTokens: number;
  /** Tokens already consumed by system prompt. */
  systemPromptTokens: number;
  /** Optional: tokens reserved for the expected response. */
  reservedResponseTokens?: number;
}

type SummarizeFn = (text: string) => Promise<string | undefined>;
type TokenCountFn = (text: string) => Promise<number>;

// ── Context Window Parsing ───────────────────────────────────────────

/** Known model context window sizes (tokens). */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  "claude-sonnet-4-20250514": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-opus-20240229": 200_000,
  "claude-3-haiku-20240307": 200_000,
  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_192,
  o1: 200_000,
  "o1-mini": 128_000,
  // Groq
  "llama-3.3-70b-versatile": 128_000,
  "llama-3.1-70b-versatile": 128_000,
  "mixtral-8x7b-32768": 32_768,
  // Gemini
  "gemini-2.0-flash": 1_048_576,
  "gemini-1.5-pro": 2_097_152,
  "gemini-1.5-flash": 1_048_576,
  // DeepSeek
  "deepseek-chat": 64_000,
  "deepseek-coder": 64_000,
  // Qwen
  "qwen-plus": 131_072,
  "qwen-turbo": 131_072,
  // GLM
  "glm-4-plus": 128_000,
};

/**
 * Parse the user-facing context window setting ("4k", "16k", "128k")
 * into a numeric token count.
 */
export function parseContextWindowSetting(setting: string): number {
  const match = setting.match(/^(\d+)k$/i);
  if (match) {
    return parseInt(match[1], 10) * 1000;
  }
  const num = parseInt(setting, 10);
  return isNaN(num) ? 16_000 : num;
}

/**
 * Resolve the effective context window token limit.
 * Priority: user setting > model lookup > default 16k.
 *
 * @param modelName - Optional model name for lookup.
 * @param logger - Optional logger for unknown-model warnings (avoids side effects).
 */
export function resolveContextWindow(
  modelName?: string,
  logger?: Pick<Logger, "warn">,
): number {
  // 1. Check user setting
  const configSetting = getConfigValue("codebuddy.contextWindow") as
    | string
    | undefined;
  if (configSetting) {
    return parseContextWindowSetting(configSetting);
  }

  // 2. Look up by model name
  if (modelName && MODEL_CONTEXT_WINDOWS[modelName]) {
    return MODEL_CONTEXT_WINDOWS[modelName];
  }

  // 3. Default — model not in known list
  if (modelName) {
    logger?.warn(
      `Unknown model "${modelName}" — defaulting to ${DEFAULT_CONTEXT_WINDOW} token context window`,
    );
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// ── Service ──────────────────────────────────────────────────────────

export class ContextWindowCompactionService implements vscode.Disposable {
  private static _instance: ContextWindowCompactionService | undefined;
  private disposed = false;
  private activeOperations = 0;
  private readonly logger: Logger;

  private constructor(
    private readonly summarize: SummarizeFn,
    private readonly countTokens: TokenCountFn,
  ) {
    this.logger = Logger.initialize("ContextWindowCompactionService", {
      minLevel: LogLevel.INFO,
      enableConsole: false,
      enableFile: true,
      enableTelemetry: false,
    });
  }

  /**
   * Create and register a new instance, disposing any existing one first.
   * Optionally register with ExtensionContext.subscriptions for automatic cleanup.
   */
  static createInstance(
    summarize: SummarizeFn,
    countTokens: TokenCountFn,
    context?: vscode.ExtensionContext,
  ): ContextWindowCompactionService {
    // Clean up existing instance before replacing
    ContextWindowCompactionService._instance?.dispose();

    const instance = new ContextWindowCompactionService(summarize, countTokens);
    ContextWindowCompactionService._instance = instance;

    if (context) {
      context.subscriptions.push(instance);
    }

    return instance;
  }

  static getInstance(): ContextWindowCompactionService | undefined {
    const inst = ContextWindowCompactionService._instance;
    return inst?.disposed ? undefined : inst;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    // Wait briefly for in-flight operations before releasing
    const deadline = Date.now() + 5000;
    while (this.activeOperations > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (ContextWindowCompactionService._instance === this) {
      ContextWindowCompactionService._instance = undefined;
    }
    this.logger.info(
      `ContextWindowCompactionService disposed (pending ops: ${this.activeOperations})`,
    );
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Evaluate and compact messages to fit within the context window.
   *
   * Flow:
   * 1. Count tokens for all messages.
   * 2. If within budget → return as-is.
   * 3. Strip tool results from older messages.
   * 4. If still over → multi-chunk summarize (Tier 1).
   * 5. If summarization fails → partial summarize (Tier 2).
   * 6. If all fails → plain description fallback (Tier 3).
   */
  async compact(
    messages: CompactionMessage[],
    options: CompactionOptions,
  ): Promise<CompactionResult> {
    if (this.disposed) {
      throw new Error("ContextWindowCompactionService has been disposed");
    }
    this.activeOperations++;
    try {
      return await this._compactImpl(messages, options);
    } finally {
      this.activeOperations--;
    }
  }

  private async _compactImpl(
    messages: CompactionMessage[],
    options: CompactionOptions,
  ): Promise<CompactionResult> {
    const {
      maxContextTokens,
      systemPromptTokens,
      reservedResponseTokens = 4096,
    } = options;

    // Apply safety margin once to the budget (single source of truth)
    const rawBudget =
      maxContextTokens - systemPromptTokens - reservedResponseTokens;
    const effectiveBudget = Math.floor(rawBudget / SAFETY_MARGIN);

    // Count tokens for each message
    const annotated = await this.annotateTokenCounts(messages);
    const originalTokens = annotated.reduce(
      (sum, m) => sum + (m._tokenCount ?? 0),
      0,
    );

    // Determine warning level (raw ratio, no margin — this is for display)
    const usageRatio = (originalTokens + systemPromptTokens) / maxContextTokens;
    const warningLevel: CompactionResult["warningLevel"] =
      usageRatio >= AUTO_COMPACT_THRESHOLD
        ? "critical"
        : usageRatio >= WARNING_THRESHOLD
          ? "warning"
          : "none";

    // If within budget, return as-is
    if (originalTokens <= effectiveBudget) {
      return {
        messages: annotated,
        compacted: false,
        originalCount: messages.length,
        finalCount: messages.length,
        originalTokens,
        finalTokens: originalTokens,
        tier: CompactionTier.NONE,
        warningLevel,
      };
    }

    this.logger.info(
      `Context window compaction needed: ${originalTokens} tokens > ${effectiveBudget} budget (${messages.length} messages)`,
    );

    // Step 1: Strip tool results from older messages
    const strippedMessages = this.stripOldToolResults(annotated);
    const strippedTokens = await this.totalTokens(strippedMessages);

    if (strippedTokens <= effectiveBudget) {
      this.logger.info(
        `Tool result stripping sufficient: ${originalTokens} → ${strippedTokens} tokens`,
      );
      return {
        messages: strippedMessages,
        compacted: true,
        originalCount: messages.length,
        finalCount: strippedMessages.length,
        originalTokens,
        finalTokens: strippedTokens,
        tier: CompactionTier.TOOL_STRIP,
        warningLevel,
      };
    }

    // Step 2: Multi-chunk summarization (Tier 1)
    try {
      const tier1Result = await this.multiChunkSummarize(
        strippedMessages,
        effectiveBudget,
      );
      if (tier1Result) {
        const finalTokens = await this.totalTokens(tier1Result);
        this.logger.info(
          `Tier 1 (multi-chunk) compaction: ${originalTokens} → ${finalTokens} tokens`,
        );
        return {
          messages: tier1Result,
          compacted: true,
          originalCount: messages.length,
          finalCount: tier1Result.length,
          originalTokens,
          finalTokens,
          tier: CompactionTier.MULTI_CHUNK,
          warningLevel,
        };
      }
    } catch (err) {
      this.logger.warn(
        `Tier 1 compaction failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Step 3: Partial summarization (Tier 2)
    try {
      const tier2Result = await this.partialSummarize(
        strippedMessages,
        effectiveBudget,
      );
      if (tier2Result) {
        const finalTokens = await this.totalTokens(tier2Result);
        this.logger.info(
          `Tier 2 (partial) compaction: ${originalTokens} → ${finalTokens} tokens`,
        );
        return {
          messages: tier2Result,
          compacted: true,
          originalCount: messages.length,
          finalCount: tier2Result.length,
          originalTokens,
          finalTokens,
          tier: CompactionTier.PARTIAL,
          warningLevel,
        };
      }
    } catch (err) {
      this.logger.warn(
        `Tier 2 compaction failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Step 4: Plain description fallback (Tier 3)
    const tier3Result = this.plainDescriptionFallback(
      strippedMessages,
      effectiveBudget,
    );
    const finalTokens = await this.totalTokens(tier3Result);
    this.logger.info(
      `Tier 3 (plain description) fallback: ${originalTokens} → ${finalTokens} tokens`,
    );
    return {
      messages: tier3Result,
      compacted: true,
      originalCount: messages.length,
      finalCount: tier3Result.length,
      originalTokens,
      finalTokens,
      tier: CompactionTier.PLAIN_FALLBACK,
      warningLevel,
    };
  }

  /**
   * Check current token usage against thresholds.
   * Returns warning level without performing compaction.
   */
  async checkUsage(
    messages: CompactionMessage[],
    options: CompactionOptions,
  ): Promise<{
    usageRatio: number;
    totalTokens: number;
    budget: number;
    warningLevel: "none" | "warning" | "critical";
  }> {
    const { maxContextTokens, systemPromptTokens } = options;
    const annotated = await this.annotateTokenCounts(messages);
    const totalTokens = annotated.reduce(
      (sum, m) => sum + (m._tokenCount ?? 0),
      0,
    );
    const usageRatio = (totalTokens + systemPromptTokens) / maxContextTokens;
    const warningLevel: CompactionResult["warningLevel"] =
      usageRatio >= AUTO_COMPACT_THRESHOLD
        ? "critical"
        : usageRatio >= WARNING_THRESHOLD
          ? "warning"
          : "none";
    return {
      usageRatio,
      totalTokens,
      budget: maxContextTokens - systemPromptTokens,
      warningLevel,
    };
  }

  // ── Private: Oversized Message Detection ───────────────────────────

  /**
   * Check if a single message is too large to summarize safely.
   * A message > 50% of context window can't be summarized — it would
   * overflow the summarization prompt.
   */
  private isOversizedForSummary(
    msg: CompactionMessage,
    contextWindow: number,
  ): boolean {
    const tokens = (msg._tokenCount ?? 0) * SAFETY_MARGIN;
    return tokens > contextWindow * 0.5;
  }

  // ── Private: Orphaned Tool Result Repair ────────────────────────────

  /**
   * After dropping messages, tool_result messages may be orphaned (their
   * corresponding assistant tool_call was in the dropped portion).
   * Drop orphaned tool_results to prevent API errors.
   */
  private repairToolResultPairing(
    messages: CompactionMessage[],
  ): CompactionMessage[] {
    // Collect all tool_call IDs from assistant messages
    const knownToolCallIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id) knownToolCallIds.add(tc.id);
        }
      }
    }

    // Drop tool messages whose tool_call_id has no matching assistant
    return messages.filter((msg) => {
      if (msg.role === "tool" && msg.tool_call_id) {
        return knownToolCallIds.has(msg.tool_call_id);
      }
      return true;
    });
  }

  // ── Private: Adaptive Chunk Ratio ──────────────────────────────────

  /**
   * Compute adaptive chunk size based on average message size.
   * When messages are large, use smaller chunks (OpenClaw pattern).
   */
  private computeAdaptiveMaxChunkTokens(
    messages: CompactionMessage[],
    contextWindow: number,
  ): number {
    if (messages.length === 0) return MAX_CHUNK_TOKENS;

    const totalTokens = messages.reduce(
      (sum, m) => sum + (m._tokenCount ?? 0),
      0,
    );
    const avgTokens = totalTokens / messages.length;
    const safeAvgTokens = avgTokens * SAFETY_MARGIN;
    const avgRatio = safeAvgTokens / contextWindow;

    let chunkRatio = BASE_CHUNK_RATIO;
    if (avgRatio > 0.1) {
      const reduction = Math.min(
        avgRatio * 2,
        BASE_CHUNK_RATIO - MIN_CHUNK_RATIO,
      );
      chunkRatio = Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
    }

    return (
      Math.floor(contextWindow * chunkRatio) - SUMMARIZATION_OVERHEAD_TOKENS
    );
  }

  // ── Private: Token Counting ────────────────────────────────────────

  private async annotateTokenCounts(
    messages: CompactionMessage[],
  ): Promise<CompactionMessage[]> {
    return Promise.all(
      messages.map(async (msg) => {
        if (msg._tokenCount !== undefined) return msg;
        const text = this.extractText(msg);
        const count = await this.countTokens(text);
        return { ...msg, _tokenCount: count };
      }),
    );
  }

  private async totalTokens(messages: CompactionMessage[]): Promise<number> {
    const annotated = await this.annotateTokenCounts(messages);
    return annotated.reduce((sum, m) => sum + (m._tokenCount ?? 0), 0);
  }

  private extractText(msg: CompactionMessage): string {
    if (typeof msg.content === "string") {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      return (msg.content as Array<{ type: string; text?: string }>)
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
    }
    return "";
  }

  // ── Private: Tool Result Stripping ─────────────────────────────────

  /**
   * Strip verbose tool results from older messages, replacing them with
   * a brief "[Tool result truncated]" marker. Recent messages are preserved.
   */
  private stripOldToolResults(
    messages: CompactionMessage[],
  ): CompactionMessage[] {
    if (messages.length <= RECENT_MESSAGES_TO_KEEP) return [...messages];

    const cutoff = messages.length - RECENT_MESSAGES_TO_KEEP;
    const result: CompactionMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (
        i < cutoff &&
        msg.role === "tool" &&
        msg.content.length > LARGE_CONTENT_THRESHOLD
      ) {
        // Preserve tool_call_id for message pairing but truncate content
        result.push({
          ...msg,
          content: `[Tool result truncated — originally ${msg.content.length} chars]`,
          _tokenCount: undefined, // recalculate
        });
      } else if (
        i < cutoff &&
        msg.role === "assistant" &&
        msg.tool_calls?.length
      ) {
        // Keep the assistant message but strip large tool call arguments
        const strippedToolCalls = msg.tool_calls.map((tc) => ({
          ...tc,
          args:
            typeof tc.args === "string" &&
            tc.args.length > LARGE_CONTENT_THRESHOLD
              ? "[args truncated]"
              : tc.args,
        }));
        result.push({
          ...msg,
          tool_calls: strippedToolCalls,
          _tokenCount: undefined,
        });
      } else {
        result.push(msg);
      }
    }

    return result;
  }

  // ── Private: Summarization Prompt Builder ──────────────────────────

  /**
   * Build a structurally separated summarization prompt.
   * Uses XML-like tags to isolate user content from instructions,
   * making prompt injection significantly harder. Caps individual
   * message length to prevent token overflow.
   */
  private buildSummarizationPrompt(
    messages: CompactionMessage[],
    instruction: string,
  ): string {
    const structuredMessages = messages
      .map((m) => {
        const label = ROLE_LABEL[m.role];
        let content = this.extractText(m);
        if (content.length > MAX_SINGLE_MESSAGE_CHARS) {
          content =
            content.substring(0, MAX_SINGLE_MESSAGE_CHARS) +
            `\n[... ${content.length - MAX_SINGLE_MESSAGE_CHARS} chars truncated]`;
        }
        return `<message role="${label}">\n${content}\n</message>`;
      })
      .join("\n");

    return [
      instruction,
      "",
      "<conversation>",
      structuredMessages,
      "</conversation>",
    ].join("\n");
  }

  // ── Private: Tier 1 — Multi-Chunk Summarization ────────────────────

  /**
   * Split older messages into token-bounded chunks, summarize each chunk,
   * then merge the chunk summaries into a single context message prepended
   * before the recent messages.
   */
  private async multiChunkSummarize(
    messages: CompactionMessage[],
    budget: number,
  ): Promise<CompactionMessage[] | null> {
    if (messages.length < MIN_MESSAGES_FOR_SUMMARY) return null;

    const cutoff = messages.length - RECENT_MESSAGES_TO_KEEP;
    const toSummarize = messages.slice(0, cutoff);
    const recent = messages.slice(cutoff);

    // Check if there are enough older messages to actually summarize
    if (toSummarize.length < 2) return null;

    // Use adaptive chunk sizing based on message density
    const effectiveContextWindow = budget * SAFETY_MARGIN;
    const adaptiveMaxTokens = this.computeAdaptiveMaxChunkTokens(
      toSummarize,
      effectiveContextWindow,
    );

    // Split into token-bounded chunks
    const chunks = await this.splitByTokenShare(
      toSummarize,
      Math.max(
        adaptiveMaxTokens,
        MAX_CHUNK_TOKENS - SUMMARIZATION_OVERHEAD_TOKENS,
      ),
    );

    // Summarize each chunk, skipping oversized messages
    const chunkSummaries: string[] = [];
    const oversizedNotes: string[] = [];
    for (const chunk of chunks) {
      // Filter out oversized messages, note them separately
      const safeChunk: CompactionMessage[] = [];
      for (const m of chunk) {
        if (this.isOversizedForSummary(m, budget * SAFETY_MARGIN)) {
          const tokens = m._tokenCount ?? 0;
          oversizedNotes.push(
            `[Large ${m.role} message (~${Math.round(tokens / 1000)}K tokens) omitted from summary]`,
          );
        } else {
          safeChunk.push(m);
        }
      }
      if (safeChunk.length === 0) continue;

      const summary = await this.summarize(
        this.buildSummarizationPrompt(
          safeChunk,
          "Summarize this conversation segment concisely. Preserve key decisions, code changes, file paths, and technical context. Output only the summary.",
        ),
      );
      if (!summary) return null; // LLM failure → escalate to Tier 2
      chunkSummaries.push(summary);
    }

    // Merge chunk summaries
    let mergedSummary: string;
    if (chunkSummaries.length === 1) {
      mergedSummary = chunkSummaries[0];
    } else {
      const mergeInput = chunkSummaries
        .map((s, i) => `[Part ${i + 1}]:\n${s}`)
        .join("\n\n");
      const merged = await this.summarize(
        `Merge these conversation summaries into one cohesive summary. Preserve all key details:\n\n${mergeInput}`,
      );
      mergedSummary = merged ?? chunkSummaries.join("\n\n---\n\n");
    }

    // Append oversized message notes
    if (oversizedNotes.length > 0) {
      mergedSummary += "\n\n" + oversizedNotes.join("\n");
    }

    const summaryMessage: CompactionMessage = {
      role: "system",
      content: `[Conversation Summary — ${toSummarize.length} earlier messages compacted]\n\n${mergedSummary}`,
    };

    // Repair orphaned tool_results after dropping older messages
    const repairedRecent = this.repairToolResultPairing(recent);

    const result = [summaryMessage, ...repairedRecent];
    const resultTokens = await this.totalTokens(result);

    // If still over budget after summarization, drop oldest recent messages
    if (resultTokens > budget && result.length > 2) {
      return this.trimToFit(result, budget);
    }

    return result;
  }

  /**
   * Split messages into chunks where each chunk's total tokens ≤ maxTokensPerChunk.
   */
  private async splitByTokenShare(
    messages: CompactionMessage[],
    maxTokensPerChunk: number,
  ): Promise<CompactionMessage[][]> {
    const chunks: CompactionMessage[][] = [];
    let currentChunk: CompactionMessage[] = [];
    let currentTokens = 0;

    for (const msg of messages) {
      const tokens =
        msg._tokenCount ?? (await this.countTokens(this.extractText(msg)));
      if (
        currentTokens + tokens > maxTokensPerChunk &&
        currentChunk.length > 0
      ) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentTokens = 0;
      }
      currentChunk.push(msg);
      currentTokens += tokens;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  // ── Private: Tier 2 — Partial Summarization ────────────────────────

  /**
   * Summarize only the oldest half of messages (cheaper, more likely to succeed).
   * Keeps the newer half + recent messages untouched.
   */
  private async partialSummarize(
    messages: CompactionMessage[],
    budget: number,
  ): Promise<CompactionMessage[] | null> {
    if (messages.length < MIN_MESSAGES_FOR_SUMMARY) return null;

    const cutoff = messages.length - RECENT_MESSAGES_TO_KEEP;
    const toSummarize = messages.slice(0, cutoff);
    const recent = messages.slice(cutoff);

    // Need at least 2 older messages to summarize
    if (toSummarize.length < 2) return null;

    // Only summarize the oldest half
    const halfPoint = Math.floor(toSummarize.length / 2);
    const oldestHalf = toSummarize.slice(0, halfPoint);
    const newerHalf = toSummarize.slice(halfPoint);

    if (oldestHalf.length === 0) return null;

    const summary = await this.summarize(
      this.buildSummarizationPrompt(
        oldestHalf,
        "Briefly summarize this conversation. Keep only essential facts, decisions, and file paths. Output only the summary.",
      ),
    );
    if (!summary) return null;

    const summaryMessage: CompactionMessage = {
      role: "system",
      content: `[Earlier conversation summary — ${oldestHalf.length} messages compacted]\n\n${summary}`,
    };

    // Repair orphaned tool_results in the kept portion
    const repairedNewerHalf = this.repairToolResultPairing(newerHalf);
    const repairedRecent = this.repairToolResultPairing(recent);

    const result = [summaryMessage, ...repairedNewerHalf, ...repairedRecent];
    const resultTokens = await this.totalTokens(result);

    if (resultTokens > budget && result.length > 2) {
      return this.trimToFit(result, budget);
    }

    return result;
  }

  // ── Private: Tier 3 — Plain Description Fallback ───────────────────

  /**
   * No LLM calls. Create a minimal description of what was discussed
   * based on message roles and lengths, then keep only recent messages.
   */
  private plainDescriptionFallback(
    messages: CompactionMessage[],
    budget: number,
  ): CompactionMessage[] {
    const cutoff = Math.max(0, messages.length - RECENT_MESSAGES_TO_KEEP);
    const older = messages.slice(0, cutoff);
    const recent = messages.slice(cutoff);

    if (older.length === 0) return recent;

    // Build a minimal description without LLM
    const userMsgCount = older.filter((m) => m.role === "user").length;
    const assistantMsgCount = older.filter(
      (m) => m.role === "assistant",
    ).length;
    const toolMsgCount = older.filter((m) => m.role === "tool").length;

    // Extract first line of each user message as topic indicators
    const topics = older
      .filter((m) => m.role === "user")
      .map((m) => {
        const firstLine = m.content.split("\n")[0].trim();
        return firstLine.length > 80
          ? firstLine.substring(0, 77) + "..."
          : firstLine;
      })
      .slice(0, 10);

    const description = [
      `[Conversation context — ${older.length} earlier messages removed to fit context window]`,
      `User messages: ${userMsgCount}, Assistant responses: ${assistantMsgCount}, Tool calls: ${toolMsgCount}`,
      topics.length > 0
        ? `Topics discussed:\n${topics.map((t) => `- ${t}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    const descriptionMessage: CompactionMessage = {
      role: "system",
      content: description,
    };

    return [descriptionMessage, ...recent];
  }

  // ── Private: Utilities ─────────────────────────────────────────────

  /**
   * Trim messages from the front (after the first system/summary message)
   * until total tokens fit within budget. O(n) single-pass.
   */
  private async trimToFit(
    messages: CompactionMessage[],
    budget: number,
  ): Promise<CompactionMessage[]> {
    // Ensure all messages are annotated once
    const annotated = await this.annotateTokenCounts(messages);
    let total = annotated.reduce((sum, m) => sum + (m._tokenCount ?? 0), 0);

    // [0] = summary/system message — never remove
    // Remove from index 1 forward until within budget
    const toRemove = new Set<number>();
    let removeIdx = 1;

    while (total > budget && removeIdx < annotated.length - 1) {
      total -= annotated[removeIdx]._tokenCount ?? 0;
      toRemove.add(removeIdx);
      removeIdx++;
    }

    const result = annotated.filter((_, i) => !toRemove.has(i));
    return this.repairToolResultPairing(result);
  }
}
