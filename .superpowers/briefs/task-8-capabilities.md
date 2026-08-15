# Task 8: Tool/MCP + Specialized Harnesses

## Context
Phases 1–6 complete. Node registry has tool node definitions (`tool.terminal` executes via PTY, `tool.file` read/transform inline, `tool.database` sqlite only; browser/non-JS transform/non-sqlite throw descriptive errors). Phase 2 API has `GET /api/tools` + `POST /api/tools/execute` (honest 501 — no tool runner). Phase 6 chat has LLM decision provider.

## Deliverables
1. **Capability Registry + Permission Policy** (`src/runtime/capabilities.ts`)
   - Capabilities: filesystem, terminal, network, browser, git, github, spawnAgents, assignTasks, deploy
   - Defaults per spec §11.2: Engineer (filesystem/terminal/git allowed; spawnAgents denied; deploy approval), Orchestrator (all except deploy), Human (all)
2. **Deterministic Tool Runner** (`src/runtime/tool-runner.ts`)
   - Terminal: PTY harness + `runCommand()`
   - Filesystem: read/write scoped to project root, allowed extensions
   - Git: status/diff/commit/branch scoped to repo
   - Approval gates for destructive actions (out-of-root write, deploy, git push)
3. **Browser Sessions** (`src/runtime/browser-tool.ts`) — Playwright browser sessions as inspectable tool nodes; degrade gracefully if Playwright not installed (honest error, no fake)
4. **MCP Client Adapters** (`src/runtime/mcp-client.ts`) — capability integration, NOT orchestration protocol
5. **Specialized Harness Adapters** (`src/harness/claude-code.ts`, `src/harness/pi.ts`, `src/harness/omp.ts`, `src/harness/freebuff.ts`) — binary detection + spawn config; generic PTY fallback

## Existing Contracts
- `src/harness/generic.ts` — `GenericTerminalHarness`, `runCommand()`
- `src/runtime/node-registry.ts` — `TerminalNodeConfig`, `FileNodeConfig`, `BrowserNodeConfig`, `DatabaseNodeConfig`
- `src/core/types.ts` — `AgentPermissions`, `Harness`, `HarnessSession`, `SpawnConfig`
- `src/server/http-server.ts` — `GET /api/tools`, `POST /api/tools/execute` (currently 501)
- `src/runtime/node-execution-engine.ts` — `NodeExecutionEngine`, `GraphNodeSpec`

## Tool Runner
- `POST /api/tools/execute` implements real execution (replace 501)
- Request: `{ tool, config, input, permissions }`
- Response: `{ ok, output, artifact?, status, durationMs }`
- Validation order: permission policy → config schema → execution
- Destructive ops → `approval.requested` event + pending until `resolveApproval`

## Browser Tool
- Playwright `chromium.launch({ headless })` when installed
- Actions: navigate, click, extract, screenshot
- Browser session inspectable: `GET /api/browser/:sessionId`, `POST /api/browser/:sessionId/action`
- Screenshot → artifact with provenance
- Playwright absent → 501-style honest error

## MCP Client
- `mcpServers` config in workspace settings (env `CHEF_MCP_SERVERS` JSON for now)
- Each server = capability provider (filesystem, browser, git, github, etc.)
- Tool call validation against permission policy
- Never used for orchestration protocol — only capabilities

## Harness Adapters
- `detect()` — check binary availability (claude, pi, omp, freebuff)
- `spawn(config)` — correct CLI flags, env, cwd
- Registered in `src/runtime/harness-registry.ts`; fallback to GenericTerminalHarness
- Wire into `src/main.ts` registration

## Tests
- `tests/capabilities.ts` — policy enforcement (engineer denied spawnAgents, approval for deploy, scope violation)
- `tests/tool-runner.ts` — terminal command, filesystem scope, git ops, approval gate, browser graceful degradation

## Acceptance Criteria
- Permission policy enforced end-to-end
- Terminal tool executes via PTY, returns stdout/exit code
- Filesystem tool scoped; out-of-root write → approval
- Git tool works on real repo
- Destructive op emits `approval.requested` + blocks until decision
- Browser session navigate/extract/screenshot → artifact (or honest error without Playwright)
- MCP client proxies capability calls with validation
- Harness adapters detect binaries; generic fallback works
- Focused tests pass

## Constraints
- Runtime authoritative; tools are capabilities, not orchestration
- Playwright optional — graceful degradation required
- No fake tool implementations; missing capability = honest error
- Approval gates for destructive ops per spec §11
- Do not modify NodeForge/RuntimePilot/ChatStream core files beyond wiring endpoints

## Files
- Create: `src/runtime/capabilities.ts`, `src/runtime/tool-runner.ts`, `src/runtime/browser-tool.ts`, `src/runtime/mcp-client.ts`, `src/runtime/harness-registry.ts`
- Create: `src/harness/claude-code.ts`, `src/harness/pi.ts`, `src/harness/omp.ts`, `src/harness/freebuff.ts`
- Modify: `src/server/http-server.ts` (wire tool runner), `src/main.ts` (register adapters)
- Create: `tests/capabilities.ts`, `tests/tool-runner.ts`

## Report
Write to `.superpowers/reports/capabilitycrew.md`