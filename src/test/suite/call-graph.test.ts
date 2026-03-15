import * as assert from "assert";
import {
  buildCallGraph,
  type FileImportData,
  type CallGraph,
} from "../../services/analyzers/call-graph";

function makeImportData(overrides: Partial<FileImportData>): FileImportData {
  return {
    file: "/workspace/src/index.ts",
    imports: [],
    exports: [],
    ...overrides,
  };
}

suite("Call Graph Builder", () => {
  const WS = "/workspace";

  suite("buildCallGraph", () => {
    test("builds empty graph from no inputs", () => {
      const graph = buildCallGraph([], WS);
      assert.strictEqual(graph.nodes.size, 0);
      assert.strictEqual(graph.edges.length, 0);
    });

    test("registers nodes for all files", () => {
      const graph = buildCallGraph(
        [
          makeImportData({ file: `${WS}/src/a.ts` }),
          makeImportData({ file: `${WS}/src/b.ts` }),
        ],
        WS,
      );
      assert.strictEqual(graph.nodes.size, 2);
      assert.ok(graph.nodes.has("src/a.ts"));
      assert.ok(graph.nodes.has("src/b.ts"));
    });

    test("creates edges for relative imports", () => {
      const graph = buildCallGraph(
        [
          makeImportData({
            file: `${WS}/src/a.ts`,
            imports: [
              { source: "./b", specifiers: ["foo"], isDefault: false },
            ],
          }),
          makeImportData({ file: `${WS}/src/b.ts`, exports: ["foo"] }),
        ],
        WS,
      );
      assert.strictEqual(graph.edges.length, 1);
      assert.strictEqual(graph.edges[0].from, "src/a.ts");
      assert.strictEqual(graph.edges[0].to, "src/b.ts");
    });

    test("ignores non-relative (external) imports", () => {
      const graph = buildCallGraph(
        [
          makeImportData({
            file: `${WS}/src/a.ts`,
            imports: [
              { source: "express", specifiers: ["Router"], isDefault: false },
              { source: "@nestjs/common", specifiers: ["Controller"], isDefault: false },
            ],
          }),
        ],
        WS,
      );
      assert.strictEqual(graph.edges.length, 0);
    });

    test("resolves imports with index files", () => {
      const graph = buildCallGraph(
        [
          makeImportData({
            file: `${WS}/src/app.ts`,
            imports: [
              {
                source: "./utils",
                specifiers: ["helper"],
                isDefault: false,
              },
            ],
          }),
          makeImportData({
            file: `${WS}/src/utils/index.ts`,
            exports: ["helper"],
          }),
        ],
        WS,
      );
      assert.strictEqual(graph.edges.length, 1);
      assert.strictEqual(graph.edges[0].to, "src/utils/index.ts");
    });
  });

  suite("entry points", () => {
    test("files not imported by others are entry points", () => {
      const graph = buildCallGraph(
        [
          makeImportData({
            file: `${WS}/src/main.ts`,
            imports: [
              { source: "./service", specifiers: ["Service"], isDefault: false },
            ],
          }),
          makeImportData({ file: `${WS}/src/service.ts`, exports: ["Service"] }),
        ],
        WS,
      );
      assert.ok(graph.entryPoints.includes("src/main.ts"));
      assert.ok(!graph.entryPoints.includes("src/service.ts"));
    });

    test("isolated files are entry points", () => {
      const graph = buildCallGraph(
        [
          makeImportData({ file: `${WS}/src/standalone.ts` }),
        ],
        WS,
      );
      assert.ok(graph.entryPoints.includes("src/standalone.ts"));
    });
  });

  suite("circular dependencies", () => {
    test("detects simple A→B→A cycle", () => {
      const graph = buildCallGraph(
        [
          makeImportData({
            file: `${WS}/src/a.ts`,
            imports: [{ source: "./b", specifiers: ["B"], isDefault: false }],
          }),
          makeImportData({
            file: `${WS}/src/b.ts`,
            imports: [{ source: "./a", specifiers: ["A"], isDefault: false }],
          }),
        ],
        WS,
      );
      assert.ok(
        graph.circularDependencies.length > 0,
        "Should detect circular dependency",
      );
    });

    test("no false positives for DAG", () => {
      const graph = buildCallGraph(
        [
          makeImportData({
            file: `${WS}/src/a.ts`,
            imports: [{ source: "./b", specifiers: ["B"], isDefault: false }],
          }),
          makeImportData({
            file: `${WS}/src/b.ts`,
            imports: [{ source: "./c", specifiers: ["C"], isDefault: false }],
          }),
          makeImportData({ file: `${WS}/src/c.ts`, exports: ["C"] }),
        ],
        WS,
      );
      assert.strictEqual(graph.circularDependencies.length, 0);
    });
  });

  suite("hot nodes", () => {
    test("identifies most-imported files", () => {
      const graph = buildCallGraph(
        [
          makeImportData({
            file: `${WS}/src/a.ts`,
            imports: [{ source: "./shared", specifiers: ["x"], isDefault: false }],
          }),
          makeImportData({
            file: `${WS}/src/b.ts`,
            imports: [{ source: "./shared", specifiers: ["y"], isDefault: false }],
          }),
          makeImportData({
            file: `${WS}/src/c.ts`,
            imports: [{ source: "./shared", specifiers: ["z"], isDefault: false }],
          }),
          makeImportData({ file: `${WS}/src/shared.ts`, exports: ["x", "y", "z"] }),
        ],
        WS,
      );
      assert.ok(graph.hotNodes.includes("src/shared.ts"));
    });
  });

  suite("importedBy tracking", () => {
    test("tracks reverse dependencies", () => {
      const graph = buildCallGraph(
        [
          makeImportData({
            file: `${WS}/src/a.ts`,
            imports: [{ source: "./b", specifiers: ["B"], isDefault: false }],
          }),
          makeImportData({ file: `${WS}/src/b.ts`, exports: ["B"] }),
        ],
        WS,
      );
      const bNode = graph.nodes.get("src/b.ts");
      assert.ok(bNode);
      assert.ok(bNode.importedBy.includes("src/a.ts"));
    });
  });
});
