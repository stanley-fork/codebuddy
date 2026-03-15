import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { Logger, LogLevel } from "../../../infrastructure/logger/logger";
import { PersistentCodebaseUnderstandingService } from "../../../services/persistent-codebase-understanding.service";

const logger = Logger.initialize("ArchitectureKnowledgeTool", {
  minLevel: LogLevel.DEBUG,
  enableConsole: true,
  enableFile: true,
  enableTelemetry: true,
});

/**
 * Format the architecture report into a readable markdown summary
 * for consumption by subagents in agent mode.
 */
function formatArchitectureContext(
  analysis: {
    architectureReport?: {
      patterns: { name: string; confidence: number; indicators: string[] }[];
      entryPoints: string[];
      projectType: string;
    };
    callGraphSummary?: {
      entryPoints: string[];
      hotNodes: string[];
      circularDependencies: string[][];
      edgeCount: number;
      nodeCount: number;
    };
    middlewareSummary?: {
      middleware: { name: string; type: string; file: string }[];
      authStrategies: string[];
      authFlows: { strategy: string; indicators: string[]; files: string[] }[];
      errorHandlerCount: number;
      errorHandlerFiles: string[];
    };
    frameworks?: string[];
    files?: string[];
    apiEndpoints?: { path: string; method: string; file: string }[];
    dataModels?: { name: string; fields?: { name: string; type: string }[] }[];
  },
  section: string,
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
          `**Entry Points**: ${report.entryPoints.slice(0, 5).join(", ")}`,
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
      for (const pattern of report.patterns.slice(0, 5)) {
        const pct = Math.round(pattern.confidence * 100);
        lines.push(`### ${pattern.name} (${pct}% confidence)`);
        for (const ind of pattern.indicators.slice(0, 5)) {
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
        for (const node of graph.hotNodes.slice(0, 8)) {
          lines.push(`- ${node}`);
        }
        lines.push("");
      }

      if (graph.entryPoints.length > 0) {
        lines.push(
          `**Entry points** (not imported by others): ${graph.entryPoints.slice(0, 8).join(", ")}`,
        );
        lines.push("");
      }

      if (graph.circularDependencies.length > 0) {
        lines.push(
          `**Circular dependencies** (${graph.circularDependencies.length}):`,
        );
        for (const cycle of graph.circularDependencies.slice(0, 5)) {
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
        for (const m of mw.middleware.slice(0, 10)) {
          lines.push(`- ${m.name} (${m.type}) — ${m.file}`);
        }
      }

      if (mw.authFlows.length > 0) {
        lines.push("");
        lines.push("**Auth Flows**:");
        for (const flow of mw.authFlows.slice(0, 5)) {
          lines.push(`- **${flow.strategy}**: ${flow.indicators.join(", ")}`);
        }
      }

      if (mw.errorHandlerCount > 0) {
        lines.push("");
        lines.push(
          `**Error Handlers**: ${mw.errorHandlerCount} (in ${mw.errorHandlerFiles.slice(0, 5).join(", ")})`,
        );
      }
      lines.push("");
    }
  }

  if (section === "all" || section === "endpoints") {
    if (analysis.apiEndpoints && analysis.apiEndpoints.length > 0) {
      lines.push("## API Endpoints");
      lines.push("");
      for (const ep of analysis.apiEndpoints.slice(0, 15)) {
        lines.push(`- \`${ep.method} ${ep.path}\` — ${ep.file}`);
      }
      if (analysis.apiEndpoints.length > 15) {
        lines.push(
          `- ... and ${analysis.apiEndpoints.length - 15} more endpoints`,
        );
      }
      lines.push("");
    }
  }

  if (section === "all" || section === "models") {
    if (analysis.dataModels && analysis.dataModels.length > 0) {
      lines.push("## Data Models");
      lines.push("");
      for (const model of analysis.dataModels.slice(0, 10)) {
        const fields = model.fields
          ? ` (${model.fields
              .slice(0, 5)
              .map((f) => `${f.name}: ${f.type}`)
              .join(", ")}${model.fields.length > 5 ? ", ..." : ""})`
          : "";
        lines.push(`- **${model.name}**${fields}`);
      }
      if (analysis.dataModels.length > 10) {
        lines.push(`- ... and ${analysis.dataModels.length - 10} more models`);
      }
      lines.push("");
    }
  }

  if (lines.length === 0) {
    return "No architecture data available. The codebase analysis may not have been run yet. Try asking the user to run the 'Ask About Codebase' command first.";
  }

  return lines.join("\n");
}

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

  schema = z.object({
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

  async _call(input: { section: string }): Promise<string> {
    logger.info(`Retrieving architecture knowledge: section=${input.section}`);
    try {
      const service = PersistentCodebaseUnderstandingService.getInstance();
      const analysis = await service.getComprehensiveAnalysis();

      if (!analysis) {
        return "No codebase analysis is available yet. The analysis may still be running or hasn't been triggered. Suggest the user runs the 'Ask About Codebase' command or waits for the initial workspace scan to complete.";
      }

      const result = formatArchitectureContext(analysis, input.section);
      logger.info(
        `Architecture knowledge retrieved: ${result.length} chars for section=${input.section}`,
      );
      return result;
    } catch (error: any) {
      logger.error(
        `Error retrieving architecture knowledge: ${error.message}`,
        { error },
      );
      return `Failed to retrieve architecture knowledge: ${error.message}`;
    }
  }
}
