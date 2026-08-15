# Task 8: Tool/MCP + Specialized Harnesses

## Context
Phase 1 complete: `NodeExecutionEngine` has tool nodes defined (terminal executes via PTY, file read/transform inline, sqlite executes; browser/non-JS transform/non-sqlite throw descriptive errors). Phase 2 complete: `/api/tools` catalog + `/api/tools/execute` (honest 501). Phase 6 will add LLM decision provider.

## Deliverables
1. **Capability Registry + Permission Policy** (`src/runtime/capabilities.ts`)
   - Capability: filesystem, terminal, network, browser, git, github, spawnAgents, assignTasks, deploy
   - Defaults per spec §11.2: Engineer (filesystem/terminal/git allowed; spawnAgents denied; deploy approval), Orchestrator (all except deploy), Human (all)
2. **Deterministic Tool Runner** (`src/runtime/tool-runner.ts`)
   - Terminal: PTY harness + `runCommand()`
   - Filesystem: read/write scoped to project root, allowed extensions
   - Git: status/diff/commit/branch scoped to repo
   - Approval gates for destructive actions (write outside root, deploy, git push)
3. **Browser Sessions** (`src/runtime/browser-tool.ts`) — Playwright browser sessions as inspectable tool nodes
4. **MCP Client Adapters** (`src/runtime/mcp-client.ts`) — capability integration, NOT orchestration protocol
5. **Specialized Harness Adapters** (`src/harness/claude-code.ts`, `src/harness/pi.ts`, `src/harness/omp.ts`, `src/harness/freebuff.ts`) — detection + spawn config; generic PTY fallback

## Existing Contracts
- `src/harness/generic.ts` — `GenericTerminalHarness`, `runCommand()`
- `src/runtime/node-registry.ts` — `TerminalNodeConfig`, `FileNodeConfig`, `BrowserNodeConfig`, `DatabaseNodeConfig`
- `src/core/types.ts` — `AgentPermissions`, `Harness`, `HarnessSession`, `SpawnConfig`
- `src/server/http-server.ts` — `GET /api/tools`, `POST /api/tools/execute`

## Tool Runner
- `POST /api/tools/execute` implements real execution (replaces 501)
- Request: `{ tool, config, input, permissions }`
- Response: `{ ok, output, artifact?, status, durationMs }`
- Validation: permission policy first, then config schema, then execution
- Destructive ops → `approval.requested` event + pending until `resolveApproval`

## Browser Tool
- Playwright `chromium.launch({ headless })`
- Actions: navigate, click, extract, screenshot
- Browser session inspectable: `GET /api/browser/:sessionId`, `POST /api/browser/:sessionId/action`
- Screenshot → artifact with provenance

## MCP Client
- `mcpServers` config in workspace settings
- Each server = capability provider (filesystem, browser, git, github, etc.)
- Tool call validation against permission policy
- Never used for orchestration protocol — only capabilities

## Harness Adapters
- `detect()` — check binary availability (claude, pi, omp, freebuff)
- `spawn(config)` — correct CLI flags, env, cwd
- Fallback to GenericTerminalHarness when adapter unavailable
- Adapters registered in `src/runtime/harness-registry.ts`

## Files to Create/Modify
- Create: `src/runtime/capabilities.ts`
- Create: `src/runtime/tool-runner.ts`
- Create: `src/runtime/browser-tool.ts`
- Create: `src/runtime/mcp-client.ts`
- Create: `src/runtime/harness-registry.ts`
- Create: `src/harness/claude-code.ts`, `src/harness/pi.ts`, `src/harness/omp.ts`, `src/harness/freebuff.ts`
- Modify: `src/server/http-server.ts` (wire tool runner to `/api/tools/execute`)
- Modify: `src/main.ts` (register adapters)
- Tests: `tests/capabilities.ts`, `tests/tool-runner.ts`

## Acceptance Criteria
- Permission policy enforced (engineer cannot spawn agents without approval)
- Terminal tool executes commands via PTY, returns stdout/exit code
- Filesystem tool scoped to project root; out-of-root write → approval required
- Git tool works on real repo
- Destructive op emits `approval.requested` and blocks until decision
- Browser session navigates, extracts, screenshots → artifact
- MCP client proxies capability calls with validation
- Harness adapters detect binaries; fallback to generic
- All focused tests pass

## Constraints
- Runtime authoritative; tools are capabilities, not orchestration
- Playwright is optional dependency — degrade gracefully if not installed
- No fake tool implementations; missing capability = honest error
- Approval gates for destructive operations per spec §11
- Do not modify NodeForge/RuntimePilot core files beyond wiring

## Report
Write to `.superpowers/reports/capabilitycrew.md`