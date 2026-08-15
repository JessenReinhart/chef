# RuntimePilot — Phase 2 API/Backend Foundation

## Scope

Expanded the HTTP backend with workflow, template, node-run, tool, and inspector
endpoints plus a filterable, restart-safe SSE stream. Runtime remains
authoritative; the web UI stays a projection.

## Changed Files (exact list for merge)

- `src/server/http-server.ts` — new endpoints + enhanced `/api/events` SSE
- `src/persistence/schema.sql` — added `templates` table (only schema addition)
- `src/persistence/database.ts` — `Template` type, `TemplateInput`, `mapTemplate`,
  Repository methods: `insertTemplate`, `getTemplate`, `listTemplates`,
  `updateTemplate`, `deleteTemplate`
- `tests/api-backend.ts` — new focused regression test

## New Exports

- `src/persistence/database.ts`: `Template` (interface), `TemplateInput` (interface);
  Repository gains `insertTemplate`, `getTemplate`, `listTemplates`,
  `updateTemplate`, `deleteTemplate` methods.
- `src/server/http-server.ts`: no new exports (endpoints only).

## New Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/workflows` | list plans |
| GET | `/api/workflows/:id` | get plan |
| POST | `/api/workflows` | create draft plan `{ goal }` |
| PATCH | `/api/workflows/:id` | update plan status (validated) |
| GET | `/api/templates` | list templates |
| GET | `/api/templates/:id` | get template |
| POST | `/api/templates` | create template `{ name, description?, nodes?, metadata? }` |
| PATCH | `/api/templates/:id` | update template |
| DELETE | `/api/templates/:id` | delete template |
| POST | `/api/nodes/run` | create pending task `{ nodeId, title?, assignedTo?, workflowNodeId? }` |
| GET | `/api/nodes/:taskId/status` | task status |
| POST | `/api/nodes/:taskId/cancel` | cancel task |
| GET | `/api/tools` | catalog of tool types (static) |
| POST | `/api/tools/execute` | **501** — no tool runner exists; honest error, no fake success |
| GET | `/api/inspector/state` | full snapshot |
| GET | `/api/inspector/sessions?live=true` | sessions, optional live filter |
| GET | `/api/inspector/events?afterSeq&limit` | paginated events |
| GET | `/api/inspector/artifacts` | artifacts |
| GET | `/api/events?afterSeq=N&types=a.b*` | SSE with replay + type filtering |

## Error Contract

- 400 `{ error }` on malformed/missing fields
- 404 `{ error }` on unknown resources/routes
- 501 `{ error }` on tool execution (no runner)
- 500 `{ error }` on unexpected failure
- Success: `{ ok: true, data }` or `{ ok: true }`

## NodeRun Semantics

`POST /api/nodes/run` creates a durable `pending` task via the existing
Repository (runtime-authoritative). A running engine is owned by NodeForge
(`src/runtime/node-execution-engine.ts`) — the API intentionally exposes the
durable task seam only and does not invent dispatch behavior.

## Verification

- `node --experimental-strip-types tests/api-backend.ts` — PASS
  (routes, validation, restart-safe state across close/reopen)
- `node --experimental-strip-types tests/http-server.ts` — PASS (regression)
- `node --experimental-strip-types tests/golden-path.ts` — PASS (regression)
- `node --experimental-strip-types tests/canvas-graph.ts` — PASS (regression)

Project-wide build/lint skipped per assignment.

## Notes

- `templates` table is idempotent `CREATE TABLE IF NOT EXISTS` — matches the
  no-migration persistence convention.
- SSE `/api/events` now supports `afterSeq` replay and `types=` glob filters;
  existing behavior (no params) unchanged.
