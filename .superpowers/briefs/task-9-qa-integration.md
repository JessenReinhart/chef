# Task 9: Integration, Documentation, and Final Verification

## Context
Phases 1–8 complete or in progress. The final phase wires everything together, runs the complete acceptance suite against the spec, updates all documentation, and produces an honest audit.

## Deliverables
1. **End-to-End Acceptance Suite** — run all spec acceptance tests (§22):
   - P0 Golden Path (workspace → user message → orchestrator → task → harness → artifact → report → reopen → history)
   - Multi-Agent Acceptance (Claude → Pi → OMP → test → retry → report)
   - Direct Intervention (open worker terminal, send instruction, orchestrator sees it)
   - Failure/Recovery (worker crash → BLOCKED/RETRYABLE → orchestrator replans → workspace healthy)
   - Visual Workflow Acceptance (Simple Mode Accountant flow, Power Mode Developer flow)
2. **Documentation Refresh** — update from actual behavior:
   - `README.md` (setup, run, test, architecture summary)
   - `AGENTS.md` (project guidance current with all phases)
   - `API_REFERENCE.md` (all endpoints, schemas, SSE events)
   - `ARCHITECTURE.md` (runtime boundaries, data flow, node contract)
   - `UI_USAGE.md` (Simple/Power mode, templates, chat, console, approvals)
   - `SETUP.md` (env vars, providers, harnesses, MCP config)
3. **Spec-to-Implementation Audit** — every concrete requirement in `AI_Engineering_OS_Specification_v0.1.pdf` checked against code; record intentionally deferred items
4. **Restart/Replay Verification** — close/open workspace, verify durable state, PTY replay, event sequence integrity
5. **Security/Review Pass** — secrets handling, approval gates, scope enforcement, no fake providers
6. **Cleanup** — remove obsolete scaffolding (old SVG paths, dead files) only after replacements verified

## Existing Contracts
- All prior phases' outputs
- `src/main.ts` — `createChef`, `ChefRuntime`
- `tests/*.ts` — full regression suite

## Acceptance Criteria
- All spec acceptance scenarios execute successfully
- Documentation reflects actual behavior (no aspirational claims)
- Audit table: requirement → implemented | deferred (with reason) | not started
- Restart/replay verified
- No placeholder/fake success paths remain
- Backend tests pass; web build passes
- Final commit with "feat: Chef finished product" or honest milestone label

## Files
- Create: `docs/AUDIT.md` (spec audit table)
- Update: `README.md`, `AGENTS.md`, and any new docs
- Create: `tests/acceptance.ts` (orchestrates all acceptance scenarios)
- Run: full test suite, web build, manual acceptance scenarios

## Report
Write to `.superpowers/reports/qa-atlas.md`

## Constraints
- Honest labeling — do not claim P0–P5 complete if they are not
- Evidence before assertions always
- Remove scaffolding only after replacements verified