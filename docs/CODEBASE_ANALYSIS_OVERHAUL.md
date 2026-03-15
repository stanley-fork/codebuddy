# Codebase Analysis Feature Overhaul

**Created**: January 2025
**Updated**: March 15, 2026
**Status**: Phase 1 Complete — Ready to merge
**Feature**: `CodeBuddy.codebaseAnalysis` command
**Branch**: `feature/code_analysis_overhaul`

---

## Executive Summary

The "Analyze Codebase & Answer Questions" feature was overhauled to replace shallow regex-based extraction with accurate Tree-sitter AST parsing, token-budget-driven context generation, and multi-language dependency detection.

**Before**: Regex-based extraction for 3 languages, no code in LLM context, hard-coded limits (20/15/10/30).
**After**: Tree-sitter AST extraction for 7 languages, actual code snippets in context, priority-weighted token budget across 10 categories.

### What changed (15 files, +4684 / -296 lines)

| Area | Before | After |
|------|--------|-------|
| Code extraction | Regex (3 languages) | Tree-sitter AST (7 languages) |
| LLM context | File paths only | Code snippets, endpoints, models, relationships |
| Context limits | Hard-coded counts | `TokenBudgetAllocator` with proportional weights |
| Endpoint detection | 3 regex patterns | 25+ patterns across 7 languages |
| Dependency parsing | `package.json` only | 6 formats (npm, pip, Cargo, Maven, Go, Composer) |
| Worker safety | None | Path traversal prevention, grammar path validation |
| Type safety | `data?: any` | Discriminated union `WorkerMessage` (5 variants) |
| Logging | `console.log` | `WorkerLogger` with level filtering + `parentPort` transport |

---

## Architecture

```
User Question
    ↓
PersistentCodebaseUnderstandingService
    ↓
CodebaseAnalysisWorker (Worker Thread)
    ├── validateWorkerInput() → path traversal prevention
    ├── TreeSitterAnalyzer (7 languages, parser pool)
    │   ├── extractFunctions()
    │   ├── extractClasses()
    │   ├── extractEndpoints()
    │   ├── extractImports()
    │   ├── extractExports()
    │   └── extractReactComponents()
    ├── Dependency parsers (6 formats)
    ├── IMPORTANT_FILE_PATTERNS (22 patterns)
    └── WorkerLogger → parentPort.postMessage()
    ↓
WorkerMessage discriminated union
    ├── ANALYZE_CODEBASE
    ├── ANALYSIS_COMPLETE
    ├── ANALYSIS_ERROR
    ├── ANALYSIS_PROGRESS
    └── LOG
    ↓
createContextFromAnalysis() → 9 budget-managed sections
    ├── Overview
    ├── Frameworks & Technologies
    ├── Language Distribution
    ├── Dependencies (scored with scoreDependency)
    ├── API Endpoints
    ├── Data Models
    ├── Code Snippets (largest budget share: 40%)
    ├── Domain Relationships
    └── File Structure
    ↓
TokenBudgetAllocator (32K chars, 10% safety margin)
    ├── Proportional weights (sum ≈ 0.987)
    ├── Priority-based selection
    └── RelevanceScoring (scoreFile, scoreEndpoint)
    ↓
LLM Provider → Response → Markdown Document
```

---

## Phase 1 Implementation (Complete)

### 1.1 Tree-sitter Analyzer

**File**: `src/services/analyzers/tree-sitter-analyzer.ts` (1179 lines, new)

**Supported languages (7)**:

| Language | Extensions | Endpoint Frameworks |
|----------|-----------|-------------------|
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | Express, Fastify, Hono |
| TypeScript | `.ts`, `.tsx`, `.mts`, `.cts` | Express, NestJS, Fastify, Hono |
| Python | `.py` | FastAPI, Flask, Django |
| Java | `.java` | Spring (`@GetMapping`), JAX-RS (`@GET`) |
| Go | `.go` | Gin, Chi, Echo, net/http |
| Rust | `.rs` | Actix (`#[get]`), Axum, Rocket |
| PHP | `.php`, `.phtml` | Laravel, Symfony |

**Parser pool architecture**:

```typescript
interface ParserPoolEntry {
  available: Parser[];   // ready for checkout
  inUse: Set<Parser>;    // currently checked out
}
```

- `acquireParser(languageId)` — fast path (reuse available), in-flight dedup (await shared init promise, re-check pool), first-time init (load WASM grammar)
- `releaseParser(languageId, parser)` — returns to available pool
- `dispose()` — clears all parsers, caches, and init state

**Extraction pipeline (6 methods)**:

| Method | Technique | Output |
|--------|-----------|--------|
| `extractFunctions` | DFS stack traversal, `TOP_LEVEL_FUNCTION_MAX_DEPTH = 3` | `ExtractedFunction[]` |
| `extractClasses` | AST node type mapping per language, decorator extraction | `ExtractedClass[]` |
| `extractEndpoints` | `API_ENDPOINT_QUERIES` regex per language with `matchAll` | `ExtractedEndpoint[]` |
| `extractImports` | AST import node parsing | `ExtractedImport[]` |
| `extractExports` | AST export node parsing | `string[]` |
| `extractReactComponents` | DFS for `lexical_declaration` with JSX, uppercase naming | `ExtractedClass[]` (type: `"function"`) |

### 1.2 Token Budget Allocator

**File**: `src/services/analyzers/token-budget.ts` (385 lines, new)

**Content-type-aware tokenization**:

```typescript
CHARS_PER_TOKEN = { code: 2.0, prose: 3.5, conservative: 2.0 }
```

**Budget categories** (from `createAnalysisBudget`, default 32K chars):

| Category | Weight | Priority | Effective (chars) |
|----------|--------|----------|--------------------|
| overview | 0.025 | 10 | 720 |
| frameworks | 0.019 | 9 | 547 |
| languages | 0.013 | 9 | 374 |
| architecture | 0.094 | 8 | 2707 |
| **codeSnippets** | **0.400** | **7** | **11520** |
| endpoints | 0.125 | 6 | 3600 |
| models | 0.125 | 5 | 3600 |
| dependencies | 0.062 | 5 | 1785 |
| relationships | 0.062 | 4 | 1785 |
| fileList | 0.062 | 3 | 1785 |

**Key methods**: `allocate()` (clamped to remaining), `selectWithinBudget()` (score-sorted greedy with skip), `truncateToFit()`, `recordUsage()`, `getSummary()`.

**`RelevanceScoring`** utility: `scoreFile()` (entry points, key directories, question keywords), `scoreEndpoint()` (path patterns, question relevance).

### 1.3 Worker Hardening

**File**: `src/workers/codebase-analysis.worker.ts` (~1300 lines, heavily modified)

**Security**:
- `validateWorkerInput()` — absolute path check, array validation, path traversal prevention (`path.resolve` + `startsWith`)
- `validateGrammarsPath()` — requires `grammars` segment in path

**Dependency parsers (6 formats)**:

| Format | File | Technique |
|--------|------|-----------|
| npm | `package.json` | `JSON.parse` + merge `dependencies`/`devDependencies` |
| pip | `requirements.txt` | Line-by-line `==`/`>=` parsing |
| pyproject | `pyproject.toml` | `extractTomlSection("tool.poetry.dependencies")` |
| Cargo | `Cargo.toml` | `extractTomlSection("dependencies")` |
| Maven | `pom.xml` | Two-pass: extract `<dependency>` blocks, then parse fields |
| Go | `go.mod` | Line regex for `require` blocks |
| Composer | `composer.json` | `JSON.parse` + merge `require`/`require-dev` |

**`extractTomlSection`**: Line-by-line state machine. Distinguishes `[section]` from `[[array-table]]`, skips comments, handles trailing comments on headers, full regex-escaping of section names.

**IMPORTANT_FILE_PATTERNS (22 regexes)**: Entry points (5), directories (5), README (1), manifests (11). All use `[^\\/]*` instead of `.*` to prevent catastrophic backtracking.

### 1.4 Shared Infrastructure

**`src/interfaces/analysis.interface.ts`** (190 lines, new) — `WorkerMessage` discriminated union (5 variants: `ANALYZE_CODEBASE`, `ANALYSIS_COMPLETE`, `ANALYSIS_ERROR`, `ANALYSIS_PROGRESS`, `LOG`), `AnalysisResult`, `WorkerInputData`, `BudgetItem<T>`.

**`src/infrastructure/logger/worker-logger.ts`** (113 lines, new) — `WorkerLogger` class with `LogLevel` enum (DEBUG/INFO/WARN/ERROR), `parentPort.postMessage()` transport, console fallback (disabled by default), `IWorkerLoggerConfig` for DI.

### 1.5 Context Generation

**File**: `src/commands/architectural-recommendation.ts` (+693 lines modified)

**9 sections** generated by dedicated `generateXxxSection()` functions, each consuming from named budget allocations via `TokenBudgetAllocator`.

**Utility functions**:
- `scoreDependency(name, question?)` — tiered scoring: Tier 1 (exact framework match, +3), Tier 2 (scoped package normalization `@nestjs/core` → scope `nestjs`, +3), question relevance (+5)
- `getRelativePath(fullPath)` — VS Code API → marker-based `lastIndexOf` fallback (deepest match for monorepos) → `node_modules` skip → basename

---

## Review History (7 Rounds)

| Round | Focus | Issues | Key Fixes |
|-------|-------|--------|-----------|
| 1st | Build | Build errors | Type fixes, import resolution |
| 2nd | Type safety | Type looseness | Stronger typing, null checks |
| 3rd | Thread safety | Race conditions | Worker message typing |
| 4th | Memory + security | 15 issues | Parser pool leak fix, Map serialization, path traversal |
| 5th | Architecture | 16 issues (3 critical) | Removed `fileContents` Map leak, `validateWorkerInput`, discriminated union `WorkerMessage`, iterative BFS, `matchAll` for regex |
| 6th | Performance + correctness | 17 issues (3 critical) | `acquireParser`/`releaseParser` pool, DFS `stack.pop()` O(n), `CHARS_PER_TOKEN` by content type, `IMPORTANT_FILE_PATTERNS` backtrack-safe, `scoreDependency` exact matching |
| 7th | Edge cases + production | 13 issues (2 critical) | `perSnippetBudget` post-selection compute, parser pool race fix (re-check after await), `extractTomlSection` array-table handling, scoped package normalization, `lastIndexOf` for monorepos, pom.xml two-pass parsing, `enableConsole` default false, React component `type: "function"`, `validateGrammarsPath` tightened |

---

## Test Suite

**601 tests passing** (including 60 new tests for the overhaul)

| Test File | Tests | Covers |
|-----------|-------|--------|
| `token-budget.test.ts` | 26 | Constructor, static methods, allocate/clamp, selectWithinBudget (priority, scanning, exhaustion), truncateToFit, getSummary, isExhausted, reset, createAnalysisBudget |
| `tree-sitter-analyzer.test.ts` | 15 | Constructor (fallback path, logger DI), canAnalyze (7 languages + unsupported), getLanguageId (8 mappings), dispose (idempotent), initialize (dedup) |
| `codebase-analysis-worker-utils.test.ts` | 10 | extractTomlSection: simple/dotted sections, `[[array-table]]` boundary, comment skipping, trailing comments, regex escaping, empty/missing |
| `architectural-recommendation-utils.test.ts` | 9 | scoreDependency (tier 1 frameworks, tier 2 scoped, question relevance, edge cases), getRelativePath (all markers, node_modules skip, Windows paths, monorepo lastIndexOf) |

---

## File Changes Summary

### New Files (8)

| File | Lines | Purpose |
|------|-------|---------|
| `src/services/analyzers/tree-sitter-analyzer.ts` | 1179 | Tree-sitter AST extraction for 7 languages |
| `src/services/analyzers/token-budget.ts` | 385 | Token budget allocation + relevance scoring |
| `src/interfaces/analysis.interface.ts` | 190 | Shared types: WorkerMessage, AnalysisResult, BudgetItem |
| `src/infrastructure/logger/worker-logger.ts` | 113 | Worker-safe logger with parentPort transport |
| `src/test/suite/token-budget.test.ts` | 349 | Token budget unit tests |
| `src/test/suite/tree-sitter-analyzer.test.ts` | 166 | Analyzer unit tests |
| `src/test/suite/codebase-analysis-worker-utils.test.ts` | 133 | TOML extraction tests |
| `src/test/suite/architectural-recommendation-utils.test.ts` | 178 | Scoring + path utility tests |

### Modified Files (7)

| File | Delta | Changes |
|------|-------|---------|
| `src/workers/codebase-analysis.worker.ts` | +800 | Tree-sitter integration, 6 dep parsers, input validation, TOML state machine |
| `src/commands/architectural-recommendation.ts` | +500 | 9-section budget-managed context, scoreDependency, getRelativePath |
| `src/services/codebase-analysis-worker.ts` | +40 | WorkerMessage handling, progress reporting |
| `src/services/persistent-codebase-understanding.service.ts` | +20 | Code snippet storage |
| `src/ast/language-config.ts` | +15 | PHP language config |
| `.vscode-test.mjs` | +1 | Register new test files |
| `docs/CODEBASE_ANALYSIS_OVERHAUL.md` | rewrite | This file |

---

## Phase 2: Rich Analysis (Planned)

**Goal**: Add architectural pattern detection and code summaries.

### 2.1 Architectural Pattern Detection

**New file**: `src/services/analyzers/architecture-detector.ts`

Detect layered architecture, module-based organization, MVC/MVVM, microservices indicators, monorepo structure. Use existing `TreeSitterAnalysisResult` imports and file structure patterns.

### 2.2 Call Graph Builder

**New file**: `src/services/analyzers/call-graph.ts`

Track function→function calls, class→service dependencies, identify entry points, detect circular dependencies. Output as `CallGraph { nodes, edges, entryPoints, hotPaths }`.

### 2.3 Code Summarizer (LLM-assisted)

**New file**: `src/services/analyzers/code-summarizer.ts`

Generate 1-2 sentence summaries per key file, batch to reduce LLM calls, cache with content hash.

### 2.4 Auth/Middleware Flow Detection

**New file**: `src/services/analyzers/middleware-detector.ts`

Detect Express middleware chains, NestJS guards, request lifecycle hooks, error handlers.

---

## Phase 3: Multi-pass Analysis (Planned)

**Goal**: Two-stage LLM calls for focused, accurate answers.

### 3.1 Question Analysis Stage

Stage 1 LLM call identifies relevant files/concepts → filter analysis → Stage 2 LLM call answers with focused context.

### 3.2 Question-based Relevance Scoring

**New file**: `src/services/analyzers/question-relevance.ts`

Keyword overlap, file type relevance, import proximity, recency of changes. Builds on existing `RelevanceScoring` utilities.

### 3.3 Focused Context Generation

Full code for top 3 files, summaries for next 7, relationship diagram, relevant dependencies only.

---

## Risks & Mitigations

| Risk | Mitigation | Status |
|------|------------|--------|
| Tree-sitter WASM in worker thread | Parser pool with checkout/checkin, dispose on deactivation | ✅ Resolved |
| Token budget miscalculation | 10% safety margin, `Math.floor` clamping, proportional weights | ✅ Resolved |
| Parser pool race conditions | In-flight dedup with re-check after await | ✅ Resolved |
| Path traversal via worker input | `validateWorkerInput` + `validateGrammarsPath` | ✅ Resolved |
| Catastrophic regex backtracking | `[^\\/]*` instead of `.*`, no unbounded quantifiers | ✅ Resolved |
| Cross-block pom.xml matching | Two-pass extraction (blocks first, then fields) | ✅ Resolved |
| Two-stage LLM doubles latency | Cache Stage 1 results by question hash | Phase 3 |
| Large codebases timeout | File count limits with smart sampling | Phase 2 |

---

## References

- Tree-sitter analyzer: `src/services/analyzers/tree-sitter-analyzer.ts`
- Token budget: `src/services/analyzers/token-budget.ts`
- Worker: `src/workers/codebase-analysis.worker.ts`
- Context generation: `src/commands/architectural-recommendation.ts`
- Shared types: `src/interfaces/analysis.interface.ts`
- Worker logger: `src/infrastructure/logger/worker-logger.ts`
- Tests: `src/test/suite/{token-budget,tree-sitter-analyzer,codebase-analysis-worker-utils,architectural-recommendation-utils}.test.ts`
