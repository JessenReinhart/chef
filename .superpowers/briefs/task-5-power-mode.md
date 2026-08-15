# Task 5: Power Mode Advanced Panels

## Context
Phase 1–3 complete. Chef now has:
- Node registry/engine (`src/core/nodes.ts`, `src/runtime/node-registry.ts`, `src/runtime/node-execution-engine.ts`)
- Backend API (`/api/state`, `/api/graph`, `/api/events` SSE, `/api/sessions/send|interrupt|resize`, `/api/inspector/*`, approvals)
- Workbench shell (`web/src/App.tsx`, `web/src/CanvasPanel.tsx`, `web/src/workbench.css`) with Simple/Power mode toggle
- PTY replay (`src/harness/generic.ts`, `session.data` events)

## Deliverables
1. **Live Logs Panel** (`web/src/LogsPanel.tsx`) — event stream with node/session filters, timestamps
2. **Interactive Terminal Panes** (`web/src/TerminalPanes.tsx`) — wired to existing send/interrupt/resize APIs
3. **Context Bus Inspector** (`web/src/ContextBusPanel.tsx`) — refs, artifacts, decisions, events for selected node
4. **Wide Inspector** (`web/src/WideInspector.tsx`) — model, temperature, token limits, permissions, retry config, harness settings
5. **Dark Power Mode styling** — matches visual spec: dense dark panels, terminal feel, logs, status colors

## Existing Contracts
- `web/src/App.tsx` — `events: RuntimeEvent[]`, `sessions: SessionInfo[]`, `sendSession`, `interruptSession`, mode state
- `web/src/CanvasPanel.tsx` — `onSelectNode(node | null)`
- `src/core/types.ts` — `RuntimeEvent`, `Session`, `Artifact`, `ContextReference`, `HarnessEvent`
- `src/server/http-server.ts` — `GET /api/events?afterSeq&types=`, `GET /api/inspector/state`, `GET /api/inspector/sessions?live`, `POST /api/sessions/send`, `POST /api/sessions/interrupt`, `POST /api/sessions/resize`

## Logs Panel
- Filter by node/session/task, glob `types=` support from backend
- Timestamps, colored status, live SSE stream
- "View Full Logs" expansion matching visual spec

## Terminal Panes
- Real interactive terminals using PTY data from `/api/events` (session.data events) and send/resize/interrupt APIs
- Terminal 1: command runner (npm test etc.)
- Terminal 2: git operations
- Visual spec: `chef@workspace:~$ npm test` style prompt rendering

## Context Bus
- Shared context across nodes: artifacts (data.csv 120 rows, report.md 32KB), decisions, events
- Selected-node context references from `ContextReference[]`
- Artifact preview/download where URI available

## Wide Inspector
- Selected node: model, temperature, maxTokens, permissions, retry policy, harness config
- Two-column layout for dense config
- Save via `/api/nodes/:taskId/status` (if node exists) or local draft with "config saved" state

## Acceptance Criteria
- Logs panel shows live events with working filters
- Terminal pane renders PTY output and accepts input through existing APIs
- Context Bus shows refs/artifacts/decisions for selected node
- Wide Inspector edits are validated and saved
- Dark Power Mode styling matches visual spec
- All focused tests pass

## Constraints
- Runtime authoritative; no client-only state mutations for execution
- Do not modify NodeForge or RuntimePilot core files
- Reuse existing API contracts
- No fake providers or silent fallbacks
- Respect reduced-motion and keyboard focus

## Files to Create/Modify
- Create: `web/src/LogsPanel.tsx`
- Create: `web/src/TerminalPanes.tsx`
- Create: `web/src/ContextBusPanel.tsx`
- Create: `web/src/WideInspector.tsx`
- Modify: `web/src/App.tsx` (Power Mode layout wiring)
- Modify: `web/src/workbench.css` (dark theme refinements)
- Tests: `tests/power-mode.ts` (UI contract tests if feasible; else build-only verification)

## Report
Write to `.superpowers/reports/powerdeck.md`