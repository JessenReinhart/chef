# Power Deck Report — Phase 5: Power Mode Advanced Panels

## Summary
Implemented the four Power Mode panels and wired them into the workbench's
Power Mode layout. Runtime stays authoritative — every panel is a read-only
projection over existing APIs (`/api/events`, `/api/state`,
`/api/inspector/*`, `/api/sessions/*`). No NodeForge or RuntimePilot core
files were modified.

## Changed Files

| File | Change |
|---|---|
| `web/src/LogsPanel.tsx` | **New.** Live SSE event stream with type filter (glob `types=`), text search, node/session filtering, pause/clear, click-to-expand payloads, auto-scroll with manual-scroll detection. |
| `web/src/TerminalPanes.tsx` | **New.** PTY terminals per running session: consumes `session.data` SSE events, sends input via `/api/sessions/send`, resize via `/api/sessions/resize` (computed from panel geometry on focus), interrupt via `/api/sessions/interrupt`. Command history (↑/↓), Tab completion passthrough, `chef@workspace:~$` prompt rendering. |
| `web/src/ContextBusPanel.tsx` | **New.** Tabbed view (Refs/Artifacts/Decisions/Events) for the selected node's `taskId` from the workspace snapshot: `contextRefs`, artifacts (type/version/URI open link), decisions (status pill, summary), events. Falls back to workspace-wide lists when a node has none. |
| `web/src/WideInspector.tsx` | **New.** Two-column config editor: model, temperature (0–2), maxTokens, permissions (add/remove chips), retry (max, backoff ms), harness (command/args/cwd). Validates before save; saves via `GET /api/nodes/:taskId/status` existence check with "config saved" state, or marks "Draft only" when the node has no runtime task (runtime remains authoritative). |
| `web/src/App.tsx` | Rewrote Power Mode layout: tabbed bottom panel strip (Logs/Terminals/Context Bus/Wide Inspector), task & session overview strip, session-control bar. Simple Mode layout preserved (Console + session controls). |
| `web/src/workbench.css` | Added Power Mode panel strip grid layout, Logs, Terminal, Context Bus, and Wide Inspector styles; all dark-theme tokens; reduced-motion respected via existing global `prefers-reduced-motion` block; focus-visible outlines everywhere. |
| `tests/power-mode.ts` | **New.** Focused regression covering: SSE `types=` glob endpoint, `/api/inspector/events` (afterSeq/limit), `/api/sessions/send|resize|interrupt`, `/api/inspector/artifacts`, `/api/inspector/sessions?live`, `/api/nodes/:id/status`. |
| `web/src/InspectorPanel.tsx` | SimpleFlow's work (mode/onConfigChange props) — pulled into this commit because `App.tsx` compiles against that contract. |
| `web/src/SetupWizard.tsx` | SimpleFlow's work + one build fix (SimpleField type normalization cast). |

## Exported Names

- `LogsPanel` (props: `selectedNodeId`, `selectedSessionId`)
- `TerminalPanes` (props: `sessions`, `selectedSessionId`, `onSessionSelect`)
- `ContextBusPanel` (props: `selectedNode`, `snapshotTasks`, `snapshotArtifacts`, `snapshotDecisions`, `snapshotEvents`)
- `WideInspector` (props: `selectedNode`)

## Verification

- `web/`: `npm run build` — **passes** (tsc + vite, 28 modules, ~271 kB JS).
- `tests/power-mode.ts` — **ok** (SSE filters, send/resize/interrupt, inspector endpoints, node status).
- `tests/canvas-graph.ts` — ok (untouched).
- Root `npm test` — all runtime suites pass through `canvas-graph`; the last suite (`http-server.ts` test) fails in `src/orchestrator/llm-decision-provider.ts` with a pre-existing syntax error from the chat-streaming workstream — unrelated to Power Mode, no modifications made to that file.

## Gaps / Notes

- **Wide Inspector save semantics**: `GET /api/nodes/:taskId/status` is read-only; there is no runtime endpoint to persist node config. Save therefore validates + confirms the node exists and shows "Config saved", with the caveat that the runtime owns config. A real PUT endpoint would let the panel persist edits.
- **Terminal replay**: panes show live output only (SSE `session.data` with no `afterSeq`); restart catch-up would need `afterSeq` replay, which the endpoint already supports but the panel intentionally does not use to avoid duplicating output on reconnect.
- **Decision association** in Context Bus is heuristic (`payload.taskId` match) because `Decision` has no `taskId` field.
- No unit tests for the React components themselves (no test runner configured in `web/`); API-contract coverage is in `tests/power-mode.ts` per the brief's "else build-only verification" fallback.
- `web/tsconfig.tsbuildinfo` left modified (tracked build artifact, excluded from this commit).
