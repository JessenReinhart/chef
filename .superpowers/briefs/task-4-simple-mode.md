# Task 4: Simple Mode Templates + Guided Wizard

## Context
Phase 1–3 complete. Node registry, backend API, and workbench layout are frozen. Chef now has:
- `src/core/nodes.ts` — node contracts (9 types)
- `src/runtime/node-registry.ts` — `nodeRegistry`, `NODE_DEFINITIONS`, config types
- `src/runtime/node-execution-engine.ts` — `NodeExecutionEngine`
- `src/server/http-server.ts` — `/api/workflows`, `/api/templates`, `/api/nodes/run`, etc.
- `web/src/App.tsx` — workbench shell with Simple↔Power mode toggle
- `web/src/nodeCatalog.tsx` — `NODE_LIBRARY` (8 entries)
- `web/src/NavigationPanel.tsx` — node library drag source

## Deliverables
1. **Template Gallery** (`web/src/TemplateGallery.tsx`, backend integration)
2. **Guided Setup Wizard** — plain-language flow for template parameters
3. **Simple Inspector Fields** — progressive disclosure, friendly labels
4. **Mode Toggle Integration** — preserve workflow, hide runtime terminology

## Existing Contracts (copy from)
- `src/runtime/node-registry.ts` — `NODE_DEFINITIONS`, config types (AgentNodeConfig, TerminalNodeConfig, etc.)
- `src/persistence/database.ts` — `Template`, `TemplateInput`, `Repository.insertTemplate`, `getTemplate`, `listTemplates`
- `src/server/http-server.ts` — `GET/POST/PATCH/DELETE /api/templates`, `POST /api/nodes/run`
- `web/src/nodeCatalog.tsx` — `NODE_LIBRARY`

## Required Templates (from visual spec)
1. **Monthly Financial Report** — Read Data (Excel) → Analyze → AI Accountant → Dashboard → Decision → Review Agent → Email
2. **Cash Flow Analysis** — similar financial pattern
3. **Budget vs Actual** — similar financial pattern
4. **Developer Fix/Verify** — Orchestrator → Research Agent → Code Agent → Terminal → Browser → Test Agent → Review Agent → Git

## Wizard UX (spec §13.1)
- Select template → guided questions per node config (files, recipients, thresholds, approvals)
- Plain language labels: "Bank statement file" not "File node source path"
- Progressive disclosure: advanced settings behind expandable sections
- Preview generated workflow before run

## Simple Inspector
- Replace config JSON with friendly form fields per node type
- Hide: model/temperature/tokens, harness IDs, PTY settings
- Show: file picker, recipient list, threshold numbers, approval checkboxes
- Validate required fields inline

## Mode Toggle
- Same workflow definition, same runtime IDs
- Simple: friendly labels, no terminal nodes, no model config
- Power: full config, logs, terminals, context bus
- Toggle state persists per workspace

## Files to Create/Modify
- Create: `web/src/TemplateGallery.tsx`
- Create: `web/src/SetupWizard.tsx`
- Modify: `web/src/InspectorPanel.tsx` (Simple mode fields)
- Modify: `web/src/App.tsx` (template selection flow)
- Create: `web/src/simpleNodeConfig.tsx` (config field renderers)
- Tests: `tests/simple-mode.ts` (template CRUD, wizard validation, mode switching, workflow launch)

## Acceptance Criteria
- Template gallery lists 4 templates with thumbnails
- Selecting a template opens wizard with all required fields
- Wizard validates and creates a runnable workflow graph
- Mode toggle preserves workflow and switches UI theme/fields
- Running the workflow via existing `/api/nodes/run` executes all nodes
- All focused tests pass

## Constraints
- Runtime authoritative; UI is projection
- No fake providers or silent fallbacks
- Reuse existing `/api/templates`, `/api/nodes/run`, `/api/graph`
- Do not modify NodeForge files (`src/core/nodes.ts`, `src/runtime/node-registry.ts`, `src/runtime/node-execution-engine.ts`)
- Do not modify RuntimePilot files (`src/server/http-server.ts` endpoints, `src/persistence/database.ts` exports)
- Use existing `NODE_DEFINITIONS` config types verbatim

## Report
Write to `.superpowers/reports/simpleflow.md`