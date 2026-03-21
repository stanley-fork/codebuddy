import * as vscode from "vscode";
import { Orchestrator } from "../orchestrator";
import {
  IFileToolConfig,
  IFileToolResponse,
} from "../application/interfaces/agent.interface";
import { Logger } from "../infrastructure/logger/logger";
import { getAPIKeyAndModel, getGenerativeAiModel } from "./../utils/utils";
import { EmbeddingService } from "./embedding";
import { LogLevel } from "./telemetry";
import { WebSearchService } from "./web-search-service";
import {
  TavilySearchProvider,
  SearchResponseFormatter,
} from "../agents/tools/websearch";
import { SqliteVectorStore } from "./sqlite-vector-store";
import {
  HybridSearchService,
  type HybridSearchResult,
  type HybridSearchConfig,
} from "../memory/hybrid-search.service";

interface SearchResult {
  document: { filePath: string; text: string };
  score: number;
}

function toSearchResult(r: HybridSearchResult): SearchResult {
  return {
    document: { filePath: r.filePath, text: r.snippet },
    score: r.score,
  };
}

/** Minimal shape for legacy vector store search results. */
interface LegacySearchResult {
  document?: { filePath?: string; text?: string };
  filePath?: string;
  text?: string;
  score?: number;
}

export class ContextRetriever implements vscode.Disposable {
  private readonly embeddingService: EmbeddingService;
  private static readonly SEARCH_RESULT_COUNT = 5;
  private readonly logger: Logger;
  private static instance: ContextRetriever;
  private readonly webSearchService: WebSearchService;
  protected readonly orchestrator: Orchestrator;
  private readonly tavilySearch: TavilySearchProvider;
  private vectorStore: SqliteVectorStore;
  private hybridSearchConfig: HybridSearchConfig;
  private readonly configChangeDisposable: vscode.Disposable;

  constructor(context?: vscode.ExtensionContext) {
    const provider = getGenerativeAiModel() || "Gemini";
    const { apiKey, baseUrl } = getAPIKeyAndModel(provider);

    this.embeddingService = new EmbeddingService({
      apiKey,
      provider,
      baseUrl,
    });

    this.logger = Logger.initialize("ContextRetriever", {
      minLevel: LogLevel.DEBUG,
      enableConsole: true,
      enableFile: true,
      enableTelemetry: true,
    });
    this.webSearchService = WebSearchService.getInstance();
    this.tavilySearch = TavilySearchProvider.getInstance();
    this.orchestrator = Orchestrator.getInstance();

    // Use the shared singleton vector store
    this.vectorStore = SqliteVectorStore.getInstance();
    if (context) {
      this.vectorStore.initialize(context).catch((err) => {
        this.logger.error("Failed to initialize vector store", err);
      });
    }

    // Cache hybrid search config; refresh on settings change
    this.hybridSearchConfig = this.readHybridSearchConfig();
    this.configChangeDisposable = vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration("codebuddy.hybridSearch")) {
          this.hybridSearchConfig = this.readHybridSearchConfig();
          this.logger.info("Hybrid search config reloaded");
        }
      },
    );
  }

  private static disposed = false;

  static initialize(context?: vscode.ExtensionContext) {
    if (ContextRetriever.instance && !ContextRetriever.disposed) {
      return ContextRetriever.instance;
    }
    ContextRetriever.instance = new ContextRetriever(context);
    ContextRetriever.disposed = false;
    return ContextRetriever.instance;
  }

  dispose(): void {
    this.configChangeDisposable.dispose();
    ContextRetriever.disposed = true;
  }

  async retrieveContext(input: string): Promise<string> {
    if (!this.vectorStore.isReady) {
      return "Semantic search is not available (Vector Store not initialized).";
    }

    const hybridSearch = HybridSearchService.getInstance();
    let results: SearchResult[] = [];
    let searchMethod = "Hybrid";
    const hybridConfig = this.hybridSearchConfig;

    // ── Try hybrid search (vector + FTS4) ─────────────────────────────
    if (hybridSearch.isReady) {
      try {
        this.logger.info(`Running hybrid search for: ${input}`);
        const embedding = await this.embeddingService.generateEmbedding(input);

        const hybridResults = await hybridSearch.search(
          embedding,
          input,
          hybridConfig,
        );

        results = hybridResults.map(toSearchResult);
        searchMethod = "Hybrid (Vector + BM25)";
      } catch (error: unknown) {
        this.logger.warn(
          "Hybrid vector search failed, trying keyword-only",
          error,
        );

        // Fall back to FTS4 keyword-only search
        try {
          const keywordResults = hybridSearch.keywordOnlySearch(
            input,
            hybridConfig,
          );
          results = keywordResults.map(toSearchResult);
          searchMethod = "BM25 Keyword";
        } catch (ftsError: unknown) {
          this.logger.warn("FTS4 search also failed", ftsError);
        }
      }
    }

    // ── Legacy fallback (hybrid returned nothing or was never attempted) ──
    if (results.length === 0) {
      try {
        this.logger.info(
          "No hybrid results; falling back to legacy vector search",
        );
        const embedding = await this.embeddingService.generateEmbedding(input);
        const legacyResults = await this.vectorStore.search(
          embedding,
          ContextRetriever.SEARCH_RESULT_COUNT,
        );
        results = legacyResults.map((r) => ({
          document: { filePath: r.document.filePath, text: r.document.text },
          score: r.score,
        }));
        searchMethod = "Semantic (Legacy Fallback)";
      } catch (error: unknown) {
        this.logger.warn(
          "Legacy vector search also failed, falling back to keyword search",
          error,
        );
        searchMethod = "Keyword (Fallback)";
        const kwResults = await this.vectorStore.keywordSearch(
          input,
          ContextRetriever.SEARCH_RESULT_COUNT,
        );
        results = kwResults.map((r: LegacySearchResult) => ({
          document: {
            filePath: r.document?.filePath ?? r.filePath ?? "",
            text: r.document?.text ?? r.text ?? "",
          },
          score: r.score ?? 0,
        }));
      }
    }

    // Check if query is general/architectural
    const isGeneralQuery = this.isGeneralQuery(input);

    // Determine if we should include common files:
    // 1. If semantic search failed (fallback)
    // 2. If it's a general query about the application
    if (results.length === 0 || isGeneralQuery) {
      this.logger.info(
        `Retrieving common files. Reason: ${results.length === 0 ? "Fallback (No results)" : "General Query"}`,
      );
      const commonFilesResults = await this.retrieveCommonFiles();

      // If it was a general query, append common files to existing results
      // If it was a fallback, we just use common files (and any keyword matches if we had them)
      results = [
        ...results,
        ...commonFilesResults.map(
          (r: LegacySearchResult) =>
            ({
              document: {
                filePath: r.document?.filePath ?? "",
                text: r.document?.text ?? "",
              },
              score: r.score ?? 0,
            }) as SearchResult,
        ),
      ];

      if (results.length === 0 && searchMethod.includes("Fallback")) {
        searchMethod = "Keyword (Fallback) + Common Files";
      } else if (isGeneralQuery) {
        searchMethod += " + Common Files";
      }
    }

    // Deduplicate by file path
    const seenPaths = new Set();
    results = results.filter((r) => {
      const filePath = r.document.filePath;
      if (!filePath || seenPaths.has(filePath)) return false;
      seenPaths.add(filePath);
      return true;
    });

    // Limit results
    results = results.slice(0, 15);

    if (results.length === 0) {
      return `No relevant context found in the knowledge base using ${searchMethod} search.`;
    }

    return results
      .map(
        (r) =>
          `File: ${r.document.filePath}\nRelevance: ${r.score.toFixed(2)} (${searchMethod})\nContent:\n${r.document.text}`,
      )
      .join("\n\n---\n\n");
  }

  private isGeneralQuery(input: string): boolean {
    const generalKeywords = [
      "overview",
      "architecture",
      "structure",
      "stack",
      "codebase",
      "project",
      "scaffold",
      "how does the app work",
    ];

    const lowerInput = input.toLowerCase();
    return generalKeywords.some((keyword) => lowerInput.includes(keyword));
  }

  /**
   * Read hybrid search settings from VS Code configuration.
   */
  private readHybridSearchConfig(): HybridSearchConfig {
    const clamp = (v: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, v));
    const config = vscode.workspace.getConfiguration("codebuddy.hybridSearch");
    return {
      vectorWeight: clamp(config.get<number>("vectorWeight", 0.7), 0, 1),
      textWeight: clamp(config.get<number>("textWeight", 0.3), 0, 1),
      topK: clamp(config.get<number>("topK", 10), 1, 100),
      mmr: {
        enabled: config.get<boolean>("mmr.enabled", false),
        lambda: clamp(config.get<number>("mmr.lambda", 0.7), 0, 1),
      },
      temporalDecay: {
        enabled: config.get<boolean>("temporalDecay.enabled", false),
        halfLifeDays: clamp(
          config.get<number>("temporalDecay.halfLifeDays", 30),
          1,
          365,
        ),
      },
    };
  }

  private async retrieveCommonFiles(): Promise<any[]> {
    const commonFiles = [
      "README.md",
      "readme.md",
      "package.json",
      "CONTRIBUTING.md",
      "docs/README.md",
      "docs/architecture.md", // Added potential architecture doc
    ];

    const results: any[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders) {
      this.logger.warn("No workspace folders found for common file retrieval.");
      return [];
    }

    for (const folder of workspaceFolders) {
      for (const fileName of commonFiles) {
        try {
          // Construct URI directly instead of using findFiles
          const fileUri = vscode.Uri.joinPath(folder.uri, fileName);

          // Try to read file attributes to confirm existence (and strict case matching if filesystem is sensitive)
          // But readDirectory or just readFile is easier.
          // We'll just try to read it. If it fails (FileNotFound), we catch it.

          let content = "";
          try {
            const fileContent = await vscode.workspace.fs.readFile(fileUri);
            content = Buffer.from(fileContent).toString("utf-8");
          } catch (e) {
            // File doesn't exist or other error
            continue;
          }

          if (content) {
            // Truncate if too long (e.g., 5KB)
            const truncated =
              content.length > 5000
                ? content.substring(0, 5000) + "\n...(truncated)"
                : content;

            results.push({
              document: {
                id: `common:${fileUri.fsPath}`,
                text: truncated,
                metadata: { filePath: fileUri.fsPath },
              },
              score: 1.0, // High relevance for common files
            });

            this.logger.info(`Successfully retrieved common file: ${fileName}`);
          }
        } catch (error) {
          this.logger.warn(
            `Unexpected error retrieving common file ${fileName}`,
            error,
          );
        }
      }
    }

    return results;
  }

  async readFiles(
    fileConfigs: IFileToolConfig[],
  ): Promise<IFileToolResponse[]> {
    const files = fileConfigs.flatMap((file) => file);
    const promises = files.map(async (file) => {
      try {
        if (file.file_path) {
          const content = await this.readFileContent(file.file_path);
          const response: IFileToolResponse = {
            content,
            function: file.function_name,
          };
          return response;
        }
      } catch (error: any) {
        this.logger.error(`Error reading file ${file.file_path}:`, error);
        throw new Error(`Error reading file ${file.file_path}: ${error}`);
      }
    });
    const results = await Promise.all(promises);
    return results.filter(
      (result): result is IFileToolResponse => result !== undefined,
    );
  }

  async readFileContent(filePath: string): Promise<string> {
    try {
      const uri = vscode.Uri.file(filePath);
      const fileContent = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(fileContent).toString("utf-8");
    } catch (error: any) {
      this.logger.error("Error reading file:", error);
      throw error;
    }
  }

  async webSearch(query: string) {
    try {
      const text = Array.isArray(query) ? query.join("") : query;
      return await this.webSearchService.run(text);
    } catch (error: any) {
      this.logger.error("Error reading file:", error);
      throw error;
    }
  }

  async travilySearch(query: string) {
    const defaults = {
      maxResults: 5,
      includeRawContent: false,
      timeout: 30000,
    };
    try {
      const result = await this.tavilySearch.search(query, defaults);

      // Fallback if Tavily key is missing/invalid
      if (
        result.results.length === 0 &&
        result.answer &&
        result.answer.includes("Tavily API key is missing")
      ) {
        this.logger.warn(
          "Tavily API key missing, falling back to WebSearchService (Startpage)",
        );
        try {
          const webResult = await this.webSearchService.run(query);
          if (
            typeof webResult === "string" &&
            webResult.length > 0 &&
            !webResult.includes("No web results found") &&
            !webResult.includes("Query too short")
          ) {
            return `(Fallback Results from Startpage - Please configure 'tavily.apiKey' for better results)\n\n${webResult}`;
          }
        } catch (fallbackError) {
          this.logger.error("Fallback search failed", fallbackError);
        }
      }

      return SearchResponseFormatter.format(result);
    } catch (error: any) {
      this.logger.error("[WebSearch] Execution Error:", error);

      // Fallback on error
      try {
        const webResult = await this.webSearchService.run(query);
        if (
          typeof webResult === "string" &&
          webResult.length > 0 &&
          !webResult.includes("No web results found")
        ) {
          return `(Fallback Results from Startpage - Error: ${error.message})\n\n${webResult}`;
        }
      } catch (fallbackError) {
        this.logger.error("Fallback search failed", fallbackError);
      }

      return `Error performing web search: ${error.message}`;
    }
  }
}
