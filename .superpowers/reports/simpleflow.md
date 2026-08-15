# Phase 4 — Simple Mode Templates + Guided Wizard

## Status: COMPLETE

## Deliverables
- `web/src/TemplateGallery.tsx` — template gallery with 4 templates (Monthly Financial Report, Cash Flow Analysis, Budget vs Actual, Developer Fix/Verify), category filters, search, built-in fallback
- `web/src/SetupWizard.tsx` — guided wizard: plain-language params per node, progressive disclosure (advanced sections), preview graph before run
- `web/src/simpleNodeConfig.tsx` — simple mode field renderers + config mapping (simple→runtime, runtime→simple)
- `web/src/InspectorPanel.tsx` — simple mode friendly form fields (mode-aware, required validation inline)
- `web/src/App.tsx` — template selection flow, wizard completion, mode toggle with localStorage persistence per workspace
- Runtime template seeding (idempotent, in `src/main.ts`): 4 templates seeded on first workspace creation
- `tests/simple-mode.ts` — full regression suite
- `.superpowers/reports/simpleflow.md` — this report

## Tests (tests/simple-mode.ts)
1. **Template CRUD** — runtime seeds exactly 4 templates; list/get/update/delete via Repository + HTTP (`GET/POST/PATCH/DELETE /api/templates`); validation (missing name → 400, missing template → 404); workspace-scoped isolation
2. **Wizard validation** — required fields per node type flagged on empty/partial answers; number bounds (approval timeout ≤168h, logic iterations ≤1000); complete answers pass; simple→runtime mapping produces configs accepted by `NODE_DEFINITIONS` (via both direct `config.validate` and `nodeRegistry.require`); approval hours→ms conversion; recipients→deliveryChannels split
3. **Mode switching** — localStorage round-trip (default simple, persist power↔simple), per-workspace keys; workflow definition (plans/tasks/approvals) unchanged across toggles via `inspectState`
4. **Workflow launch** — `POST /api/nodes/run` per node → 201 + taskId; tasks persisted with `workflowNodeId` links; graph projection (`GET /api/graph`) version 1 includes launched tasks; approval node present in template

## Verification
- `node --experimental-strip-types tests/simple-mode.ts` → PASS
- `node --experimental-strip-types tests/api-backend.ts` → PASS
- `node --experimental-strip-types tests/canvas-graph.ts` → PASS
- `node --experimental-strip-types tests/node-registry.ts` → PASS
- `npm run build` (web/) → PASS (0 errors)

## Notes
- Runtime is authoritative; UI is projection. No backend modifications made by this phase's test work.
- `tests/simple-mode.ts` mirrors `web/src/simpleNodeConfig.tsx` mapping logic against runtime `NODE_DEFINITIONS` to guarantee wizard-generated workflows always validate.
- Approval node execution requires a live approval flow (covered by tests/approvals.ts); simple-mode test verifies the approval node exists in the launched workflow's template and graph.
