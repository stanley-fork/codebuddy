# #7 Doctor Command — Implementation Plan

## Overview

A unified `CodeBuddy: Run Doctor` command that audits the workspace for security misconfigurations, stale credentials, missing safeguards, and MCP issues. Outputs structured findings with severity levels and auto-fix capabilities.

**Roadmap item**: #7 Security Audit Framework / Doctor Command  
**Effort**: ~3-4 days  
**Dependencies**: #23 External Security Config (done)

---

## Architecture

```
src/services/doctor.service.ts          ← New: DoctorService singleton
src/services/doctor-checks/             ← New: Individual check modules
  api-key-audit.check.ts                ← Check 1: Plaintext vs SecretStorage
  input-validator.check.ts              ← Check 2: InputValidator wiring
  terminal-restrictions.check.ts        ← Check 3: Command deny patterns active
  directory-permissions.check.ts        ← Check 4: .codebuddy/ permissions
  mcp-config.check.ts                   ← Check 5: MCP server validation
  security-config.check.ts              ← Check 6: Delegates to ExternalSecurityConfigService.getDiagnostics()
```

### Why separate check files?

Each check is isolated and testable. `DoctorService` orchestrates them — it doesn't contain check logic itself. New checks can be added without touching the orchestrator.

---

## Shared Types

```typescript
// Re-use the existing SecurityDiagnostic shape from external-security-config.service.ts
interface DoctorFinding {
  check: string;                           // e.g. "api-key-audit"
  severity: "info" | "warn" | "critical";
  message: string;
  autoFixable: boolean;
  fix?: () => Promise<void>;               // Optional auto-fix callback
}

interface DoctorCheckModule {
  name: string;
  run(context: DoctorCheckContext): Promise<DoctorFinding[]>;
}

interface DoctorCheckContext {
  workspacePath: string;
  secretStorage: SecretStorageService;
  securityConfig: ExternalSecurityConfigService;
  logger: Logger;
}
```

---

## Check Details

### Check 1: API Key Audit (`api-key-audit.check.ts`)

| What | How |
|------|-----|
| Detect plaintext API keys in settings | Read all 9 `APP_CONFIG.*Key` settings via `vscode.workspace.getConfiguration()` |
| Compare with SecretStorage | Call `SecretStorageService.getApiKey(configKey)` for each |
| Findings | **critical** if key exists in settings but not SecretStorage; **warn** if key in both (not yet cleaned from settings); **info** if all migrated |
| Auto-fix | Call `SecretStorageService.storeApiKey()` then clear the setting value |

### Check 2: InputValidator Wiring (`input-validator.check.ts`)

| What | How |
|------|-----|
| Confirm InputValidator is loaded | Import `InputValidator` and check its singleton exists |
| Check pattern count | Verify suspicious patterns array is non-empty |
| Findings | **warn** if InputValidator patterns are empty or not initialized; **info** if active |
| Auto-fix | No (requires code change) |

### Check 3: Terminal Restrictions (`terminal-restrictions.check.ts`)

| What | How |
|------|-----|
| Check if command deny patterns are configured | Call `ExternalSecurityConfigService.getCommandDenyPatterns()` |
| Check deny list size | Warn if only defaults (0 custom patterns) |
| Findings | **warn** if no custom deny patterns beyond defaults; **info** if custom patterns loaded |
| Auto-fix | No (user must configure) |

### Check 4: Directory Permissions (`directory-permissions.check.ts`)

| What | How |
|------|-----|
| Scan `.codebuddy/` permissions | `fs.stat()` on `.codebuddy/` and `security.json` |
| Check mode bits | On macOS/Linux: warn if group/other readable (`mode & 0o077`) |
| Check existence | Warn if `.codebuddy/` doesn't exist |
| Findings | **warn** if permissions too open; **info** if locked down; skip on Windows |
| Auto-fix | `fs.chmod(path, 0o700)` for directory, `0o600` for files |

### Check 5: MCP Server Validation (`mcp-config.check.ts`)

| What | How |
|------|-----|
| Read MCP config | `vscode.workspace.getConfiguration("codebuddy").get("mcpServers")` |
| Validate entries | Each server must have `command` and valid `args`; warn on `env` containing raw secrets |
| Check server reachability | Verify the command binary exists (`which` / `command -v`) |
| Findings | **critical** if secrets in env vars inline; **warn** if command not found; **info** if clean |
| Auto-fix | No |

### Check 6: Security Config (`security-config.check.ts`)

| What | How |
|------|-----|
| Delegate to existing code | Call `ExternalSecurityConfigService.getInstance().getDiagnostics()` |
| Map findings | Convert `SecurityDiagnostic[]` → `DoctorFinding[]` with `check: "security-config"` |
| Auto-fix | `scaffoldDefaultConfig()` if config missing |

---

## DoctorService Orchestrator

```
DoctorService (singleton)
├── checks: DoctorCheckModule[]       ← All 6 checks registered
├── outputChannel: OutputChannel      ← "CodeBuddy Doctor"
├── execute(): Promise<DoctorFinding[]>
│   ├── Run all checks in parallel (Promise.allSettled)
│   ├── Flatten + sort by severity (critical > warn > info)
│   └── Return findings
├── displayFindings(findings): void
│   ├── Clear + write to output channel
│   ├── Group by severity with icons (❌ / ⚠️ / ℹ️)
│   └── Show summary count
├── autoFixAll(findings): Promise<number>
│   ├── Filter autoFixable findings
│   ├── Run each fix()
│   └── Return count of fixes applied
└── runBackground(): Promise<void>
    ├── execute() silently
    └── Show status bar item only if critical findings exist
```

---

## Command Registration

| Command ID | Title | Trigger |
|------------|-------|---------|
| `codebuddy.runDoctor` | `CodeBuddy: Run Doctor` | Command palette (on-demand) |

**Background run**: Called during `activate()` after all services are initialized. Uses `runBackground()` — no output channel shown, only a status bar warning if critical findings.

---

## Output Format

```
=== CodeBuddy Doctor ===
Ran 6 checks • Found 2 critical, 1 warning, 3 info

❌ CRITICAL
  [api-key-audit] Gemini API key found in plaintext settings (auto-fixable)
  [api-key-audit] Anthropic API key found in plaintext settings (auto-fixable)

⚠️  WARNING
  [directory-permissions] .codebuddy/ is readable by group/others (auto-fixable)

ℹ️  INFO
  [security-config] External security config loaded (4 custom deny patterns)
  [input-validator] InputValidator active with 9 patterns
  [terminal-restrictions] 4 custom command deny patterns configured

---
2 issues are auto-fixable. Run "CodeBuddy: Doctor Auto-Fix" to apply.
```

---

## Status Bar Integration

When `runBackground()` finds critical issues:

```
$(shield) Doctor: 2 critical
```

- Clicking the status bar item runs the full doctor command
- Status bar item disappears after auto-fix resolves all critical issues
- Color: `statusBarItem.warningBackground` for warnings, `statusBarItem.errorBackground` for critical

---

## Files to Create/Modify

### New Files
| File | Lines (est.) |
|------|-------------|
| `src/services/doctor.service.ts` | ~150 |
| `src/services/doctor-checks/api-key-audit.check.ts` | ~70 |
| `src/services/doctor-checks/input-validator.check.ts` | ~30 |
| `src/services/doctor-checks/terminal-restrictions.check.ts` | ~35 |
| `src/services/doctor-checks/directory-permissions.check.ts` | ~55 |
| `src/services/doctor-checks/mcp-config.check.ts` | ~65 |
| `src/services/doctor-checks/security-config.check.ts` | ~25 |
| `src/test/suite/doctor.service.test.ts` | ~200 |

### Modified Files
| File | Changes |
|------|---------|
| `src/extension.ts` | Register `codebuddy.runDoctor` command; call `runBackground()` on activation |
| `package.json` | Add `codebuddy.runDoctor` to commands array |

---

## Implementation Order

1. Create shared types + `DoctorService` shell (orchestrator with `execute()`, `displayFindings()`, `autoFixAll()`, `runBackground()`)
2. Implement checks 6 → 1 (security-config first since it's a thin wrapper, API key audit last since it's most complex)
3. Wire into `extension.ts` + `package.json`
4. Write tests
5. Build + verify

---

## Open Questions

1. **Should `codebuddy.securityDiagnostics` be deprecated?** — Doctor subsumes it. Recommendation: keep it as a focused shortcut but have it internally delegate to Doctor's security-config check.
2. **Auto-fix confirmation** — Should auto-fix prompt the user before applying, or just apply? Recommendation: show a quick pick with fixable items, let user select which to apply.
3. **Background run frequency** — Run only on activation, or also periodically? Recommendation: activation only (no timers).
