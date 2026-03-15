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

export interface CallGraph {
  nodes: Map<string, CallGraphNode>;
  edges: CallGraphEdge[];
  entryPoints: string[];
  circularDependencies: string[][]; // each inner array is one cycle path
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

/**
 * Release all data held by a CallGraph instance.
 * Call when the graph is no longer needed to free memory on large codebases.
 */
export function disposeCallGraph(graph: CallGraph): void {
  graph.nodes.clear();
  graph.edges.length = 0;
  graph.entryPoints.length = 0;
  graph.circularDependencies.length = 0;
  graph.hotNodes.length = 0;
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

/**
 * Iterative DFS to detect circular dependencies.
 * Uses an explicit work-stack to avoid stack overflow on deep graphs.
 */
function detectCircularDependencies(
  nodes: Map<string, CallGraphNode>,
): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const seenCycleKeys = new Set<string>();

  for (const startFile of nodes.keys()) {
    if (visited.has(startFile)) continue;

    // Each frame: file, iterator over its deps, index in path
    type Frame = {
      file: string;
      depIter: Iterator<string>;
      pathIndex: number;
    };
    const path: string[] = [];
    const pathSet = new Map<string, number>(); // file → index in path for O(1) lookup
    const workStack: Frame[] = [];

    const pushFrame = (file: string): void => {
      const node = nodes.get(file);
      const deps = node?.imports ?? [];
      pathSet.set(file, path.length);
      path.push(file);
      visited.add(file);
      workStack.push({
        file,
        depIter: deps[Symbol.iterator](),
        pathIndex: path.length - 1,
      });
    };

    pushFrame(startFile);

    while (workStack.length > 0) {
      const frame = workStack[workStack.length - 1];
      const { value: dep, done } = frame.depIter.next();

      if (done) {
        // Leaving this node — pop from path
        pathSet.delete(frame.file);
        path.length = frame.pathIndex; // truncate path
        workStack.pop();
        continue;
      }

      if (pathSet.has(dep)) {
        // Back-edge → cycle found
        const cycleStart = pathSet.get(dep)!;
        const cycle = path.slice(cycleStart).concat(dep);
        const key = [...cycle].sort().join("|");
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          cycles.push(cycle);
        }
        continue;
      }

      if (!visited.has(dep)) {
        pushFrame(dep);
      }
    }
  }

  return cycles;
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
