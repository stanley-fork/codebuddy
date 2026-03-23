# Changelog

All notable changes to CodeBuddy are documented in this file.

## [v4.2.0](https://github.com/olasunkanmi-SE/codebuddy/releases/tag/v4.2) — 2026-03-22

### Features

- **Multi-language support (i18n)**: Full internationalization with 7 languages and curated RSS feeds ([#325](https://github.com/olasunkanmi-SE/codebuddy/pull/325))
- **MCP Playwright integration**: Browser automation via Model Context Protocol ([#324](https://github.com/olasunkanmi-SE/codebuddy/pull/324))
- **Browser Automation Tool**: Built-in browser control for agent tasks ([#370](https://github.com/olasunkanmi-SE/codebuddy/pull/370))
- **Onboarding wizard**: Guided first-run setup experience ([#369](https://github.com/olasunkanmi-SE/codebuddy/pull/369))
- **Team graph & standup intelligence**: Team collaboration graph and standup report generation ([#356](https://github.com/olasunkanmi-SE/codebuddy/pull/356), [#357](https://github.com/olasunkanmi-SE/codebuddy/pull/357), [#358](https://github.com/olasunkanmi-SE/codebuddy/pull/358))
- **Doctor command**: Diagnostic health-check command ([#360](https://github.com/olasunkanmi-SE/codebuddy/pull/360))
- **Cost tracking**: LLM token usage and estimated cost tracking ([#334](https://github.com/olasunkanmi-SE/codebuddy/pull/334))
- **Model failover**: Automatic provider failover for both Agent and Ask modes ([#343](https://github.com/olasunkanmi-SE/codebuddy/pull/343), [#344](https://github.com/olasunkanmi-SE/codebuddy/pull/344))
- **Inline review**: In-editor code review experience ([#345](https://github.com/olasunkanmi-SE/codebuddy/pull/345))
- **Architecture sub-agent**: Dedicated agent for architectural analysis ([#346](https://github.com/olasunkanmi-SE/codebuddy/pull/346))
- **Observability & timeline**: OpenTelemetry integration and agent activity timeline ([#342](https://github.com/olasunkanmi-SE/codebuddy/pull/342), [#341](https://github.com/olasunkanmi-SE/codebuddy/pull/341))
- **Context window compaction**: Intelligent context trimming for long conversations ([#355](https://github.com/olasunkanmi-SE/codebuddy/pull/355))
- **Hybrid memory search**: Combined vector + keyword memory retrieval ([#365](https://github.com/olasunkanmi-SE/codebuddy/pull/365))
- **Concurrency queue**: Task queue for managing parallel agent operations ([#367](https://github.com/olasunkanmi-SE/codebuddy/pull/367))
- **Skills enhancement**: Improved skill manager capabilities ([#350](https://github.com/olasunkanmi-SE/codebuddy/pull/350))
- **Research notes**: Research note-taking and aggregation ([#326](https://github.com/olasunkanmi-SE/codebuddy/pull/326))

### Security & Access Control

- **External security config**: JSON-based security configuration ([#359](https://github.com/olasunkanmi-SE/codebuddy/pull/359))
- **Credential proxy**: Secure credential management proxy ([#361](https://github.com/olasunkanmi-SE/codebuddy/pull/361))
- **Permission system**: Granular permission controls ([#362](https://github.com/olasunkanmi-SE/codebuddy/pull/362))
- **Access control**: Role-based access control framework ([#363](https://github.com/olasunkanmi-SE/codebuddy/pull/363))
- **Context isolation**: Sandboxed context for secure multi-tenant use ([#364](https://github.com/olasunkanmi-SE/codebuddy/pull/364))
- **Terminal security**: Hardened terminal command execution ([#332](https://github.com/olasunkanmi-SE/codebuddy/pull/332))

### Improvements

- AI configuration refinements ([#327](https://github.com/olasunkanmi-SE/codebuddy/pull/327))
- Session management enhancements ([#328](https://github.com/olasunkanmi-SE/codebuddy/pull/328))
- Notification system improvements ([#329](https://github.com/olasunkanmi-SE/codebuddy/pull/329))
- Browser optimization ([#340](https://github.com/olasunkanmi-SE/codebuddy/pull/340))
- Multiple file update support ([#336](https://github.com/olasunkanmi-SE/codebuddy/pull/336))
- Code analysis overhaul (3-phase rewrite) ([#347](https://github.com/olasunkanmi-SE/codebuddy/pull/347), [#348](https://github.com/olasunkanmi-SE/codebuddy/pull/348), [#349](https://github.com/olasunkanmi-SE/codebuddy/pull/349))
- Feature audit and cleanup ([#323](https://github.com/olasunkanmi-SE/codebuddy/pull/323), [#333](https://github.com/olasunkanmi-SE/codebuddy/pull/333), [#335](https://github.com/olasunkanmi-SE/codebuddy/pull/335))
- Coworker agent updates ([#331](https://github.com/olasunkanmi-SE/codebuddy/pull/331))

### Bug Fixes

- Fixed initialization issue ([#338](https://github.com/olasunkanmi-SE/codebuddy/pull/338))
- Isolated command chat history to prevent cross-command contamination ([#366](https://github.com/olasunkanmi-SE/codebuddy/pull/366))
- Logger fixes for levels 1-7 and 8-16 ([#354](https://github.com/olasunkanmi-SE/codebuddy/pull/354), [#353](https://github.com/olasunkanmi-SE/codebuddy/pull/353))

### Refactoring

- Refactored base webview class ([#330](https://github.com/olasunkanmi-SE/codebuddy/pull/330))
- Agent service cleanup ([#337](https://github.com/olasunkanmi-SE/codebuddy/pull/337))

**Full Changelog**: [v4.1.0...v4.2](https://github.com/olasunkanmi-SE/codebuddy/compare/v4.1.0...v4.2)

---

## [v4.1.0](https://github.com/olasunkanmi-SE/codebuddy/releases/tag/v4.1.0) — 2026-02-23

### Features

- **Debugger defaults**: Improved default debugger configuration ([#313](https://github.com/olasunkanmi-SE/codebuddy/pull/313))
- **Session management**: Persistent session state across restarts ([#314](https://github.com/olasunkanmi-SE/codebuddy/pull/314))
- **Connector system**: External service connector framework ([#315](https://github.com/olasunkanmi-SE/codebuddy/pull/315))
- **Notification system**: In-extension notification panel ([#316](https://github.com/olasunkanmi-SE/codebuddy/pull/316))
- **Enhanced context**: Richer context delivery to AI models ([#317](https://github.com/olasunkanmi-SE/codebuddy/pull/317))
- **News feed**: Save/delete functionality and daily cleanup for curated news ([#318](https://github.com/olasunkanmi-SE/codebuddy/pull/318))
- **Telemetry**: Usage analytics and performance telemetry ([#322](https://github.com/olasunkanmi-SE/codebuddy/pull/322))

**Full Changelog**: [v4.0.0...v4.1.0](https://github.com/olasunkanmi-SE/codebuddy/compare/v4.0.0...v4.1.0)

---

## [v4.0.0](https://github.com/olasunkanmi-SE/codebuddy/releases/tag/v4.0.0) — 2026-02-05

### Major Features

- **MCP (Model Context Protocol)**: Gateway for unlimited tool extensibility ([#297](https://github.com/olasunkanmi-SE/codebuddy/pull/297), [#296](https://github.com/olasunkanmi-SE/codebuddy/pull/296))
- **Sidebar settings panel**: Full settings panel integrated into the sidebar ([#298](https://github.com/olasunkanmi-SE/codebuddy/pull/298))
- **Local LLMs**: Docker/Ollama-based local model support ([#299](https://github.com/olasunkanmi-SE/codebuddy/pull/299), [#301](https://github.com/olasunkanmi-SE/codebuddy/pull/301))
- **Project rules**: Project-specific instruction files for AI behavior ([#300](https://github.com/olasunkanmi-SE/codebuddy/pull/300))
- **Skill Manager**: Integrated GitHub, Jira, and WhatsApp skills ([#303](https://github.com/olasunkanmi-SE/codebuddy/pull/303))
- **Scheduled tasks & news**: Daily news fetch and task scheduler ([#304](https://github.com/olasunkanmi-SE/codebuddy/pull/304))
- **Task & memory tools**: Task management and memory tools with scheduler service ([#305](https://github.com/olasunkanmi-SE/codebuddy/pull/305))
- **Agent Timeline**: Visual agent activity tracking component ([#306](https://github.com/olasunkanmi-SE/codebuddy/pull/306))
- **Diff review**: Pending change tracking and diff review feature ([#308](https://github.com/olasunkanmi-SE/codebuddy/pull/308))
- **AST indexing**: Worker-thread-based AST indexing service with caching ([#310](https://github.com/olasunkanmi-SE/codebuddy/pull/310))

### Improvements

- Updated Mermaid diagram display ([#295](https://github.com/olasunkanmi-SE/codebuddy/pull/295))
- General feature enhancements ([#307](https://github.com/olasunkanmi-SE/codebuddy/pull/307), [#311](https://github.com/olasunkanmi-SE/codebuddy/pull/311))

**Full Changelog**: [3.7.31...v4.0.0](https://github.com/olasunkanmi-SE/codebuddy/compare/3.7.31...v4.0.0)

---

## [3.7.31](https://github.com/olasunkanmi-SE/codebuddy/releases/tag/3.7.31) — 2025-12-11

### Improvements

- Deep agent testing and reliability improvements ([#293](https://github.com/olasunkanmi-SE/codebuddy/pull/293))

**Full Changelog**: [3.7.3...3.7.31](https://github.com/olasunkanmi-SE/codebuddy/compare/3.7.3...3.7.31)

---

## [3.7.3](https://github.com/olasunkanmi-SE/codebuddy/releases/tag/3.7.3) — 2025-11-16

### Features

- **Chat history**: Persistent chat history storage ([#278](https://github.com/olasunkanmi-SE/codebuddy/pull/278), [#279](https://github.com/olasunkanmi-SE/codebuddy/pull/279))
- **Smart context extractor**: Intelligent code context extraction ([#282](https://github.com/olasunkanmi-SE/codebuddy/pull/282))
- **Vector DB** (phases 2–5): Full vector database integration for semantic search ([#283](https://github.com/olasunkanmi-SE/codebuddy/pull/283), [#284](https://github.com/olasunkanmi-SE/codebuddy/pull/284), [#285](https://github.com/olasunkanmi-SE/codebuddy/pull/285), [#286](https://github.com/olasunkanmi-SE/codebuddy/pull/286), [#287](https://github.com/olasunkanmi-SE/codebuddy/pull/287))
- **Codebase analyzer**: Static analysis and insights ([#292](https://github.com/olasunkanmi-SE/codebuddy/pull/292))

### Improvements

- Removed file watcher for better performance ([#276](https://github.com/olasunkanmi-SE/codebuddy/pull/276), [#277](https://github.com/olasunkanmi-SE/codebuddy/pull/277))
- UI performance optimizations ([#289](https://github.com/olasunkanmi-SE/codebuddy/pull/289))
- Removed LanceDB, streamlined extension ([#290](https://github.com/olasunkanmi-SE/codebuddy/pull/290))
- Cleaned up unused files ([#291](https://github.com/olasunkanmi-SE/codebuddy/pull/291))

**Full Changelog**: [v3.4.4...3.7.3](https://github.com/olasunkanmi-SE/codebuddy/compare/v3.4.4...3.7.3)

---

## [v3.4.4](https://github.com/olasunkanmi-SE/codebuddy/releases/tag/v3.4.4) — 2025-07-20

### Features

- **Chat history management**: Improved conversation persistence ([#256](https://github.com/olasunkanmi-SE/codebuddy/pull/256))
- **Skeleton loader**: Loading state for bot messages ([#258](https://github.com/olasunkanmi-SE/codebuddy/pull/258))
- **Download responses**: Export bot responses to files ([#259](https://github.com/olasunkanmi-SE/codebuddy/pull/259))
- **Codebase analysis**: Analysis and recommendation command ([#267](https://github.com/olasunkanmi-SE/codebuddy/pull/267), [#268](https://github.com/olasunkanmi-SE/codebuddy/pull/268), [#272](https://github.com/olasunkanmi-SE/codebuddy/pull/272), [#274](https://github.com/olasunkanmi-SE/codebuddy/pull/274))
- **User feedback**: Enhanced feedback system for commands ([#264](https://github.com/olasunkanmi-SE/codebuddy/pull/264))

### Improvements

- Enhanced code block copy functionality and UI ([#260](https://github.com/olasunkanmi-SE/codebuddy/pull/260))
- UI enhancements ([#262](https://github.com/olasunkanmi-SE/codebuddy/pull/262))
- Enhanced security, performance, and architecture ([#270](https://github.com/olasunkanmi-SE/codebuddy/pull/270))

**Full Changelog**: [v3.2.6...v3.4.4](https://github.com/olasunkanmi-SE/codebuddy/compare/v3.2.6...v3.4.4)

---

## [v3.2.6](https://github.com/olasunkanmi-SE/codebuddy/releases/tag/v3.2.6) — 2025-06-30

### Features

- **esbuild bundling**: Extension and React webview bundled with esbuild for faster builds and smaller packages ([#255](https://github.com/olasunkanmi-SE/codebuddy/pull/255))

### Improvements

- Replaced libSQL with sqlite3 ([#253](https://github.com/olasunkanmi-SE/codebuddy/pull/253))
- Removed publish-on-save ([#254](https://github.com/olasunkanmi-SE/codebuddy/pull/254))
- Removed legacy chat history module ([#252](https://github.com/olasunkanmi-SE/codebuddy/pull/252))

**Full Changelog**: [v2.0.0...v3.2.6](https://github.com/olasunkanmi-SE/codebuddy/compare/v2.0.0...v3.2.6)

---

## [v2.0.0](https://github.com/olasunkanmi-SE/codebuddy/releases/tag/v2.0.0) — 2025-04-28

### Major Features

- **React webview UI**: Complete rewrite of the webview with React ([#117](https://github.com/olasunkanmi-SE/codebuddy/pull/117))
- **AI agent system**: Multi-agent orchestration with event-driven architecture ([#142](https://github.com/olasunkanmi-SE/codebuddy/pull/142), [#143](https://github.com/olasunkanmi-SE/codebuddy/pull/143), [#148](https://github.com/olasunkanmi-SE/codebuddy/pull/148))
- **RAG (Retrieval-Augmented Generation)**: Local codebase indexing and retrieval ([#134](https://github.com/olasunkanmi-SE/codebuddy/pull/134), [#137](https://github.com/olasunkanmi-SE/codebuddy/pull/137))
- **Web search**: Real-time web search with metadata ([#158](https://github.com/olasunkanmi-SE/codebuddy/pull/158), [#159](https://github.com/olasunkanmi-SE/codebuddy/pull/159), [#170](https://github.com/olasunkanmi-SE/codebuddy/pull/170))
- **DeepSeek support**: Added DeepSeek model provider ([#178](https://github.com/olasunkanmi-SE/codebuddy/pull/178), [#193](https://github.com/olasunkanmi-SE/codebuddy/pull/193))
- **Groq integration**: Groq LLM as fallback provider ([#197](https://github.com/olasunkanmi-SE/codebuddy/pull/197))
- **File uploads**: Local file upload and processing ([#204](https://github.com/olasunkanmi-SE/codebuddy/pull/204), [#206](https://github.com/olasunkanmi-SE/codebuddy/pull/206))
- **Think tool**: Complex problem-solving tool for agents ([#210](https://github.com/olasunkanmi-SE/codebuddy/pull/210), [#211](https://github.com/olasunkanmi-SE/codebuddy/pull/211))
- **Context pinning**: Pin directories, files, and code elements as persistent context ([#183](https://github.com/olasunkanmi-SE/codebuddy/pull/183))

### AI Intelligence

- Implemented base LLM class ([#141](https://github.com/olasunkanmi-SE/codebuddy/pull/141))
- Improved embedding model ([#136](https://github.com/olasunkanmi-SE/codebuddy/pull/136))
- CodeBuddyTool system and ContextRetriever ([#154](https://github.com/olasunkanmi-SE/codebuddy/pull/154))
- Reranking for search results ([#195](https://github.com/olasunkanmi-SE/codebuddy/pull/195))
- Knowledge base integration ([#201](https://github.com/olasunkanmi-SE/codebuddy/pull/201))

### UI Enhancements

- Model selection and attachments in chat ([#160](https://github.com/olasunkanmi-SE/codebuddy/pull/160))
- Tabbed interface and improved prompt handling ([#173](https://github.com/olasunkanmi-SE/codebuddy/pull/173))
- Code highlighting and copy functionality ([#157](https://github.com/olasunkanmi-SE/codebuddy/pull/157), [#166](https://github.com/olasunkanmi-SE/codebuddy/pull/166))
- Bot icon and mode selection ([#168](https://github.com/olasunkanmi-SE/codebuddy/pull/168))
- Workspace context selector ([#190](https://github.com/olasunkanmi-SE/codebuddy/pull/190))

### Functionality

- Extension–React webview communication bridge ([#121](https://github.com/olasunkanmi-SE/codebuddy/pull/121))
- Secret storage provider ([#162](https://github.com/olasunkanmi-SE/codebuddy/pull/162))
- Workspace service and context info ([#181](https://github.com/olasunkanmi-SE/codebuddy/pull/181))
- Chat history management ([#232](https://github.com/olasunkanmi-SE/codebuddy/pull/232))
- User preferences management ([#243](https://github.com/olasunkanmi-SE/codebuddy/pull/243))
- File system event monitoring ([#238](https://github.com/olasunkanmi-SE/codebuddy/pull/238))

### Refactoring

- Streamlined inline chat ([#127](https://github.com/olasunkanmi-SE/codebuddy/pull/127))
- Restructured project organization ([#140](https://github.com/olasunkanmi-SE/codebuddy/pull/140))
- Improved type safety in BaseEmitter ([#144](https://github.com/olasunkanmi-SE/codebuddy/pull/144))
- Refactored agent classes and orchestrator ([#149](https://github.com/olasunkanmi-SE/codebuddy/pull/149), [#150](https://github.com/olasunkanmi-SE/codebuddy/pull/150))
- Database connection handling ([#179](https://github.com/olasunkanmi-SE/codebuddy/pull/179))
- Consistent path handling with `vscode.Uri.joinPath` ([#131](https://github.com/olasunkanmi-SE/codebuddy/pull/131))

### New Contributors

- [@skyline-GTRr32](https://github.com/skyline-GTRr32) made their first contribution in [#178](https://github.com/olasunkanmi-SE/codebuddy/pull/178)
- [@darkelfs56](https://github.com/darkelfs56) contributed hljs fix in [#163](https://github.com/olasunkanmi-SE/codebuddy/pull/163)

**Full Changelog**: [v.1.1.7...v2.0.0](https://github.com/olasunkanmi-SE/codebuddy/compare/v.1.1.7...v2.0.0)

---

## [v1.1.7](https://github.com/olasunkanmi-SE/codebuddy/releases/tag/v.1.1.7) — 2024-12-18

### Features

- **Inline chat**: In-editor chat interface for contextual AI assistance ([#115](https://github.com/olasunkanmi-SE/codebuddy/pull/115))

**Full Changelog**: [v.1.1.6...v.1.1.7](https://github.com/olasunkanmi-SE/codebuddy/compare/v.1.1.6...v.1.1.7)

---

## [v1.1.6](https://github.com/olasunkanmi-SE/codebuddy/releases/tag/v.1.1.6) — 2024-12-15

### Features

- **Grok (xAI) support**: Added XGrok AI model integration ([#107](https://github.com/olasunkanmi-SE/codebuddy/pull/107), [#108](https://github.com/olasunkanmi-SE/codebuddy/pull/108))

### Improvements

- Revamped README documentation ([#109](https://github.com/olasunkanmi-SE/codebuddy/pull/109))
- Standardized font sizes and improved input placeholder ([#110](https://github.com/olasunkanmi-SE/codebuddy/pull/110))

### Bug Fixes

- Fixed webview event issues ([#112](https://github.com/olasunkanmi-SE/codebuddy/pull/112))

**Full Changelog**: [v.1.1.5...v.1.1.6](https://github.com/olasunkanmi-SE/codebuddy/compare/v.1.1.5...v.1.1.6)

---

## [v1.1.5](https://github.com/olasunkanmi-SE/codebuddy/releases/tag/v.1.1.5) — 2024-12-14

### Features

- **Grok (xAI) support**: Initial XGrok AI model integration ([#107](https://github.com/olasunkanmi-SE/codebuddy/pull/107), [#108](https://github.com/olasunkanmi-SE/codebuddy/pull/108))

**Full Changelog**: [v.1.1.4...v.1.1.5](https://github.com/olasunkanmi-SE/codebuddy/compare/v.1.1.4...v.1.1.5)

---

## [v1.1.4](https://github.com/olasunkanmi-SE/codebuddy/releases/tag/v.1.1.4) — 2024-09-15

### Improvements

- Updated CodeBuddy logo ([#100](https://github.com/olasunkanmi-SE/codebuddy/pull/100))

### Bug Fixes

- Fixed hallucination issues with improved prompt constraints ([#102](https://github.com/olasunkanmi-SE/codebuddy/pull/102), [#104](https://github.com/olasunkanmi-SE/codebuddy/pull/104))

**Full Changelog**: [v.1.1.3...v.1.1.4](https://github.com/olasunkanmi-SE/codebuddy/compare/v.1.1.3...v.1.1.4)

---

## [v1.1.3](https://github.com/olasunkanmi-SE/codebuddy/releases/tag/v.1.1.3) — 2024-09-02

### Features

- **Anthropic (Claude) support**: Integrated Anthropic generative AI model ([#95](https://github.com/olasunkanmi-SE/codebuddy/pull/95), [#96](https://github.com/olasunkanmi-SE/codebuddy/pull/96), [#97](https://github.com/olasunkanmi-SE/codebuddy/pull/97))

**Full Changelog**: [v.1.1.2...v.1.1.3](https://github.com/olasunkanmi-SE/codebuddy/compare/v.1.1.2...v.1.1.3)

---

## [v1.1.2](https://github.com/olasunkanmi-SE/codebuddy/releases/tag/v.1.1.2) — 2024-08-24

### Improvements

- Updated unit test generation prompt ([#86](https://github.com/olasunkanmi-SE/codebuddy/pull/86))
- Code chart visualization ([#88](https://github.com/olasunkanmi-SE/codebuddy/pull/88))

**Full Changelog**: [v1.1.1...v.1.1.2](https://github.com/olasunkanmi-SE/codebuddy/compare/v1.1.1...v.1.1.2)

---

## [v1.1.1](https://github.com/olasunkanmi-SE/codebuddy/releases/tag/v1.1.1) — 2024-08-20

### Features

- **Knowledge base**: Upload and read from a knowledge base ([#62](https://github.com/olasunkanmi-SE/codebuddy/pull/62), [#65](https://github.com/olasunkanmi-SE/codebuddy/pull/65), [#67](https://github.com/olasunkanmi-SE/codebuddy/pull/67))
- **Auto-commit messages**: AI-generated commit messages ([#69](https://github.com/olasunkanmi-SE/codebuddy/pull/69), [#70](https://github.com/olasunkanmi-SE/codebuddy/pull/70))
- **Interview mode**: "Interview me" feature and unit test generation ([#84](https://github.com/olasunkanmi-SE/codebuddy/pull/84))
- **Copy & scroll buttons**: Copy button and scroll-down button for chat ([#78](https://github.com/olasunkanmi-SE/codebuddy/pull/78))

### Improvements

- Font improvements ([#59](https://github.com/olasunkanmi-SE/codebuddy/pull/59))

### New Contributors

- [@FakhrulZiq](https://github.com/FakhrulZiq) made their first contribution in [#78](https://github.com/olasunkanmi-SE/codebuddy/pull/78)

**Full Changelog**: [v1.1.0...v1.1.1](https://github.com/olasunkanmi-SE/codebuddy/compare/v1.1.0...v1.1.1)

---

## [v1.1.0](https://github.com/olasunkanmi-SE/codebuddy/releases/tag/v1.1.0) — 2024-06-23

### Features

- **Chat view themes**: Multiple chat view themes ([#55](https://github.com/olasunkanmi-SE/codebuddy/pull/55))
- **Fonts & font size**: User-selectable fonts and font sizes ([#57](https://github.com/olasunkanmi-SE/codebuddy/pull/57))
- **Syntax highlighting**: Code block syntax highlighting with highlight.js ([#52](https://github.com/olasunkanmi-SE/codebuddy/pull/52))

### New Contributors

- [@mVedr](https://github.com/mVedr) made their first contribution in [#43](https://github.com/olasunkanmi-SE/codebuddy/pull/43)
- [@darkelfs56](https://github.com/darkelfs56) made their first contribution in [#52](https://github.com/olasunkanmi-SE/codebuddy/pull/52)

**Full Changelog**: [v1...v1.1.0](https://github.com/olasunkanmi-SE/codebuddy/compare/v1...v1.1.0)

---

## [v1.0.0](https://github.com/olasunkanmi-SE/codebuddy/releases/tag/v1) — 2024-04-06 (Pre-release)

Initial release of CodeBuddy.

### Features

- AI-powered code analysis using Google Gemini
- Intelligent code suggestions and completions
- Explanations and justifications for generated code
- Debugging and troubleshooting assistance
- Code optimization recommendations
- Interactive chat interface
