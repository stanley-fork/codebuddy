/**
 * Call Graph Builder
 *
 * Builds a dependency graph between files based on import statements.
 * Tracks which files depend on which, identifies entry points, and
 * detects circular dependencies.
 *
 * Operates on import data extracted by TreeSitterAnalyzer at analysis time.
 */

import * as path from "path";
import type { ExtractedImport } from "./tree-sitter-analyzer";

// ─── Types ───────────────────────────────────────────────────────

export interface CallGraphNode {
  file: string;
  imports: string[]; // resolved file paths this node imports
  importedBy: string[]; // files that import this node
  exports: string[];
  isEntryPoint: boolean;
}

export interface CallGraphEdge {
  from: string; // importer
  to: string; // imported
  specifiers: string[]; // what is imported
}

export interface CircularDependency {
  cycle: string[]; // file paths forming the cycle
}

export interface CallGraph {
  nodes: Map<string, CallGraphNode>;
  edges: CallGraphEdge[];
  entryPoints: string[];
  circularDependencies: CircularDependency[];
  hotNodes: string[]; // most-imported files (fan-in hubs)
}

// ─── Input Type ──────────────────────────────────────────────────

export interface FileImportData {
  file: string;
  imports: ExtractedImport[];
  exports: string[];
}

// ─── Builder ─────────────────────────────────────────────────────

export function buildCallGraph(
  fileImports: FileImportData[],
  workspacePath: string,
): CallGraph {
  const nodes = new Map<string, CallGraphNode>();
  const edges: CallGraphEdge[] = [];

  // Build node set
  for (const entry of fileImports) {
    const normalized = normalizePath(entry.file, workspacePath);
    nodes.set(normalized, {
      file: normalized,
      imports: [],
      importedBy: [],
      exports: entry.exports,
      isEntryPoint: false,
    });
  }

  // Resolve imports → edges
  for (const entry of fileImports) {
    const fromFile = normalizePath(entry.file, workspacePath);
    const fromNode = nodes.get(fromFile);
    if (!fromNode) continue;

    for (const imp of entry.imports) {
      // Skip external packages (non-relative imports)
      if (!isRelativeImport(imp.source)) continue;

      const resolved = resolveImportPath(
        fromFile,
        imp.source,
        nodes,
        workspacePath,
      );
      if (!resolved) continue;

      fromNode.imports.push(resolved);

      const toNode = nodes.get(resolved);
      if (toNode) {
        toNode.importedBy.push(fromFile);
      }

      edges.push({
        from: fromFile,
        to: resolved,
        specifiers: imp.specifiers,
      });
    }
  }

  // Identify entry points (files that are not imported by anything)
  const entryPoints: string[] = [];
  for (const [file, node] of nodes) {
    if (node.importedBy.length === 0) {
      node.isEntryPoint = true;
      entryPoints.push(file);
    }
  }

  // Detect circular dependencies
  const circularDependencies = detectCircularDependencies(nodes);

  // Find hot nodes (most-imported, fan-in hubs)
  const hotNodes = findHotNodes(nodes, 10);

  return { nodes, edges, entryPoints, circularDependencies, hotNodes };
}

// ─── Path Resolution ─────────────────────────────────────────────

function normalizePath(filePath: string, workspacePath: string): string {
  const rel = path.relative(workspacePath, filePath);
  return rel.replace(/\\/g, "/");
}

function isRelativeImport(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../");
}

/**
 * Resolve a relative import to a known file in the graph.
 * Tries common extensions and index files.
 */
function resolveImportPath(
  fromFile: string,
  importSource: string,
  knownFiles: Map<string, CallGraphNode>,
  _workspacePath: string,
): string | null {
  const dir = path.posix.dirname(fromFile);
  const base = path.posix.join(dir, importSource);
  const normalized = path.posix.normalize(base);

  // Try exact match first
  if (knownFiles.has(normalized)) return normalized;

  // Try common extensions
  const extensions = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".php",
  ];
  for (const ext of extensions) {
    const withExt = normalized + ext;
    if (knownFiles.has(withExt)) return withExt;
  }

  // Try index files
  for (const ext of extensions) {
    const indexFile = path.posix.join(normalized, `index${ext}`);
    if (knownFiles.has(indexFile)) return indexFile;
  }

  return null;
}

// ─── Circular Dependency Detection ───────────────────────────────

function detectCircularDependencies(
  nodes: Map<string, CallGraphNode>,
): CircularDependency[] {
  const cycles: CircularDependency[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  // DFS over all nodes
  for (const file of nodes.keys()) {
    if (!visited.has(file)) {
      dfs(file, nodes, visited, inStack, stack, cycles);
    }
  }

  return cycles;
}

function dfs(
  file: string,
  nodes: Map<string, CallGraphNode>,
  visited: Set<string>,
  inStack: Set<string>,
  stack: string[],
  cycles: CircularDependency[],
): void {
  visited.add(file);
  inStack.add(file);
  stack.push(file);

  const node = nodes.get(file);
  if (node) {
    for (const dep of node.imports) {
      if (!visited.has(dep)) {
        dfs(dep, nodes, visited, inStack, stack, cycles);
      } else if (inStack.has(dep)) {
        // Found a cycle — extract it
        const cycleStart = stack.indexOf(dep);
        if (cycleStart !== -1) {
          const cycle = stack.slice(cycleStart).concat(dep);
          // Dedupe — only add if we haven't seen this cycle
          const key = [...cycle].sort().join("|");
          if (!cycles.some((c) => [...c.cycle].sort().join("|") === key)) {
            cycles.push({ cycle });
          }
        }
      }
    }
  }

  stack.pop();
  inStack.delete(file);
}

// ─── Hot Node Detection ──────────────────────────────────────────

function findHotNodes(
  nodes: Map<string, CallGraphNode>,
  limit: number,
): string[] {
  return [...nodes.entries()]
    .map(([file, node]) => ({ file, fanIn: node.importedBy.length }))
    .filter((n) => n.fanIn > 0)
    .sort((a, b) => b.fanIn - a.fanIn)
    .slice(0, limit)
    .map((n) => n.file);
}
