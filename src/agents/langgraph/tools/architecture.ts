import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { Logger, LogLevel } from "../../../infrastructure/logger/logger";
import { PersistentCodebaseUnderstandingService } from "../../../services/persistent-codebase-understanding.service";
import type {
  ArchitecturalPatternData,
  ArchitectureReportSummary,
  CallGraphSummary,
  CachedAnalysis,
  EndpointData,
  MiddlewareSummary,
  ModelData,
} from "../../../interfaces/analysis.interface";

const logger = Logger.initialize("ArchitectureKnowledgeTool", {
  minLevel: LogLevel.DEBUG,
  enableConsole: true,
  enableFile: true,
  enableTelemetry: true,
});

// ─── Output Limits ───────────────────────────────────────────────

/** Maximum total characters returned to the LLM to prevent context overflow. */
const MAX_OUTPUT_CHARS = 12_000;

/** Maximum number of architectural patterns to include. */
const MAX_PATTERNS = 5;

/** Maximum indicators listed per pattern. */
const MAX_INDICATORS_PER_PATTERN = 5;

/** Maximum entry points shown in overview. */
const MAX_ENTRY_POINTS = 5;

/** Maximum dependency hub nodes from the call graph. */
const MAX_HOT_NODES = 8;

/** Maximum call-graph entry points listed. */
const MAX_GRAPH_ENTRY_POINTS = 8;

/** Maximum circular dependency cycles shown. */
const MAX_CYCLES = 5;

/** Maximum middleware items listed. */
const MAX_MIDDLEWARE = 10;

/** Maximum auth flows listed. */
const MAX_AUTH_FLOWS = 5;

/** Maximum error handler files listed. */
const MAX_ERROR_HANDLER_FILES = 5;

/** Maximum API endpoints listed. */
const MAX_ENDPOINTS = 15;

/** Maximum data models listed. */
const MAX_MODELS = 10;

/** Maximum fields shown per model. */
const MAX_FIELDS_PER_MODEL = 5;

// ─── Section Type ────────────────────────────────────────────────

/** Valid section identifiers for targeted retrieval. */
export type ArchitectureSection =
  | "all"
  | "overview"
  | "patterns"
  | "call-graph"
  | "middleware"
  | "endpoints"
  | "models";

const VALID_SECTIONS: ReadonlySet<ArchitectureSection> = new Set([
  "all",
  "overview",
  "patterns",
  "call-graph",
  "middleware",
  "endpoints",
  "models",
]);

// ─── Input Schema ────────────────────────────────────────────────

const ArchitectureInputSchema = z.object({
  section: z
    .enum([
      "all",
      "overview",
      "patterns",
      "call-graph",
      "middleware",
      "endpoints",
      "models",
    ])
    .default("all")
    .describe(
      "Which section of the architecture knowledge to retrieve. Use 'all' for a complete overview.",
    ),
});

type ArchitectureInput = z.infer<typeof ArchitectureInputSchema>;

// ─── Analysis Subset ─────────────────────────────────────────────

/**
 * Subset of CachedAnalysis fields consumed by the formatter.
 * Using a named type for reuse in tests and documentation.
 */
export interface ArchitectureAnalysisInput {
  architectureReport?: ArchitectureReportSummary;
  callGraphSummary?: CallGraphSummary;
  middlewareSummary?: MiddlewareSummary;
  frameworks?: string[];
  files?: string[];
  apiEndpoints?: EndpointData[];
  dataModels?: ModelData[];
}

// ─── Formatter ───────────────────────────────────────────────────

/**
 * Format the architecture report into a readable markdown summary
 * for consumption by subagents in agent mode.
 *
 * Output is capped at {@link MAX_OUTPUT_CHARS} to prevent context overflow.
 */
export function formatArchitectureContext(
  analysis: ArchitectureAnalysisInput,
  section: ArchitectureSection,
): string {
  const lines: string[] = [];

  const report = analysis.architectureReport;
  const graph = analysis.callGraphSummary;
  const mw = analysis.middlewareSummary;

  if (section === "all" || section === "overview") {
    lines.push("# Codebase Architecture Overview");
    lines.push("");

    if (report) {
      lines.push(`**Project Type**: ${report.projectType}`);
      if (report.entryPoints.length > 0) {
        lines.push(
          `**Entry Points**: ${report.entryPoints.slice(0, MAX_ENTRY_POINTS).join(", ")}`,
        );
      }
      lines.push("");
    }

    if (analysis.frameworks && analysis.frameworks.length > 0) {
      lines.push(
        `**Frameworks & Technologies**: ${analysis.frameworks.join(", ")}`,
      );
      lines.push("");
    }

    if (analysis.files) {
      lines.push(`**Total Files**: ${analysis.files.length}`);
      lines.push("");
    }
  }

  if (section === "all" || section === "patterns") {
    if (report && report.patterns.length > 0) {
      lines.push("## Architectural Patterns");
      lines.push("");
      for (const pattern of report.patterns.slice(0, MAX_PATTERNS)) {
        const pct = Math.round(pattern.confidence * 100);
        lines.push(`### ${pattern.name} (${pct}% confidence)`);
        for (const ind of pattern.indicators.slice(
          0,
          MAX_INDICATORS_PER_PATTERN,
        )) {
          lines.push(`- ${ind}`);
        }
        lines.push("");
      }
    }
  }

  if (section === "all" || section === "call-graph") {
    if (graph && graph.nodeCount > 0) {
      lines.push("## Import Graph");
      lines.push(
        `**${graph.nodeCount} modules**, ${graph.edgeCount} import edges`,
      );
      lines.push("");

      if (graph.hotNodes.length > 0) {
        lines.push("**Most-imported modules** (dependency hubs):");
        for (const node of graph.hotNodes.slice(0, MAX_HOT_NODES)) {
          lines.push(`- ${node}`);
        }
        lines.push("");
      }

      if (graph.entryPoints.length > 0) {
        lines.push(
          `**Entry points** (not imported by others): ${graph.entryPoints.slice(0, MAX_GRAPH_ENTRY_POINTS).join(", ")}`,
        );
        lines.push("");
      }

      if (graph.circularDependencies.length > 0) {
        lines.push(
          `**Circular dependencies** (${graph.circularDependencies.length}):`,
        );
        for (const cycle of graph.circularDependencies.slice(0, MAX_CYCLES)) {
          lines.push(`- ${cycle.join(" → ")}`);
        }
        lines.push("");
      }
    }
  }

  if (section === "all" || section === "middleware") {
    if (mw && (mw.middleware.length > 0 || mw.authStrategies.length > 0)) {
      lines.push("## Middleware & Auth");
      lines.push("");

      if (mw.authStrategies.length > 0) {
        lines.push(`**Auth Strategies**: ${mw.authStrategies.join(", ")}`);
      }

      if (mw.middleware.length > 0) {
        lines.push("");
        lines.push("**Middleware Chain**:");
        for (const m of mw.middleware.slice(0, MAX_MIDDLEWARE)) {
          lines.push(`- ${m.name} (${m.type}) — ${m.file}`);
        }
      }

      if (mw.authFlows.length > 0) {
        lines.push("");
        lines.push("**Auth Flows**:");
        for (const flow of mw.authFlows.slice(0, MAX_AUTH_FLOWS)) {
          lines.push(`- **${flow.strategy}**: ${flow.indicators.join(", ")}`);
        }
      }

      if (mw.errorHandlerCount > 0) {
        lines.push("");
        lines.push(
          `**Error Handlers**: ${mw.errorHandlerCount} (in ${mw.errorHandlerFiles.slice(0, MAX_ERROR_HANDLER_FILES).join(", ")})`,
        );
      }
      lines.push("");
    }
  }

  if (section === "all" || section === "endpoints") {
    if (analysis.apiEndpoints && analysis.apiEndpoints.length > 0) {
      lines.push("## API Endpoints");
      lines.push("");
      for (const ep of analysis.apiEndpoints.slice(0, MAX_ENDPOINTS)) {
        lines.push(`- \`${ep.method} ${ep.path}\` — ${ep.file ?? "unknown"}`);
      }
      if (analysis.apiEndpoints.length > MAX_ENDPOINTS) {
        lines.push(
          `- ... and ${analysis.apiEndpoints.length - MAX_ENDPOINTS} more endpoints`,
        );
      }
      lines.push("");
    }
  }

  if (section === "all" || section === "models") {
    if (analysis.dataModels && analysis.dataModels.length > 0) {
      lines.push("## Data Models");
      lines.push("");
      for (const model of analysis.dataModels.slice(0, MAX_MODELS)) {
        const fields = model.properties
          ? ` (${model.properties
              .slice(0, MAX_FIELDS_PER_MODEL)
              .join(
                ", ",
              )}${model.properties.length > MAX_FIELDS_PER_MODEL ? ", ..." : ""})`
          : "";
        lines.push(`- **${model.name}**${fields}`);
      }
      if (analysis.dataModels.length > MAX_MODELS) {
        lines.push(
          `- ... and ${analysis.dataModels.length - MAX_MODELS} more models`,
        );
      }
      lines.push("");
    }
  }

  if (lines.length === 0) {
    return "No architecture data available. The codebase analysis may not have been run yet. Try asking the user to run the 'Ask About Codebase' command first.";
  }

  const result = lines.join("\n");

  if (result.length > MAX_OUTPUT_CHARS) {
    const truncated = result.slice(0, MAX_OUTPUT_CHARS);
    const lastNewline = truncated.lastIndexOf("\n");
    return (
      truncated.slice(0, lastNewline > 0 ? lastNewline : MAX_OUTPUT_CHARS) +
      "\n\n---\n> Output truncated to fit context window. " +
      "Use a specific `section` parameter to retrieve targeted data."
    );
  }

  return result;
}

// ─── Tool ────────────────────────────────────────────────────────

/**
 * LangChain tool that retrieves analyzed codebase architecture knowledge.
 *
 * Surfaces detected architectural patterns, project type, entry points,
 * import graph, middleware chain, API endpoints, and data models from
 * the {@link PersistentCodebaseUnderstandingService}.
 */
export class LangChainArchitectureTool extends StructuredTool<any> {
  name = "get_architecture_knowledge";
  description =
    "Retrieve the analyzed architecture knowledge of the current codebase. " +
    "Returns detected architectural patterns, project type, entry points, " +
    "import graph, middleware chain, API endpoints, and data models. " +
    "Use this tool when the user asks about the codebase structure, " +
    "architecture, design patterns, entry points, dependencies, or " +
    "how components are organized. " +
    "The section parameter lets you retrieve specific parts: " +
    '"all" for everything, "overview" for a high-level summary, ' +
    '"patterns" for architectural patterns, "call-graph" for import/dependency graph, ' +
    '"middleware" for middleware and auth, "endpoints" for API routes, ' +
    '"models" for data models.';

  schema = ArchitectureInputSchema;

  async _call(input: ArchitectureInput): Promise<string> {
    const section = (
      VALID_SECTIONS.has(input.section as ArchitectureSection)
        ? input.section
        : "all"
    ) as ArchitectureSection;

    logger.info(`Retrieving architecture knowledge: section=${section}`);
    try {
      const service = PersistentCodebaseUnderstandingService.getInstance();
      const analysis = await service.getComprehensiveAnalysis();

      if (!analysis) {
        return "No codebase analysis is available yet. The analysis may still be running or hasn't been triggered. Suggest the user runs the 'Ask About Codebase' command or waits for the initial workspace scan to complete.";
      }

      const result = formatArchitectureContext(analysis, section);
      logger.info(
        `Architecture knowledge retrieved: ${result.length} chars for section=${section}`,
      );
      return result;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Error retrieving architecture knowledge", {
        message: err.message,
        stack: err.stack,
        section,
      });
      return (
        "Unable to retrieve architecture knowledge at this time. " +
        "The analysis service may be unavailable. " +
        "Please check the logs or try again after re-running the workspace scan."
      );
    }
  }
}
