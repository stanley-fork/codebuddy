# CodeBuddy Log Issues Analysis

**Log Date:** 2026-03-17 00:50:24 – 01:48:19 UTC  
**Extension Version:** 4.1.14  
**Provider:** Anthropic (claude-sonnet-4-6)

---

## Critical Issues

### 1. Docker Daemon Not Running — Catastrophic Retry Storm

**Severity:** CRITICAL  
**Modules:** `MCPClient:docker-gateway`, `MCPService`  
**Frequency:** 100+ ERROR/WARN entries in ~60 minutes

The Docker daemon is not running (`docker.sock` missing), yet CodeBuddy endlessly spawns new connection attempts to the `docker-gateway` MCP server. After reaching the 3-attempt retry limit, it immediately starts new connection cycles — sometimes with **multiple overlapping concurrent connections** to the same server.

**Root Cause Chain:**
1. Docker Desktop is not running → `docker.sock` doesn't exist
2. `docker mcp gateway run` immediately exits (transport closed)
3. MCPClient retries 3 times with exponential backoff (1s, 2s, 4s)
4. After 3 failures, MCPService retries at a higher level (3 more attempts)
5. Multiple callers (`getAllTools`, `ensureToolsLoaded`, `ensureGatewayConnected`) each trigger independent retry cycles
6. No global circuit breaker stops the cascade

**Evidence:**
```
Transport closed [docker-gateway] code=undefined reason=undefined
Failed to connect to docker-gateway: {"code":-32000,"name":"McpError"}
Max reconnection attempts reached for docker-gateway
```

**Impact:**
- Spawns potentially hundreds of `docker mcp gateway run` child processes
- Floods notification panel (unread count: 133 → 139 in minutes)
- Wastes CPU and slows VS Code
- Log becomes unreadable due to noise

**Recommendations:**
- Implement a global circuit breaker: after N total failures for a server, stop retrying for a long cooldown (e.g., 5 minutes)
- Add a connection mutex/lock so multiple callers don't trigger parallel retry storms
- Check if Docker daemon is running (`docker info`) **before** attempting MCP connection
- Don't auto-include `docker-gateway` as a default server if Docker is not installed/running

---

### 2. Docker Command Polling Loop — Repeated Failures Every 30 Seconds

**Severity:** CRITICAL  
**Module:** `t` (minified module name)  
**Frequency:** 4 failing commands × every 30 seconds = ~480 errors/hour

A polling loop runs every 30 seconds to discover local models via Docker/Ollama. All 4 commands fail because Docker is not running:

```
docker ps --filter name=ollama --format json          → exit code 1
docker model ls --json                                → exit code 1
docker model ls                                       → exit code 1
docker exec ollama ollama list                        → exit code 1
```

All produce the same error: `failed to connect to the docker API at unix:///...docker.sock; connect: no such file or directory`

**Recommendations:**
- After first detection that Docker is unavailable, exponentially back off polling (30s → 60s → 120s → stop)
- Cache the "Docker not available" state and only re-check when configuration changes or on user action
- The `docker model --help` command succeeds (it doesn't need the daemon), so use this to distinguish "Docker CLI installed but daemon not running" vs "Docker not installed"

---

### 3. Gemini Embedding API Key Invalid — All Embeddings Failing

**Severity:** CRITICAL  
**Module:** `AstIndexingService`, `EmbeddingService`  
**Frequency:** 10+ WARN entries (every file change triggers 5 chunk failures)

Every embedding generation request fails with HTTP 400:
```json
{
  "reason": "API_KEY_INVALID",
  "domain": "googleapis.com",
  "message": "API key not valid. Please pass a valid API key."
}
```

**Root Cause Chain:**
1. User has Anthropic configured as their provider
2. EmbeddingService logs: `Unsupported provider for embeddings: anthropic. Defaulting to Gemini logic if possible.`
3. The Gemini fallback uses an invalid/missing API key
4. Every chunk embedding fails → vectors are stored without embeddings → vector search is broken

**Impact:**
- RAG/vector search completely non-functional
- AST indexing persists chunks but they're useless without embeddings
- Every file save triggers 5 failed HTTP requests to Google APIs
- `settings.json` is being indexed (should it be?)

**Recommendations:**
- If the Gemini API key is not configured, skip embedding generation entirely instead of making doomed HTTP requests
- Add a clear startup warning: "Embeddings require a valid Gemini API key. Vector search is disabled."
- Consider supporting Anthropic's embedding API or offer an explicit embedding provider setting
- Don't index VS Code `settings.json` — add it to exclusion list

---

### 4. Agent Stream Failures — Provider Failover on Long Tasks

**Severity:** HIGH  
**Modules:** `CodeBuddyAgentService`, `ProviderFailover`, `MessageHandler`  
**Frequency:** 3 agent failures in this session

All three agent runs failed with the same pattern:
```
Provider "anthropic" failed: unknown (errors: N, cooldown: 30s)
Stream failed for thread thread-1773708627106-mbaqmk
Agent mode error
```

**Timeline:**
1. **01:36:13** — First failure after ~6 min runtime (request started 01:30:04), 2 tool calls completed
2. **01:45:05** — Second failure after ~7 min runtime (request started 01:37:53), 10 tool calls completed  
3. **01:47:59** — Third failure after ~2.5 min runtime (request started 01:45:21), 0 model requests (failed during middleware replay)

**Key Observation:** The error `data: {}` means the actual error details are being swallowed. The agent appears to hit Anthropic API timeouts or rate limits on long-running multi-tool sessions.

**On the third retry**, the `SkillsMiddleware.before_agent` replays ALL 12 previous tool calls from the checkpoint, adding massive overhead before even reaching the model. This replay-everything approach means each retry gets slower and more likely to fail.

**Recommendations:**
- Preserve and log the actual error from the Anthropic API (don't serialize as `{}`)
- Implement streaming keepalive or chunked requests for long-running agent sessions
- Don't replay all middleware tool calls on retry — use checkpoint state directly
- Add a user-visible error message with the actual failure reason, not just "Agent Error"
- Consider auto-retry with smaller context or summarized history

---

## High Priority Issues

### 5. SQLite Checkpointer Module Not Found

**Severity:** HIGH  
**Module:** `CodeBuddyAgentService`

```
Failed to initialize SQLite checkpointer, falling back to in-memory
{"code":"MODULE_NOT_FOUND","requireStack":["extension.js","extensionHostProcess.js"]}
```

The agent falls back to in-memory checkpointing, meaning:
- Thread state is lost on extension restart
- Long conversations can't be resumed across sessions
- Memory usage grows unbounded for long sessions

**Recommendation:** Ensure the SQLite native module is properly bundled in the extension VSIX, or use a pure-JS alternative like `sql.js` (which is already used elsewhere in the extension).

---

### 6. Unknown Tools Not in TOOL_DESCRIPTIONS

**Severity:** HIGH  
**Module:** `CodeBuddyAgentService`  
**Tools affected:** `write_todos`, `task`, `glob`

```
Unknown tool "write_todos" not in TOOL_DESCRIPTIONS — using default
Unknown tool "task" not in TOOL_DESCRIPTIONS — using default
Unknown tool "glob" not in TOOL_DESCRIPTIONS — using default
```

These are core tools that the agent uses frequently but they're missing from `TOOL_DESCRIPTIONS`. This means:
- Tool execution descriptions shown to the user are generic ("Executing tool...")
- Tool presence validation may be incomplete
- Could cause issues with tool filtering by role

**Recommendation:** Add all registered tools to `TOOL_DESCRIPTIONS` map.

---

### 7. MCP Service Double Initialization

**Severity:** MEDIUM  
**Module:** `MCPService`

MCPService initializes twice during startup (at 00:50:25.576 and 00:50:25.647), loading the same configuration both times. This doubles the connection attempts and resource usage.

**Evidence:**
```
00:50:25.576 — Initializing MCP service...
00:50:25.577 — Found 2 configured MCP Server(s)
00:50:25.647 — Initializing MCP service...
00:50:25.650 — Found 2 configured MCP Server(s)
```

**Recommendation:** Add initialization guard (`if (this.initialized) return`) or ensure single initialization point.

---

### 8. Unsupported Embedding Provider Warning Spam

**Severity:** MEDIUM  
**Module:** `EmbeddingService`  
**Frequency:** 5+ times during this session

```
Unsupported provider for embeddings: anthropic. Defaulting to Gemini logic if possible.
```

This warning fires on every code path that touches embeddings but provides no actionable guidance.

**Recommendation:** Log this once at startup, not on every embedding request. Use a `warnedOnce` flag.

---

## Medium Priority Issues

### 9. Unhandled Webview Command

**Severity:** MEDIUM  
**Module:** `BaseWebViewProvider`

```
Unhandled webview command: codebuddy-model-change-event
```

The webview sends a `codebuddy-model-change-event` command that the provider doesn't handle, suggesting a frontend/backend command mismatch.

---

### 10. Schema Migration Duplicate Column Warning

**Severity:** LOW  
**Module:** `SqliteDatabaseService`

```
Schema migration v1 note: duplicate column name: saved
```

The `ALTER TABLE ADD COLUMN` migration silently fails because the column already exists. While handled, this indicates the migration system doesn't properly track applied migrations.

---

### 11. Telemetry Test Span Not Captured

**Severity:** LOW  
**Module:** `LocalObservabilityService`

```
Creating manual test span: initialization_test_span
...
Total spans in exporter after test: 0
```

The initialization test span completes but shows 0 spans in the exporter, suggesting the span processor isn't fully attached when the test runs (race condition).

---

### 12. Garbage Collection Not Available

**Severity:** LOW  
**Module:** `ProductionSafeguards`

```
Garbage collection not available (start with --expose-gc)
```

The `FORCE_GC` recovery strategy can never work in a VS Code extension context since `--expose-gc` can't be passed to the extension host.

**Recommendation:** Remove `FORCE_GC` from recovery strategies or replace with manual memory cleanup (clearing caches, disposing unused objects).

---

### 13. EnhancedCacheManager Reinitialized with Different maxSize

**Severity:** LOW  
**Module:** `EnhancedCacheManager`

```
01:09:33 — Enhanced cache manager initialized: maxSize=100
01:29:42 — Enhanced cache manager initialized: maxSize=10000
```

The cache manager is recreated with a dramatically different `maxSize` (100 vs 10000), suggesting inconsistent configuration between different instantiation paths.

---

### 14. Notification Panel Overflow

**Severity:** MEDIUM  
**Module:** `NotificationService`, `BaseWebViewProvider`

Unread notifications grew from 133 to 139 before a session reset, and then accumulated 14 more. Most are MCP connection failure notifications.

**Evidence:**
```
synchronizeNotifications: Sending 50 notifications, unread: 133
synchronizeNotifications: Sending 50 notifications, unread: 139
```

**Recommendation:**
- Deduplicate identical notifications (e.g., collapse N "MCP Connection Failed" into one with a count)
- Cap max notifications and auto-dismiss stale ones
- Don't create a new notification for every retry attempt

---

### 15. Observability Polling — Redundant 3-Second Span Pushes

**Severity:** LOW  
**Module:** `LocalObservabilityService`, `BaseWebViewProvider`

Every 3 seconds, the same 8 (or 55) spans are pushed to the webview even when nothing has changed:

```
01:32:32 — getSpans returning 8 spans...
01:32:33 — getSpans returning 8 spans...  (1 second later, same data)
01:32:36 — getSpans returning 8 spans...
... (continues for minutes)
```

**Recommendation:** Only push span updates when new spans are added (event-driven, not polling).

---

### 16. Playwright MCP Connection Lost During Config Reload

**Severity:** MEDIUM  
**Module:** `MCPClient:playwright`, `MCPService`

When MCP configuration was reloaded (user removed playwright preset), the playwright transport was closed but then a reconnection attempt was triggered:

```
Disconnecting from playwright...
Disconnected from playwright
Reloading MCP Configurations....
...
Transport closed [playwright] code=undefined reason=undefined
Reconnect attempt 1/3 in 1000ms...
```

The old client's reconnection handler fires after the intentional disconnect. Dispose should cancel pending reconnection timers.

---

## Summary Table

| # | Issue | Severity | Category | Estimated Impact |
|---|-------|----------|----------|-----------------|
| 1 | Docker gateway retry storm | CRITICAL | MCP/Networking | Performance, log noise, process spawning |
| 2 | Docker command polling loop | CRITICAL | Local Models | Error spam every 30s |
| 3 | Gemini API key invalid | CRITICAL | Embeddings/RAG | Vector search completely broken |
| 4 | Agent stream failures | HIGH | Agent/LLM | User-facing task failures |
| 5 | SQLite checkpointer missing | HIGH | Agent/Persistence | No cross-session memory |
| 6 | Unknown tools in TOOL_DESCRIPTIONS | HIGH | Agent/Tools | Poor UX, potential filtering bugs |
| 7 | MCP double initialization | MEDIUM | MCP | Double resource usage at startup |
| 8 | Embedding provider warning spam | MEDIUM | Logging | Log noise |
| 9 | Unhandled webview command | MEDIUM | Webview | Silent feature failure |
| 10 | Schema migration duplicate column | LOW | Database | Cosmetic warning |
| 11 | Telemetry test span race condition | LOW | Observability | Test validation unreliable |
| 12 | GC not available | LOW | Memory | Dead recovery path |
| 13 | Cache maxSize inconsistency | LOW | Caching | Potential memory issues |
| 14 | Notification overflow | MEDIUM | UX | Unusable notification panel |
| 15 | Observability polling waste | LOW | Performance | Unnecessary WebView traffic |
| 16 | Playwright reconnect after dispose | MEDIUM | MCP | Wasted reconnection attempts |
