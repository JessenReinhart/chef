# Task 7: Execution Console + Results

## Context
Phases 1–6 complete. Node registry/engine, backend API, workbench UI, Simple templates, Power panels, and Chat streaming all landed. Chef now has:
- `web/src/ConsolePanel.tsx` — bottom console (Events + Chat tabs)
- `web/src/App.tsx` — workbench shell
- `/api/inspector/artifacts`, `/api/inspector/events`, `/api/inspector/state`
- `RuntimeEvent`, `Artifact`, `ContextReference` types

## Deliverables
1. **Node Status Timeline** — bottom panel showing running/completed/failed/waiting states per node with progress
2. **Progress Indicators** — real-time node progress from `/api/events` + `/api/graph` status
3. **Artifact/Result Cards** — preview, provenance, version, download, share
4. **Error Handling + Retry UI** — retry/replan/error controls tied to runtime policies
5. **Approval Queue + Blockers Summary** — pending approvals, blocked tasks
6. **Cost/Token/Session Metrics** — where available; explicit "unknown" otherwise

## Existing Contracts
- `web/src/App.tsx` — `state.snapshot`, `events`, `sessions`, mode, `refresh`
- `web/src/ConsolePanel.tsx` — props `{ events: RuntimeEvent[] }`
- `src/core/types.ts` — `WorkspaceSnapshot` (tasks, sessions, artifacts, decisions, approvals), `RuntimeEvent`
- `src/server/http-server.ts` — `/api/inspector/*`, `/api/graph`, `/api/events`, `/api/approvals/:id/accept|reject`
- `src/runtime/node-registry.ts` — NodeStatus enum

## Design (from visual spec)
- Bottom console: node status timeline (colored dots, elapsed time, node names), progress bars for running nodes, artifacts tab
- Artifact card: name, type icon, version, createdBy, timestamp, URI, Preview/Download/Share buttons
- Blockers: pending approvals listed with Accept/Reject (reuse existing approval endpoints)
- Error state: node failed → show error event, Retry button (POST /api/nodes/run with same nodeId), Replan hint
- Metrics strip: sessions live count, tasks by status, artifacts count, cost "unknown" when not available

## Acceptance Criteria
- Timeline renders live status transitions from SSE events
- Running nodes show progress; completed show duration
- Artifact cards render from real `/api/inspector/artifacts` data with preview/download
- Approval queue shows pending approvals with working Accept/Reject
- Failed nodes show error + Retry control wired to runtime
- Metrics strip shows real counts + explicit "unknown" for cost/tokens
- Build passes in web/
- Focused test `tests/execution-console.ts` passes

## Constraints
- Runtime authoritative; UI projection. Retry must go through runtime APIs.
- Do not modify NodeForge/RuntimePilot/ChatStream core contracts without IRC.
- No fake data; missing metrics render as "unknown".
- Respect reduced motion + keyboard focus.

## Files
- Modify: `web/src/ConsolePanel.tsx` (timeline + artifacts + blockers tabs)
- Modify: `web/src/App.tsx` (metrics strip wiring)
- Modify: `web/src/workbench.css` (console styling)
- Create: `tests/execution-console.ts`

## Report
Write to `.superpowers/reports/consoleatlas.md`