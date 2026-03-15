# Codebase Analysis Feature Overhaul

**Created**: January 2025
**Updated**: March 15, 2026
**Status**: Phase 3 In Progress
**Feature**: `CodeBuddy.codebaseAnalysis` command
**Branch**: `feature/code_analysis_overhaul`

---

## Executive Summary

The "Analyze Codebase & Answer Questions" feature was overhauled to replace shallow regex-based extraction with accurate Tree-sitter AST parsing, token-budget-driven context generation, and multi-language dependency detection.

**Before**: Regex-based extraction for 3 languages, no code in LLM context, hard-coded limits (20/15/10/30).
**After**: Tree-sitter AST extraction for 7 languages, actual code snippets in context, priority-weighted token budget across 12 categories.

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
Phase 2 Detectors (Step 8 in performAnalysis)
    ├── detectArchitecture() → ArchitectureReport
    │   ├── Layer detection (9 patterns: controllers, services, repos, ...)
    │   ├── Pattern detection (Layered, MVC, MVVM, Module-based, Monorepo, Event-driven, Middleware Pipeline)
    │   ├── Entry point detection
    │   └── Project type detection (REST API, SPA, Full-stack, CLI, Library, Microservices)
    ├── buildCallGraph() → CallGraph
    │   ├── Node/edge construction from FileImportData
    │   ├── Relative import resolution (extension + index fallback)
    │   ├── Circular dependency detection (DFS)
    │   └── Hot node detection (fan-in ranking)
    └── detectMiddleware() → MiddlewareReport
        ├── File-based detection (middleware/, guards/, interceptors/)
        ├── Express app.use patterns
        ├── NestJS @UseGuards/@UseInterceptors/@UsePipes
        ├── Error handler detection (4-param pattern)
        └── Auth strategy detection (JWT, session, OAuth, API-key, basic)
    ↓
WorkerMessage discriminated union
    ├── ANALYZE_CODEBASE
    ├── ANALYSIS_COMPLETE
    ├── ANALYSIS_ERROR
    ├── ANALYSIS_PROGRESS
    └── LOG
    ↓
Phase 3 Question-Relevance (when question provided)
    ├── analyzeQuestionCached(question, analysis) → QuestionAnalysis
    │   ├── extractKeywords() — stop-word removal, dedup
    │   ├── DOMAIN_SIGNALS map → boosted sections
    │   ├── scoreFile() per snippet/file — path, content, callGraph bonuses
    │   └── 5-min TTL cache, bounded at 100 entries
    ├── buildFocusedContext(analysis, qa) → FocusedContext
    │   ├── Full code tier (top 3 files)
    │   ├── Summary tier (next 7 files)
    │   ├── Scored endpoints & models
    │   └── Related dependencies (hot node overlap)
    └── generateFocusedContextSection() → prepended to sections
    ↓
createContextFromAnalysis() → 12 budget-managed sections
    ├── [Phase 3: Question-Focused Context (prepended)]
    ├── Overview
    ├── Frameworks & Technologies
    ├── Language Distribution
    ├── Dependencies (scored with scoreDependency)
    ├── API Endpoints
    ├── Data Models
    ├── Code Snippets (largest budget share: 40%)
    ├── Domain Relationships
    ├── Architecture Patterns (Phase 2)
    ├── Import Graph & Hot Nodes (Phase 2)
    ├── Middleware & Auth (Phase 2)
    └── File Structure
    ↓
TokenBudgetAllocator (32K chars, 10% safety margin)
    ├── Proportional weights (sum ≈ 0.987, 12 categories)
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
| architecture | 0.050 | 8 | 1440 |
| callGraph | 0.022 | 8 | 633 |
| middleware | 0.022 | 8 | 633 |
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

### Phase 2 Review History (6 Rounds)

| Round | Focus | Issues | Key Fixes |
|-------|-------|--------|-----------|
| 1st (8th overall) | Initial Phase 2 integration | 15 issues (3 critical) | Architecture detector structure, call graph edge handling, middleware dedup |
| 2nd (9th overall) | Correctness & memory | 12 issues (2 critical) | `disposeCallGraph` cleanup, `canonicalizeCycle` dedup, iterative DFS, `InMemorySummaryCache` |
| 3rd (10th overall) | Budget guards & safety | 14 issues (3 critical) | Budget guard hardening, cycle dedup correctness, path safety improvements |
| 4th (11th overall) | Path handling & accuracy | 10 issues (2 critical) | `shortFilePath` 2-segment paths, `TYPE_PRIORITY` ordering, Windows backslash normalization |
| 5th (12th overall) | Import cap & disposal | 15 issues (3 critical) | `MAX_IMPORT_FILES_FOR_CALL_GRAPH = 2000`, `shortFilePath()` in batch prompt, middleware omitted count display |
| 6th (13th overall) | Robustness & correctness | 7 issues (3 critical) | Off-by-one import cap fix, use-after-dispose in `disposeCallGraph`, ambiguous `shortFilePath` collision guard, `\w` exec loop replacing Unicode `/gu`, module-level `WEB_FRAMEWORK_NAMES` Set, `MAX_SNIPPET_SCAN_CHARS` bound, double-relativization removal |

---

## Test Suite

**703 tests passing** (60 Phase 1 + 54 Phase 2 + 26 Phase 3 new + incremental additions across 13 review rounds)

| Test File | Tests | Covers |
|-----------|-------|--------|
| `token-budget.test.ts` | 26 | Constructor, static methods, allocate/clamp, selectWithinBudget (priority, scanning, exhaustion), truncateToFit, getSummary, isExhausted, reset, createAnalysisBudget (12 categories) |
| `tree-sitter-analyzer.test.ts` | 15 | Constructor (fallback path, logger DI), canAnalyze (7 languages + unsupported), getLanguageId (8 mappings), dispose (idempotent), initialize (dedup) |
| `codebase-analysis-worker-utils.test.ts` | 10 | extractTomlSection: simple/dotted sections, `[[array-table]]` boundary, comment skipping, trailing comments, regex escaping, empty/missing |
| `architectural-recommendation-utils.test.ts` | 9 | scoreDependency (tier 1 frameworks, tier 2 scoped, question relevance, edge cases), getRelativePath (all markers, node_modules skip, Windows paths, monorepo lastIndexOf) |
| `architecture-detector.test.ts` | 14 | Layer detection, pattern detection (Layered, MVC, Module-based, Monorepo, Event-driven, Middleware Pipeline), entry points, project type (REST API, SPA, Full-stack, fallback), confidence sorting |
| `call-graph.test.ts` | 11 | Empty graph, node registration, relative import edges, external import filtering, index file resolution, entry point identification, circular dependency detection (A→B→A), DAG no false positive, hot node fan-in, importedBy tracking |
| `middleware-detector.test.ts` | 14 | File-based detection (middleware/, guards/), Express app.use, NestJS @UseGuards/@UseInterceptors/@UsePipes, multiple guards, error handler (4-param), auth strategies (JWT, session, OAuth, API-key), model-based Guard class detection, deduplication |
| `code-summarizer.test.ts` | 10 | LLM batch response parsing, caching (hit/miss/invalidation/clear), batch splitting (>5 items), fallback (LLM throws, bad JSON, markdown fences), summary truncation (200 chars) |
| `question-relevance.test.ts` | 26 | Keyword extraction (stop words, dedup, case, paths), scoreFile (path/content/callGraph bonuses), scoreEndpoint (path/handler), scoreModel (name/member caps), analyzeQuestion (domain signals, file scoring, file-list-only entries), buildFocusedContext (full/summary tiers, endpoint/model filtering, boosted sections), cache (TTL, eviction, key isolation) |

---

## File Changes Summary

### New Files (16)

| File | Lines | Purpose |
|------|-------|---------|
| `src/services/analyzers/tree-sitter-analyzer.ts` | 1179 | Tree-sitter AST extraction for 7 languages |
| `src/services/analyzers/token-budget.ts` | 385 | Token budget allocation + relevance scoring |
| `src/services/analyzers/architecture-detector.ts` | ~230 | Architectural pattern & layer detection |
| `src/services/analyzers/call-graph.ts` | ~210 | Import graph builder with circular dep detection |
| `src/services/analyzers/middleware-detector.ts` | ~280 | Middleware, auth, and error handler detection |
| `src/services/analyzers/code-summarizer.ts` | ~250 | LLM-assisted file summarization with caching |
| `src/services/analyzers/question-relevance.ts` | ~340 | Question-relevance scoring, focused context builder, question cache (Phase 3) |
| `src/interfaces/analysis.interface.ts` | 190 | Shared types: WorkerMessage, AnalysisResult, BudgetItem |
| `src/infrastructure/logger/worker-logger.ts` | 113 | Worker-safe logger with parentPort transport |
| `src/test/suite/token-budget.test.ts` | 349 | Token budget unit tests |
| `src/test/suite/tree-sitter-analyzer.test.ts` | 166 | Analyzer unit tests |
| `src/test/suite/codebase-analysis-worker-utils.test.ts` | 133 | TOML extraction tests |
| `src/test/suite/architectural-recommendation-utils.test.ts` | 178 | Scoring + path utility tests |
| `src/test/suite/architecture-detector.test.ts` | ~200 | Architecture detection tests |
| `src/test/suite/call-graph.test.ts` | ~170 | Call graph builder tests |
| `src/test/suite/middleware-detector.test.ts` | ~250 | Middleware detection tests |
| `src/test/suite/code-summarizer.test.ts` | ~200 | Code summarizer tests |
| `src/test/suite/question-relevance.test.ts` | ~270 | Question relevance tests (Phase 3) |

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

## Phase 2: Rich Analysis (Complete)

**Goal**: Add architectural pattern detection, import graph analysis, middleware/auth detection, and LLM-assisted code summaries.

### 2.1 Architecture Detector

**File**: `src/services/analyzers/architecture-detector.ts` (~230 lines, new)

Detects high-level architectural patterns from file structure and analysis data.

**Layer detection (9 patterns)**: controllers, services, repositories, models, middleware, views, config, utils, tests — each with regex patterns matching directory and file names.

**Pattern detection (7 types)**:

| Pattern | Detection Criteria |
|---------|--------------------|
| Layered | controllers + services layer present |
| MVC | controllers + models (+ optional views) |
| MVVM | viewmodels layer present |
| Module-based | Feature directories with internal structure |
| Monorepo | `packages/`, `apps/`, or `workspaces/` directories |
| Event-driven | Event/listener/subscriber/handler files |
| Middleware Pipeline | Middleware/guards/interceptors directories |

**Entry point detection**: Matches files like `index.ts`, `main.ts`, `app.ts`, `server.ts` at project root or `src/`.

**Project type detection**: REST API (endpoints present), Frontend SPA (React/Vue/Angular files), Full-stack (both), CLI (bin/ files), Library (exports heavy), Microservices (multiple package.json).

### 2.2 Call Graph Builder

**File**: `src/services/analyzers/call-graph.ts` (~210 lines, new)

Builds a directed dependency graph from file import data collected during Tree-sitter analysis.

**Input**: `FileImportData { file, imports: ExtractedImport[], exports: string[] }` — collected per-file during `analyzeFileContents`.

**Output**: `CallGraph { nodes: Map<string, CallGraphNode>, edges: CallGraphEdge[], entryPoints: string[], circularDependencies: CircularDependency[], hotNodes: string[] }`

**Key features**:
- **Relative import resolution**: Tries exact match, then with extensions (`.ts`, `.js`, `.tsx`, `.jsx`), then `/index.*` variants
- **Circular dependency detection**: DFS with visited + recursion stack tracking, reports full cycle path
- **Hot node detection**: Nodes with `importedBy.length >= 3`, sorted by fan-in descending
- **Entry points**: Nodes not imported by any other file

### 2.3 Middleware & Auth Detector

**File**: `src/services/analyzers/middleware-detector.ts` (~280 lines, new)

Detects middleware chains, auth strategies, error handlers, and request lifecycle hooks.

**Detection sources (4 layers)**:

| Layer | Technique |
|-------|-----------|
| File-based | Regex on file paths: `middleware/`, `guards/`, `interceptors/`, `pipes/`, `filters/` |
| Express patterns | `app.use(handler)` / `router.use('/route', handler)` regex |
| NestJS decorators | `@UseGuards(...)`, `@UseInterceptors(...)`, `@UsePipes(...)` regex |
| Model-based | Class names matching `Guard`, `Middleware`, `Interceptor`, `Filter`, `Pipe`, `Strategy` |

**Middleware classification**: 7 types via name-pattern matching: `auth`, `validation`, `logging`, `error-handler`, `cors`, `rate-limit`, `general`.

**Auth strategy detection (5 strategies)**:

| Strategy | File Indicators | Content Indicators |
|----------|-----------------|--------------------|
| JWT | `jwt`, `token` in filename | `jsonwebtoken`, `jwt.sign`, `JwtStrategy`, `JwtAuthGuard` |
| Session | `session` in filename | `express-session`, `cookie-session`, `req.session` |
| OAuth | `oauth`, `passport` in filename | `passport`, `OAuth2Strategy`, `@nestjs/passport` |
| API Key | `api-key` in filename | `x-api-key`, `apiKey`, `api_key` |
| Basic | `basic-auth` in filename | `basic-auth`, `BasicAuthGuard`, `Authorization.*Basic` |

**Error handler detection**: Matches Express-style 4-parameter functions `(err, req, res, next)`.

**Deduplication**: By `name:file` composite key.

### 2.4 Code Summarizer

**File**: `src/services/analyzers/code-summarizer.ts` (~250 lines, new)

Generates concise 1-2 sentence summaries for key files using LLM with content-hash caching.

**Design**: Dependency injection via `SummarizeFunction = (prompt: string) => Promise<string>` — decouples from LLM infrastructure for testability.

**Cache**: In-memory `Map<file, { summary, expiry }>` with content-hash validation (MD5, first 12 hex chars) and 30-minute TTL. Cache invalidated on content change or TTL expiry.

**Batching**: Files processed in batches of ≤5 per LLM call. Prompt includes truncated file content (≤3000 chars) with language tag. Response expected as JSON array.

**Fallback chain**:
1. Parse LLM response as JSON array
2. Strip markdown fences, retry JSON parse
3. Line-by-line regex (`filename: summary text`)
4. Heuristic summary (export names + framework patterns)

### 2.5 Integration

**Worker integration** (`codebase-analysis.worker.ts`):
- `analyzeFileContents` now collects `fileImports: FileImportData[]` from tree-sitter import extraction
- New Step 8 in `performAnalysis` runs all 3 detectors with individual try/catch:
  - `detectArchitecture(partialResult)` → `architectureReport`
  - `buildCallGraph(fileImports, workspacePath)` → `callGraphSummary`
  - `detectMiddleware(files, codeSnippets, dataModels)` → `middlewareSummary`

**Context generation** (`architectural-recommendation.ts`):
- 3 new section generators: `generateArchitectureSection`, `generateCallGraphSection`, `generateMiddlewareSection`
- Sections 9-11 (Architecture Patterns, Import Graph & Hot Nodes, Middleware & Auth)
- File structure moved to section 12

**Interface types** (`analysis.interface.ts`):
- Added: `ArchitecturalPatternData`, `CallGraphSummary`, `MiddlewareSummary`
- Extended `AnalysisResult` and `CachedAnalysis` with optional Phase 2 fields

**Token budget** (`token-budget.ts`):
- Split `architecture: 0.094` into `architecture: 0.050`, `callGraph: 0.022`, `middleware: 0.022`
- Now 12 categories (was 10), weights sum ≈ 0.987

---

## Phase 3: Multi-pass Analysis (In Progress)

**Goal**: Two-stage analysis pipeline — score/rank files by question relevance (Stage 1), then build focused context for the LLM (Stage 2).

### 3.1 Question-Relevance Analyzer

**File**: `src/services/analyzers/question-relevance.ts` (~340 lines, new)

Stage 1 analyzes the user question to identify and rank the most relevant files, endpoints, models, and sections.

**Keyword extraction**: Lowercased tokens, stop-word removal (80+ English stop words), deduplication, preserves path-like tokens.

**Domain signal mapping**: 40+ domain terms (e.g., `jwt` → `middleware`, `route` → `endpoints`, `model` → `models`) that identify which analysis sections are relevant to the question.

**Scoring functions (4)**:

| Function | Factors | Caps |
|----------|---------|------|
| `scoreFile` | Path keyword match (+3), content keyword match (+1), entry point bonus (+2), hot node bonus (+2) | Content hits capped at 5 |
| `scoreEndpoint` | Path keyword match (+3), handler keyword match (+2) | — |
| `scoreModel` | Name match (+4), member/property match (+1) | Member hits capped at 3 |
| `analyzeQuestion` | Orchestrates all scoring, produces `QuestionAnalysis` | — |

**Cache**: In-memory `Map<questionHash, { qa, ts }>` with 5-minute TTL. Hash uses `Math.imul(31, h)` string hash. Bounded at 100 entries with stale eviction.

### 3.2 Focused Context Builder

**`buildFocusedContext(analysis, qa) → FocusedContext`**

Two-tier file selection:
- **Full code tier** (top 3 files): Complete source code included in context
- **Summary tier** (next 7 files): Summary string only (from Phase 2's `CodeSummarizer`)

Also includes: scored endpoints, scored models, related dependencies (hot nodes overlapping top files), boosted section names.

### 3.3 Integration

**Context generation** (`architectural-recommendation.ts`):
- `createContextFromAnalysis` now accepts `userQuestion` (passed from call site)
- When question is provided: runs `analyzeQuestionCached` → `buildFocusedContext` → `generateFocusedContextSection`
- Focused context is prepended as "## Question-Focused Context" before the 12 budget-managed sections
- Uses `codeSnippets` budget allocation for the focused section (largest share: 40%)
- Logs Phase 3 diagnostics: file counts, endpoint/model counts, boosted sections

### 3.4 Planned Enhancements
- Stage 1 LLM call for semantic question analysis (beyond keyword matching)
- Import proximity scoring (files importing top-ranked files get bonus)
- Recency-of-changes scoring (recently modified files rank higher)

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
| Two-stage LLM doubles latency | Cache Stage 1 results by question hash (5-min TTL, bounded at 100) | ✅ Resolved |
| Large codebases timeout | `MAX_IMPORT_FILES_FOR_CALL_GRAPH = 2000` cap + smart sampling | ✅ Resolved |
| Use-after-dispose in call graph | Extract summary values before `disposeCallGraph()`, clone `hotNodes` | ✅ Resolved |
| Ambiguous file path matching | `shortFilePath` collision guard — skip when multiple candidates share suffix | ✅ Resolved |
| Unbounded regex scan in middleware | `MAX_SNIPPET_SCAN_CHARS = 5000` truncation in `detectAuthStrategies` | ✅ Resolved |

---

## References

- Tree-sitter analyzer: `src/services/analyzers/tree-sitter-analyzer.ts`
- Token budget: `src/services/analyzers/token-budget.ts`
- Architecture detector: `src/services/analyzers/architecture-detector.ts`
- Call graph builder: `src/services/analyzers/call-graph.ts`
- Middleware detector: `src/services/analyzers/middleware-detector.ts`
- Code summarizer: `src/services/analyzers/code-summarizer.ts`
- Question relevance: `src/services/analyzers/question-relevance.ts`
- Worker: `src/workers/codebase-analysis.worker.ts`
- Context generation: `src/commands/architectural-recommendation.ts`
- Shared types: `src/interfaces/analysis.interface.ts`
- Worker logger: `src/infrastructure/logger/worker-logger.ts`
- Tests: `src/test/suite/{token-budget,tree-sitter-analyzer,codebase-analysis-worker-utils,architectural-recommendation-utils,architecture-detector,call-graph,middleware-detector,code-summarizer,question-relevance}.test.ts`
