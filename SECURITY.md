# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 4.x     | :white_check_mark: |
| < 4.0   | :x:                |

## Reporting a Vulnerability

**Please do NOT open public issues for security vulnerabilities.**

Report vulnerabilities via [GitHub Security Advisories](https://github.com/olasunkanmi-SE/codebuddy/security/advisories/new).

You will receive an acknowledgment within 48 hours and a detailed response within 5 business days indicating next steps.

## Security Practices

CodeBuddy implements the following security measures:

### Secret Management

- All API keys and credentials stored via VS Code `secretStorage` API (OS-level encryption)
- Secrets never logged or included in telemetry
- Per-skill secret isolation with scoped key naming

### Command Execution

- Shell argument escaping for POSIX, cmd.exe, and PowerShell (`shell-escape.ts`)
- Binary name validation (`isSafeCommandName`)
- Command length limits enforced
- Terminal isolation via VS Code Terminal API (env vars not leaked to parent shell)

### Environment Variable Sanitization

- Blocklist prevents injection of dangerous variables: `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `PATH`, `HOME`, `SHELL`, `TMPDIR`, `IFS`, `SSH_AUTH_SOCK`, etc.
- Skills receive only their declared environment variables

### Static Analysis

- TypeScript strict mode
- ESLint with `@typescript-eslint/recommended`
- Datadog SAST ruleset (JavaScript security, Node.js security, browser security)

### Dependency Management

- Dependabot enabled for automated vulnerability scanning (npm + GitHub Actions)
- `npm audit` integrated into CI pipeline
- Dependencies pinned via `package-lock.json` with `npm ci` for reproducible builds

### Access Controls

- Configurable auto-approve, file edit, and terminal execution permissions
- User consent required for destructive operations
- Skill permission model with minimal-privilege defaults
