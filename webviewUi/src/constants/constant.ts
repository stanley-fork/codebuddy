import { FAQItem } from "../components/accordion";

export const modelOptions = [
  {
    value: "Gemini",
    label: "Google Gemini",
    pricingHint: "from $0.08/1M tokens",
  },
  {
    value: "Anthropic",
    label: "Anthropic Claude",
    pricingHint: "from $0.25/1M tokens",
  },
  { value: "Groq", label: "Groq (Llama)", pricingHint: "from $0.05/1M tokens" },
  { value: "Deepseek", label: "Deepseek", pricingHint: "from $0.14/1M tokens" },
  { value: "OpenAI", label: "OpenAI", pricingHint: "from $0.15/1M tokens" },
  { value: "Qwen", label: "Alibaba Qwen", pricingHint: "from $0.30/1M tokens" },
  { value: "GLM", label: "Zhipu GLM", pricingHint: "from $0.007/1M tokens" },
  {
    value: "Local",
    label: "Local (OpenAI Compatible)",
    pricingHint: "free (self-hosted)",
  },
];

/** Per-model pricing (USD per 1M tokens) — mirrors backend CostTrackingService. */
interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const MODEL_PRICING_TABLE: Record<string, ModelPricing> = {
  // Anthropic
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-sonnet-4-20250514": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-opus-4-20250514": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-3-7-sonnet-20250219": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-3-5-sonnet-20241022": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-3-5-haiku-20241022": { inputPerMillion: 0.8, outputPerMillion: 4 },
  "claude-3-haiku-20240307": { inputPerMillion: 0.25, outputPerMillion: 1.25 },
  // OpenAI
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "o3-mini": { inputPerMillion: 1.1, outputPerMillion: 4.4 },
  // Google Gemini
  "gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gemini-2.5-flash": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gemini-2.0-flash": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  "gemini-1.5-flash": { inputPerMillion: 0.075, outputPerMillion: 0.3 },
  // Groq
  "llama-3.3-70b-versatile": { inputPerMillion: 0.59, outputPerMillion: 0.79 },
  "llama-3.1-8b-instant": { inputPerMillion: 0.05, outputPerMillion: 0.08 },
  // DeepSeek
  "deepseek-chat": { inputPerMillion: 0.27, outputPerMillion: 1.1 },
  "deepseek-coder": { inputPerMillion: 0.14, outputPerMillion: 0.28 },
  "deepseek-reasoner": { inputPerMillion: 0.55, outputPerMillion: 2.19 },
  // Qwen
  "qwen-plus": { inputPerMillion: 0.8, outputPerMillion: 2 },
  "qwen-turbo": { inputPerMillion: 0.3, outputPerMillion: 0.6 },
  "qwen-max": { inputPerMillion: 2.4, outputPerMillion: 9.6 },
  // GLM
  "glm-4-plus": { inputPerMillion: 0.7, outputPerMillion: 0.7 },
  "glm-4-flash": { inputPerMillion: 0.007, outputPerMillion: 0.007 },
};

/** Computes what a token count would cost on a different model. */
export function estimateCostForModel(
  modelKey: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = MODEL_PRICING_TABLE[modelKey];
  if (!pricing) return null;
  return (
    (inputTokens * pricing.inputPerMillion +
      outputTokens * pricing.outputPerMillion) /
    1_000_000
  );
}

/** Representative "cheap" alternative per provider for cost comparison. */
export const BUDGET_ALTERNATIVES: Record<
  string,
  { model: string; label: string }
> = {
  Anthropic: { model: "claude-3-5-haiku-20241022", label: "Haiku 3.5" },
  OpenAI: { model: "gpt-4o-mini", label: "GPT-4o Mini" },
  Gemini: { model: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  Groq: { model: "llama-3.1-8b-instant", label: "Llama 3.1 8B" },
  Deepseek: { model: "deepseek-coder", label: "DeepSeek Coder" },
  Qwen: { model: "qwen-turbo", label: "Qwen Turbo" },
  GLM: { model: "glm-4-flash", label: "GLM-4 Flash" },
};

export const codeBuddyMode = [
  { value: "Agent", label: "Agent" },
  { value: "Ask", label: "Ask" },
];

export const themeOptions = [
  { value: "tokyo night", label: "Tokyo Night" },
  { value: "Atom One Dark", label: "Atom One Dark" },
  { value: "github dark", label: "GitHub Dark" },
  { value: "night owl", label: "Night Owl" },
  { value: "stackoverflow", label: "Stack Overflow" },
  { value: "Code Pen", label: "Code Pen" },
  { value: "ir black", label: "IR Black" },
  { value: "felipec", label: "Felipec" },
  { value: "Atom One Dark Reasonable", label: "Atom One Dark Reasonable" },
];

export const PREDEFINED_LOCAL_MODELS = [
  {
    value: "qwen2.5-coder",
    label: "Qwen 2.5 Coder (7B)",
    description: "Excellent for code tasks - Recommended",
  },
  {
    value: "qwen2.5-coder:3b",
    label: "Qwen 2.5 Coder (3B)",
    description: "Faster, lighter coding model",
  },
  {
    value: "llama3.2",
    label: "Llama 3.2 (3B)",
    description: "Efficient general purpose model",
  },
  {
    value: "deepseek-coder",
    label: "DeepSeek Coder",
    description: "Strong code completion capabilities",
  },
  {
    value: "codellama",
    label: "CodeLlama (7B)",
    description: "Meta's code-focused model",
  },
];

export const faqItems: FAQItem[] = [
  {
    question: "HOW DO I SET UP CODEBUDDY?",
    answer: `<p>Setting up CodeBuddy is simple:</p>
      <ol>
        <li>Install the CodeBuddy extension from the VS Code Marketplace</li>
        <li>Open the CodeBuddy sidebar by clicking its icon in the Activity Bar</li>
        <li>Click the <strong>gear icon (⚙️)</strong> to open Settings</li>
        <li>Under <strong>Models</strong>, choose a provider: Gemini, Anthropic, DeepSeek, OpenAI, Qwen, GLM, Groq, XGrok, or <strong>Local</strong></li>
        <li>Enter your API key (or Base URL for local models)</li>
        <li>Start chatting or switch to <strong>Agent mode</strong> for autonomous coding</li>
      </ol>
      <p><strong>Quick start with a local model:</strong> Go to Settings → Local Models, click "Start Server," pull a model (e.g. Qwen 2.5 Coder), and click "Use." No API key needed.</p>`,
  },
  {
    question: "WHICH AI MODELS ARE SUPPORTED?",
    answer: `<p>CodeBuddy supports <strong>8 cloud providers</strong> and <strong>local models</strong> — all usable in both Chat and Agent modes:</p>
      <h3>Cloud Providers</h3>
      <ul>
        <li><strong>Google Gemini</strong> — Gemini 2.5 Pro, 2.5 Flash, 2.0 Flash, 1.5 Flash</li>
        <li><strong>Anthropic Claude</strong> — Claude Sonnet 4, Opus 4, 3.7 Sonnet, 3.5 Haiku</li>
        <li><strong>OpenAI</strong> — GPT-4o, GPT-4o Mini, o3-mini</li>
        <li><strong>DeepSeek</strong> — DeepSeek Chat (V3), Coder, Reasoner (R1)</li>
        <li><strong>Groq</strong> — Llama 3.3 70B, Llama 3.1 8B (ultra-fast inference)</li>
        <li><strong>Alibaba Qwen</strong> — Qwen Max, Plus, Turbo</li>
        <li><strong>Zhipu GLM</strong> — GLM-4 Plus, GLM-4 Flash (very low cost)</li>
        <li><strong>XGrok (xAI)</strong> — Grok models</li>
      </ul>
      <h3>Local Models (Privacy-First via Ollama)</h3>
      <ul>
        <li><strong>Qwen 2.5 Coder 7B</strong> — Excellent for coding tasks (recommended)</li>
        <li><strong>Qwen 2.5 Coder 3B</strong> — Lighter and faster</li>
        <li><strong>DeepSeek Coder</strong> — Strong on coding benchmarks</li>
        <li><strong>CodeLlama 7B</strong> — Meta's code-focused model</li>
        <li><strong>Llama 3.2 3B</strong> — General-purpose, handles code well</li>
      </ul>
      <p><strong>Tip:</strong> Each model shows real-time cost estimates. Check Settings → Models to compare pricing per 1M tokens.</p>`,
  },
  {
    question: "CHAT MODE VS AGENT MODE — WHAT'S THE DIFFERENCE?",
    answer: `<p>CodeBuddy offers two distinct modes you can switch between using the dropdown at the top of the sidebar:</p>
      <h3>Chat Mode (Ask)</h3>
      <ul>
        <li>Ask questions, get code snippets, understand concepts</li>
        <li><strong>Read-only</strong> — the AI cannot modify files or run commands</li>
        <li>Faster responses, less overhead</li>
        <li>Best for: quick answers, learning, code review feedback</li>
      </ul>
      <h3>Agent Mode</h3>
      <ul>
        <li><strong>Autonomous execution:</strong> reads/writes files, runs terminal commands, searches the web</li>
        <li>Built on <strong>LangGraph</strong> — multi-step reasoning with 25+ tools</li>
        <li>Multi-file operations via the <strong>Composer</strong> (atomic file edits)</li>
        <li>Full debugger integration (breakpoints, variables, stack traces)</li>
        <li>Test runner integration (run and analyze test results)</li>
        <li>Approval system — review actions before they execute, or enable auto-approve</li>
        <li>Best for: feature implementation, refactoring, debugging, project-wide changes</li>
      </ul>
      <h3>Safety Controls</h3>
      <ul>
        <li><strong>Auto-approve:</strong> Off by default. Enable in Settings → Agents to skip confirmation prompts</li>
        <li><strong>File edits:</strong> Toggleable via <code>codebuddy.allowFileEdits</code></li>
        <li><strong>Terminal access:</strong> Toggleable via <code>codebuddy.allowTerminal</code></li>
        <li><strong>Diff approval:</strong> Require explicit approval before applying diffs</li>
      </ul>`,
  },
  {
    question: "WHAT TOOLS DOES THE AGENT HAVE ACCESS TO?",
    answer: `<p>In Agent mode, the AI has access to <strong>25+ built-in tools</strong> plus any MCP server tools you add:</p>
      <h3>File & Code</h3>
      <ul>
        <li><strong>analyze_files_for_question</strong> — Read and analyze code files</li>
        <li><strong>edit_file</strong> — Create and modify files with precision</li>
        <li><strong>list_files</strong> — Browse directory structure</li>
        <li><strong>compose_files</strong> — Atomic multi-file edits (Composer)</li>
        <li><strong>ripgrep_search</strong> — Fast code search via ripgrep</li>
        <li><strong>search_symbols</strong> — Find functions, classes, variables by name</li>
        <li><strong>search_vector_db</strong> — Semantic code search via workspace index</li>
        <li><strong>get_architecture_knowledge</strong> — Analyze codebase architecture patterns</li>
      </ul>
      <h3>Execution & Debugging</h3>
      <ul>
        <li><strong>terminal</strong> — Execute shell commands</li>
        <li><strong>deep_terminal</strong> — Advanced terminal with output parsing</li>
        <li><strong>run_tests</strong> — Run and analyze test results</li>
        <li><strong>get_diagnostics</strong> — Get VS Code linting errors/warnings</li>
        <li><strong>debug_get_state / debug_control / debug_evaluate</strong> — Full VS Code debugger integration</li>
        <li><strong>debug_get_stack_trace / debug_get_variables</strong> — Inspect runtime state</li>
      </ul>
      <h3>Git & Web</h3>
      <ul>
        <li><strong>git</strong> — Commit, branch, status, history</li>
        <li><strong>web_search</strong> — Search for docs, solutions, best practices</li>
        <li><strong>open_web_preview</strong> — Preview URLs and web content</li>
      </ul>
      <h3>Intelligence & Memory</h3>
      <ul>
        <li><strong>standup_intelligence</strong> — Generate and query standup reports</li>
        <li><strong>team_graph</strong> — Query team knowledge graph (profiles, blockers, trends)</li>
        <li><strong>manage_core_memory</strong> — Store and retrieve persistent project notes</li>
        <li><strong>manage_tasks</strong> — Track TODO items</li>
        <li><strong>think</strong> — Internal reasoning and planning</li>
      </ul>
      <p>Plus all tools from your <strong>MCP servers</strong> are automatically available to the agent.</p>`,
  },
  {
    question: "HOW DOES INLINE CODE COMPLETION WORK?",
    answer: `<p>CodeBuddy offers <strong>Fill-in-the-Middle (FIM)</strong> inline code completion — ghost text suggestions as you type, similar to GitHub Copilot:</p>
      <h3>Setup</h3>
      <ol>
        <li>Go to Settings → search <code>codebuddy.completion</code></li>
        <li>Enable <code>codebuddy.completion.enabled</code> (on by default)</li>
        <li>Choose a <strong>completion provider</strong> — can be different from your chat model</li>
        <li>For best results with local: use <strong>Qwen 2.5 Coder</strong> via Ollama</li>
      </ol>
      <h3>Configuration</h3>
      <ul>
        <li><strong>Provider:</strong> Gemini, Groq, Anthropic, DeepSeek, OpenAI, Qwen, GLM, or Local</li>
        <li><strong>Trigger mode:</strong> <code>automatic</code> (as you type) or <code>manual</code></li>
        <li><strong>Debounce:</strong> 300ms default — waits before triggering to avoid excessive calls</li>
        <li><strong>Max tokens:</strong> 128 default — controls suggestion length</li>
        <li><strong>Multi-line:</strong> Enabled by default for multi-line suggestions</li>
      </ul>
      <p><strong>Tip:</strong> Use a fast, cheap model for completions (e.g., Groq Llama 3.1 8B or local Qwen 2.5 Coder 3B) while keeping a stronger model for chat/agent.</p>`,
  },
  {
    question: "WHAT IS WORKSPACE INDEXING?",
    answer: `<p>Workspace indexing creates a <strong>semantic search index</strong> of your codebase, letting CodeBuddy find relevant code by meaning rather than just keywords:</p>
      <h3>How to Index</h3>
      <ol>
        <li>Run <strong>CodeBuddy: Index Workspace</strong> from the Command Palette (<code>Cmd/Ctrl+Shift+P</code>)</li>
        <li>CodeBuddy crawls your workspace, parses supported files, and generates embeddings</li>
        <li>The index is stored locally in a SQLite vector database</li>
      </ol>
      <h3>Supported File Types</h3>
      <p><code>.ts</code>, <code>.js</code>, <code>.tsx</code>, <code>.jsx</code>, <code>.py</code>, <code>.java</code>, <code>.go</code>, <code>.rs</code>, <code>.cpp</code>, <code>.c</code>, <code>.h</code></p>
      <h3>Configuration</h3>
      <ul>
        <li><strong>Embedding model:</strong> Gemini, OpenAI, or local embeddings</li>
        <li><strong>Batch size:</strong> 10 files at a time (configurable)</li>
        <li><strong>Search result limit:</strong> 8 results per query (configurable)</li>
        <li><strong>Performance mode:</strong> Balanced, Performance, or Memory-optimized</li>
        <li><strong>Keyword fallback:</strong> Falls back to keyword search if embeddings fail</li>
      </ul>
      <p>Once indexed, both Chat and Agent mode automatically use the index for context retrieval.</p>
      <p><strong>Tip:</strong> Create a <code>.codebuddyignore</code> file (like .gitignore) to exclude files from indexing.</p>`,
  },
  {
    question: "WHAT IS MEETING INTELLIGENCE?",
    answer: `<p>Meeting Intelligence automatically extracts structured data from your team's standup notes and builds a persistent <strong>Team Knowledge Graph</strong>:</p>
      <h3>What It Extracts</h3>
      <ul>
        <li><strong>Participants</strong> — who attended the meeting</li>
        <li><strong>Commitments</strong> — action items with owners, deadlines, ticket IDs, and status</li>
        <li><strong>Blockers</strong> — who's blocked, by what, and why</li>
        <li><strong>Decisions</strong> — agreed-upon outcomes</li>
        <li><strong>Ticket mentions</strong> — referenced issue/MR IDs</li>
        <li><strong>Relationships</strong> — who reviews for whom, mentors, dependencies</li>
      </ul>
      <h3>Team Knowledge Graph</h3>
      <p>Data is persisted in a local SQLite database with 7 tables tracking:</p>
      <ul>
        <li>Team member profiles, roles, traits, and expertise areas</li>
        <li>Collaboration edges (who works with whom)</li>
        <li>Commitment and completion trends over time</li>
        <li>Recurring blockers and team health metrics</li>
      </ul>
      <h3>Agent Integration</h3>
      <p>The agent's <strong>team_graph</strong> tool queries this data — ask things like:</p>
      <ul>
        <li>"What is Alice's current workload?"</li>
        <li>"Who are the top collaborators on the team?"</li>
        <li>"What are the recurring blockers this sprint?"</li>
        <li>"Show me the history of ticket #100"</li>
      </ul>`,
  },
  {
    question: "WHAT AUTOMATIONS ARE AVAILABLE?",
    answer: `<p>CodeBuddy provides five <strong>scheduled automations</strong> that run in the background to keep you informed. All are configurable in Settings:</p>
      <h3>Daily Standup Report</h3>
      <p>Auto-generates a standup summary from git commits, recent chat context, active errors, modified files, and ticket references.</p>
      <h3>Code Health Check</h3>
      <p>Scans for TODOs, excessively large files, code complexity, and tech debt. Tracks metrics over time. Configurable thresholds:</p>
      <ul>
        <li>Hotspot minimum changes: 3 (default)</li>
        <li>Large file threshold: 300 lines (default)</li>
      </ul>
      <h3>Dependency Check</h3>
      <p>Detects wildcard versions, outdated packages, and security vulnerabilities. Auto-detects npm/yarn/pnpm.</p>
      <h3>Git Watchdog</h3>
      <p>Monitors uncommitted changes (alerts after 2+ hours without commit), checks branch hygiene, detects upstream divergence. Configure protected branch patterns (e.g., <code>main</code>, <code>feature/*</code>).</p>
      <h3>End-of-Day Summary</h3>
      <p>Compiles commits, files touched, error count, lines changed, current branch, and uncommitted work into a daily summary.</p>
      <p>Enable/disable each in <strong>Settings → Automations</strong> or via <code>codebuddy.automations.*</code> settings.</p>`,
  },
  {
    question: "WHAT ARE MCP SERVERS?",
    answer: `<p><strong>MCP (Model Context Protocol)</strong> servers extend the agent's capabilities by providing additional tools from external services:</p>
      <h3>What MCP Servers Do</h3>
      <ul>
        <li>Give the agent access to external services (databases, APIs, browsers, etc.)</li>
        <li>Each server provides one or more <strong>tools</strong> the agent can invoke</li>
        <li>Tools appear alongside built-in tools when the agent needs them</li>
      </ul>
      <h3>Built-in Preset: Playwright Browser</h3>
      <p>One-click setup for browser automation — navigate URLs, click elements, fill forms, take screenshots, and execute JavaScript in headless Chromium.</p>
      <h3>How to Add MCP Servers</h3>
      <ol>
        <li>Go to <strong>Settings → MCP</strong></li>
        <li>Click <strong>"Add Server"</strong></li>
        <li>Enter the server name and configuration (stdio command or SSE URL)</li>
        <li>The server's tools become available to the agent immediately</li>
      </ol>
      <h3>Technical Features</h3>
      <ul>
        <li><strong>Circuit breaker pattern</strong> — prevents retry storms on failing servers</li>
        <li><strong>Connection pooling</strong> with idle timeout</li>
        <li><strong>Tool caching</strong> per server for fast repeated access</li>
        <li><strong>SSE and stdio transport</strong> support</li>
        <li><strong>Per-tool enable/disable</strong> in settings</li>
      </ul>
      <p>MCP is an open protocol — community-created servers work seamlessly with CodeBuddy.</p>`,
  },
  {
    question: "HOW DOES CODE ANALYSIS WORK?",
    answer: `<p>CodeBuddy uses <strong>Tree-sitter</strong> parsers for deep, language-aware code analysis across your workspace:</p>
      <h3>Supported Languages</h3>
      <p>JavaScript, TypeScript, Python, Java, Go, Rust, PHP, C, C++</p>
      <h3>Architecture Intelligence</h3>
      <ul>
        <li><strong>Entry point detection</strong> — functions with no callers</li>
        <li><strong>Middleware identification</strong> — Express/Koa/etc. middleware chains</li>
        <li><strong>API endpoint cataloging</strong> — REST routes and handlers</li>
        <li><strong>Authentication flow mapping</strong></li>
        <li><strong>Design pattern detection</strong> — 20+ patterns (MVC, Observer, Factory, Singleton, Builder, etc.)</li>
        <li><strong>Call graph analysis</strong> — function/method dependency trees</li>
        <li><strong>Data model/schema inference</strong></li>
      </ul>
      <h3>Commands</h3>
      <ul>
        <li><strong>Cmd+Shift+6</strong> — Full codebase analysis (architecture, patterns, dependencies)</li>
        <li><strong>Generate Mermaid Diagram</strong> (<strong>Cmd+Shift+7</strong>) — Visual architecture diagrams from code</li>
        <li><strong>Architectural Recommendation</strong> — AI-powered architecture suggestions</li>
      </ul>
      <p>The agent also uses architecture knowledge automatically when answering questions about your codebase.</p>`,
  },
  {
    question: "HOW DOES THE COMPOSER WORK?",
    answer: `<p>The <strong>Composer</strong> lets the agent make coordinated, multi-file edits that you can review before applying:</p>
      <h3>How It Works</h3>
      <ol>
        <li>The agent generates changes across multiple files as a single session</li>
        <li>Changes appear in the <strong>Pending Changes Panel</strong> with visual diffs</li>
        <li>Review each file's changes individually</li>
        <li>Click <strong>Apply</strong> to accept or <strong>Reject</strong> to discard</li>
      </ol>
      <h3>Features</h3>
      <ul>
        <li><strong>Atomic sessions</strong> — all changes grouped together</li>
        <li><strong>Visual diff preview</strong> — side-by-side comparison with syntax highlighting</li>
        <li><strong>Partial acceptance</strong> — accept changes per file</li>
        <li><strong>Inline review comments</strong> — the AI annotates its changes with severity levels (🔴 Critical, 🟡 Moderate, 🔵 Minor, ℹ️ Info)</li>
      </ul>
      <p><strong>Tip:</strong> Enable <code>codebuddy.requireDiffApproval</code> to always preview diffs before they're applied.</p>`,
  },
  {
    question: "WHAT COMMANDS AND KEYBOARD SHORTCUTS ARE AVAILABLE?",
    answer: `<p>All commands are accessible via the <strong>Command Palette</strong> (<code>Cmd/Ctrl+Shift+P</code>) — search "CodeBuddy":</p>
      <h3>Code Actions (select code first)</h3>
      <ul>
        <li><strong>Explain Code</strong> — <code>Cmd+Shift+1</code></li>
        <li><strong>Add Comment</strong> — <code>Cmd+Shift+J</code></li>
        <li><strong>Review Code</strong> — <code>Cmd+Shift+R</code></li>
        <li><strong>Refactor</strong> — <code>Cmd+Shift+;</code></li>
        <li><strong>Optimize</strong> — <code>Cmd+Shift+0</code></li>
        <li><strong>Generate Diagram</strong> — <code>Cmd+Shift+7</code></li>
      </ul>
      <h3>Global Commands</h3>
      <ul>
        <li><strong>Generate Commit Message</strong> — <code>Cmd+Shift+2</code></li>
        <li><strong>Codebase Analysis</strong> — <code>Cmd+Shift+6</code></li>
        <li><strong>Inline Chat</strong> — <code>Cmd+Shift+8</code></li>
        <li><strong>Open Project Rules</strong> — <code>Cmd+Shift+9</code></li>
      </ul>
      <h3>Additional Commands (no shortcut — use Command Palette)</h3>
      <ul>
        <li><strong>Generate Unit Test</strong> — Supports Jest, Vitest, Mocha, Pytest, Go, Cargo</li>
        <li><strong>Generate Documentation</strong> — README, API docs, architecture docs</li>
        <li><strong>Review Pull Request</strong> — AI-powered PR review via git diff</li>
        <li><strong>Interview Me</strong> — Technical interview practice (beginner/intermediate/senior)</li>
        <li><strong>Index Workspace</strong> — Build semantic search index</li>
        <li><strong>Create Branch from Jira / GitLab</strong> — Branch from tickets</li>
        <li><strong>Architectural Recommendation</strong> — Design pattern suggestions</li>
      </ul>
      <p><strong>Tip:</strong> Right-click selected code for quick access to code actions via the context menu. On Windows, replace <code>Cmd</code> with <code>Ctrl</code>.</p>`,
  },
  {
    question: "HOW DO I INSTALL LOCAL MODELS?",
    answer: `<p>Local models run entirely on your machine — no API key needed, no data sent externally.</p>
      <h3>Option 1: CodeBuddy Settings UI (Easiest)</h3>
      <ol>
        <li>Go to <strong>Settings → Local Models</strong></li>
        <li>Click <strong>"Start Server"</strong> to launch Ollama via Docker Compose</li>
        <li>Select a model (e.g. Qwen 2.5 Coder) and click <strong>"Pull"</strong></li>
        <li>Click <strong>"Use"</strong> — CodeBuddy auto-configures the endpoint</li>
      </ol>
      <h3>Option 2: Ollama (Manual)</h3>
      <ol>
        <li>Install from <a href="https://ollama.com">ollama.com</a></li>
        <li>Run: <code>ollama run qwen2.5-coder</code></li>
        <li>In CodeBuddy settings: Provider → <strong>Local</strong>, Base URL → <code>http://localhost:11434/v1</code></li>
      </ol>
      <h3>Option 3: LM Studio</h3>
      <ol>
        <li>Install from <a href="https://lmstudio.ai">lmstudio.ai</a></li>
        <li>Load a model and start the local server</li>
        <li>Use the URL it provides (usually <code>http://localhost:1234/v1</code>)</li>
      </ol>
      <p><strong>Recommended models for coding:</strong> Qwen 2.5 Coder 7B (best quality), Qwen 2.5 Coder 3B (fastest), DeepSeek Coder, CodeLlama 7B.</p>
      <p>Local models work with <strong>all features</strong>: Chat, Agent, and Inline Completion.</p>`,
  },
  {
    question: "HOW DOES THE INTERVIEW MODE WORK?",
    answer: `<p>CodeBuddy's <strong>Interview Me</strong> command turns the AI into a technical interviewer to help you practice:</p>
      <h3>Difficulty Levels</h3>
      <ul>
        <li><strong>Beginner (1–2 years):</strong> Basic concepts, code understanding, simple problems</li>
        <li><strong>Intermediate (3–5 years):</strong> Design decisions, improvements, moderate complexity</li>
        <li><strong>Senior (5+ years):</strong> System architecture, technical leadership, scalability</li>
      </ul>
      <h3>Assessment Areas</h3>
      <ul>
        <li><strong>Technical Proficiency (30%)</strong> — Language, algorithms, data structures</li>
        <li><strong>System Design (30%)</strong> — Architecture, scalability, trade-offs</li>
        <li><strong>Problem-Solving (25%)</strong> — Debugging, optimization, edge cases</li>
        <li><strong>Testing (15%)</strong> — Strategy, coverage, quality assurance</li>
      </ul>
      <p>Select code and run <strong>CodeBuddy: Interview Me</strong> from the Command Palette to start a session.</p>`,
  },
  {
    question: "WHAT IS THE CHAT CONTEXT AND HOW DO @ MENTIONS WORK?",
    answer: `<p>Chat context determines what code the AI sees when answering your questions. CodeBuddy uses a <strong>priority-based context system</strong>:</p>
      <h3>Context Sources (in priority order)</h3>
      <ol>
        <li><strong>@ Mentioned Files</strong> — Type <code>@</code> in the chat input to fuzzy-search and select files</li>
        <li><strong>Active File</strong> — The file open in your editor (auto-included)</li>
        <li><strong>Auto-Gathered</strong> — Relevant snippets found via semantic search (when workspace is indexed)</li>
      </ol>
      <h3>@ Mention Features</h3>
      <ul>
        <li>Fuzzy search with file icons and full paths</li>
        <li>Keyboard navigation (↑/↓ arrows + Enter)</li>
        <li>Smart deduplication — won't add the same file twice</li>
      </ul>
      <h3>Smart Token Management</h3>
      <ul>
        <li>Automatically adjusts context size based on your model's limits</li>
        <li>Extracts function signatures and key blocks rather than full files when space is limited</li>
        <li>Context window configurable: 4K, 8K, 16K, 32K, or 128K tokens</li>
      </ul>`,
  },
  {
    question: "WHAT ARE CUSTOM RULES?",
    answer: `<p>Custom rules let you define <strong>project-specific instructions</strong> that the AI follows in every response:</p>
      <h3>How Rules Work</h3>
      <ul>
        <li>Stored in <code>.codebuddy/rules/</code> in your workspace</li>
        <li>Appended to the system prompt — the AI always respects them</li>
        <li>Toggleable — enable/disable without deleting</li>
      </ul>
      <h3>Example Rules</h3>
      <ul>
        <li>"Use functional components over class components"</li>
        <li>"Follow our naming conventions: camelCase for variables, PascalCase for components"</li>
        <li>"Always add error handling with try/catch blocks"</li>
        <li>"Prefer TypeScript strict mode configurations"</li>
        <li>"Write unit tests for all new functions"</li>
      </ul>
      <h3>Commands</h3>
      <ul>
        <li><strong>Cmd+Shift+9</strong> — Open project rules</li>
        <li><strong>Initialize Project Rules</strong> — Creates a rules.md template</li>
        <li><strong>Reload Project Rules</strong> — Refreshes rules from file</li>
      </ul>
      <p>Configure in <strong>Settings → Rules & Subagents</strong>.</p>`,
  },
  {
    question: "HOW DOES COST TRACKING WORK?",
    answer: `<p>CodeBuddy tracks and displays <strong>real-time token costs</strong> for every interaction:</p>
      <h3>What You See</h3>
      <ul>
        <li>Total tokens used (input + output breakdown)</li>
        <li>Estimated USD cost per message</li>
        <li>Model name and provider</li>
        <li>Live streaming indicator</li>
      </ul>
      <h3>Cost Comparison</h3>
      <p>After each response, CodeBuddy shows what the same request would have cost on <strong>budget alternatives</strong>:</p>
      <ul>
        <li>Anthropic → Haiku 3.5</li>
        <li>OpenAI → GPT-4o Mini</li>
        <li>Gemini → Gemini 2.0 Flash</li>
        <li>Groq → Llama 3.1 8B</li>
        <li>DeepSeek → DeepSeek Coder</li>
        <li>GLM → GLM-4 Flash (from $0.007/1M tokens)</li>
      </ul>
      <p>Pricing is tracked for 35+ models across all providers. Local models show $0.00 cost.</p>`,
  },
  {
    question: "WHAT OBSERVABILITY FEATURES ARE AVAILABLE?",
    answer: `<p>CodeBuddy includes a built-in <strong>Observability Panel</strong> for monitoring performance, traces, and logs:</p>
      <h3>Features</h3>
      <ul>
        <li><strong>Live traces</strong> — View OpenTelemetry spans from your current session</li>
        <li><strong>Historical traces</strong> — Browse past sessions stored in SQLite (configurable retention: 1–90 days)</li>
        <li><strong>Performance profiling</strong> — Span durations, status codes, timing breakdowns</li>
        <li><strong>Application logs</strong> — Recent log entries from the extension</li>
        <li><strong>Session picker</strong> — Switch between past sessions to review traces</li>
      </ul>
      <h3>External Export</h3>
      <p>Export traces to external platforms via <strong>OTLP endpoint</strong> configuration:</p>
      <ul>
        <li>LangFuse, LangSmith, Jaeger, or any OpenTelemetry-compatible collector</li>
        <li>Configure via <code>codebuddy.telemetry.otlpEndpoint</code></li>
      </ul>
      <p>Access the observability panel from the CodeBuddy sidebar.</p>`,
  },
  {
    question: "HOW DO I ACCESS SETTINGS?",
    answer: `<p>Click the <strong>gear icon (⚙️)</strong> in the CodeBuddy sidebar to open the Settings panel:</p>
      <h3>Settings Categories</h3>
      <ul>
        <li><strong>Account</strong> — Profile and account info</li>
        <li><strong>General</strong> — Theme, language (7 languages), font, nickname, streaming</li>
        <li><strong>Models</strong> — AI provider selection, API keys, model choice</li>
        <li><strong>Agents</strong> — Agent mode behavior, safety limits, auto-approve, file/terminal permissions</li>
        <li><strong>MCP</strong> — Manage Model Context Protocol servers</li>
        <li><strong>Context</strong> — Context window size, workspace indexing, vector DB settings</li>
        <li><strong>Conversation</strong> — Chat display preferences, history management</li>
        <li><strong>Rules & Subagents</strong> — Custom rules and specialized agents</li>
        <li><strong>Automations</strong> — Daily standup, code health, dependency check, git watchdog, end-of-day summary</li>
        <li><strong>Privacy</strong> — Data privacy, clear chat history</li>
        <li><strong>Beta</strong> — Experimental features</li>
        <li><strong>About</strong> — Version, links, license</li>
      </ul>
      <p>You can also configure settings via VS Code's native settings (<code>Cmd+,</code>) — search for <code>codebuddy</code>.</p>`,
  },
  {
    question: "HOW DO SESSIONS WORK?",
    answer: `<p>CodeBuddy organizes your conversations into <strong>sessions</strong> — each with its own chat history and context:</p>
      <ul>
        <li><strong>Create</strong> new sessions for different tasks or topics</li>
        <li><strong>Switch</strong> between sessions without losing context</li>
        <li><strong>Rename</strong> sessions for easy identification</li>
        <li><strong>Delete</strong> sessions you no longer need</li>
      </ul>
      <p>Sessions are stored locally in the <code>.codebuddy</code> folder (automatically gitignored). Access the sessions panel from the CodeBuddy sidebar.</p>`,
  },
  {
    question: "DATA PRIVACY",
    answer: `<p>CodeBuddy is designed with privacy as a core principle:</p>
      <h3>What Stays Local</h3>
      <ul>
        <li>All chat history, sessions, and settings stored in a local <code>.codebuddy</code> folder (auto-gitignored)</li>
        <li>Workspace index and vector database are local SQLite files</li>
        <li>Team knowledge graph is stored locally per workspace</li>
        <li>Telemetry traces are stored locally (opt-in external export)</li>
        <li>CodeBuddy itself <strong>does not collect, store, or transmit</strong> your data to any external servers</li>
      </ul>
      <h3>What Goes to AI Providers</h3>
      <ul>
        <li>When using cloud models, your prompts and code context are sent directly to the provider using <strong>your personal API key</strong></li>
        <li>CodeBuddy sends only what's needed: the smart context system limits code sent based on token budgets</li>
      </ul>
      <h3>Maximum Privacy Mode</h3>
      <ul>
        <li>Use <strong>Local models</strong> (Ollama/LM Studio) and <strong>nothing leaves your machine</strong></li>
        <li>Works fully offline without internet</li>
        <li>Zero API costs</li>
      </ul>
      <p>Review the privacy policies of your chosen AI providers for their data handling practices.</p>`,
  },
  {
    question: "APPLICATION GIVES CONTINUOUS ERRORS",
    answer: `<p>Try these troubleshooting steps:</p>
      <ol>
        <li><strong>Check API Key:</strong> Ensure your key is correctly entered and matches your selected provider</li>
        <li><strong>Verify Model Selection:</strong> Make sure the model name is valid for your provider</li>
        <li><strong>Check Connection:</strong> For cloud models, ensure internet connectivity</li>
        <li><strong>Local Model Issues:</strong> Verify Ollama/LM Studio is running and the model is loaded (<code>ollama list</code>)</li>
        <li><strong>Clear Chat History:</strong> Settings → Privacy → Clear Chat History</li>
        <li><strong>Check Logs:</strong> View → Output → select "CodeBuddy" for detailed error logs</li>
        <li><strong>Provider failover:</strong> Enable <code>codebuddy.failover.enabled</code> to auto-switch providers on errors</li>
        <li><strong>Restart VS Code:</strong> Sometimes a fresh restart resolves connection issues</li>
      </ol>
      <p>If issues persist, report them on <a href="https://github.com/olasunkanmi-SE/codebuddy/issues">GitHub Issues</a> with the error details from the Output panel.</p>`,
  },
  {
    question: "CONTRIBUTION",
    answer: `<p>CodeBuddy is open source and we welcome contributions of all kinds:</p>
      <ul>
        <li>Visit our <a href="https://github.com/olasunkanmi-SE/codebuddy">GitHub repository</a> to get started</li>
        <li>Check the issues section for tasks labeled <strong>good first issue</strong></li>
        <li>Fork the repository and submit pull requests</li>
        <li>Contribute code, documentation, translations, or bug reports</li>
        <li>Share feedback and feature ideas through GitHub issues</li>
      </ul>
      <p>CodeBuddy supports <strong>7 languages</strong> (English, Spanish, French, German, Japanese, Yoruba, Chinese) — translation help is always appreciated!</p>
      <p>Whether you're a developer, designer, or have great ideas, your contributions help make CodeBuddy better for everyone.</p>`,
  },
  {
    question: "HOW DO I CONNECT WITH THE FOUNDER?",
    answer: `<p><strong>Oyinlola Olasunkanmi — Creator of CodeBuddy</strong></p>
      <p>Olasunkanmi leads CodeBuddy's development, focusing on building a true AI coding partner that understands your project, anticipates your needs, and respects your privacy.</p>
      <p>Connect with Olasunkanmi:</p>
      <ul>
        <li><a href="https://www.linkedin.com/in/oyinlola-olasunkanmi-raymond-71b6b8aa/">LinkedIn</a></li>
        <li><a href="https://github.com/olasunkanmi-SE">GitHub</a></li>
      </ul>`,
  },
];
