import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatGroq } from "@langchain/groq";
import { ChatOpenAI } from "@langchain/openai";

export type ChatModel =
  | ChatAnthropic
  | ChatGroq
  | ChatOpenAI
  | ChatGoogleGenerativeAI;

export interface ChatModelOptions {
  provider: string;
  apiKey: string;
  modelName?: string;
  baseUrl?: string;
  proxyDefaultHeaders?: Record<string, string>;
}

/**
 * Shared factory for creating LangChain chat models.
 * Eliminates duplicate switch blocks in agent.ts and codebuddy-agent.service.ts.
 */
export function buildChatModel(opts: ChatModelOptions): ChatModel | undefined {
  const { provider, apiKey, modelName, baseUrl, proxyDefaultHeaders } = opts;

  switch (provider) {
    case "anthropic":
      return new ChatAnthropic({
        anthropicApiKey: apiKey,
        modelName: modelName || "claude-sonnet-4-20250514",
        ...(baseUrl && {
          clientOptions: {
            baseURL: baseUrl,
            ...(proxyDefaultHeaders && {
              defaultHeaders: proxyDefaultHeaders,
            }),
          },
        }),
      });
    case "openai":
      return new ChatOpenAI({
        openAIApiKey: apiKey,
        modelName: modelName || "gpt-4o",
        configuration: baseUrl
          ? {
              baseURL: baseUrl,
              ...(proxyDefaultHeaders && {
                defaultHeaders: proxyDefaultHeaders,
              }),
            }
          : undefined,
      });
    case "groq":
      return new ChatGroq({
        apiKey,
        model: modelName || "llama-3.3-70b-versatile",
      });
    case "gemini":
      return new ChatGoogleGenerativeAI({
        apiKey,
        model: modelName || "gemini-2.0-flash",
      });
    case "deepseek":
      return new ChatOpenAI({
        openAIApiKey: apiKey,
        modelName: modelName || "deepseek-chat",
        configuration: {
          baseURL: baseUrl || "https://api.deepseek.com",
          ...(proxyDefaultHeaders && {
            defaultHeaders: proxyDefaultHeaders,
          }),
        },
      });
    case "qwen":
      return new ChatOpenAI({
        openAIApiKey: apiKey,
        modelName: modelName || "qwen-plus",
        configuration: {
          baseURL:
            baseUrl || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
          ...(proxyDefaultHeaders && {
            defaultHeaders: proxyDefaultHeaders,
          }),
        },
      });
    case "glm":
      return new ChatOpenAI({
        openAIApiKey: apiKey,
        modelName: modelName || "glm-4-plus",
        configuration: {
          baseURL: baseUrl || "https://open.bigmodel.cn/api/paas/v4",
          ...(proxyDefaultHeaders && {
            defaultHeaders: proxyDefaultHeaders,
          }),
        },
      });
    case "local":
      return new ChatOpenAI({
        openAIApiKey: apiKey || "not-needed",
        modelName: modelName || "local-model",
        configuration: {
          baseURL: baseUrl || "http://localhost:11434/v1",
          ...(proxyDefaultHeaders && {
            defaultHeaders: proxyDefaultHeaders,
          }),
        },
      });
    default:
      return undefined;
  }
}
