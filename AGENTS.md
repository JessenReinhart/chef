# Repository Guidelines

## Project Overview
Chef is a local-first, restart-safe **living AI workspace** built on the AI Engineering OS runtime. The current product/runtime contract is `docs/PRODUCT_RUNTIME_SPEC_V0.2.md`; the original `AI_Engineering_OS_Specification_v0.1.pdf` remains useful historical architecture context.

Chef turns human intent into durable Missions and plans, coordinates dependency-aware Tasks through terminal-based agent harnesses, shares bounded context between nodes, persists runtime state in SQLite, and exposes that state through HTTP/SSE plus a React/Vite canvas UI.

Core mantra: **the UI is disposable; the runtime is the product.** UI state must project authoritative runtime state rather than become a second source of truth.

## Architecture & Data Flow
`src/main.ts` assembles the dependency-injected runtime:

1. `Orchestrator` records user intent, asks a `DecisionProvider` for structured decisions, creates durable plans/tasks/Missions, and coordinates execution.
2. `Scheduler` finds runnable Tasks, persists lifecycle transitions transactionally, dispatches harness Sessions, handles structured events, retries, approvals, and startup recovery.
3. Harnesses run terminal-based agents. `GenericTerminalHarness` uses `node-pty`; specialized adapters live under `src/harness/`.
4. `ContextManager` resolves durable references and materializes Task inboxes. Canvas relationships and Context Zones scope shared context.
5. `Repository` is the authoritative SQLite writer for workspace, Mission, Automation, Task, Session, approval, event, artifact, message, canvas, and related state.
6. `src/server/http-server.ts` exposes runtime projections and mutations over HTTP/SSE. `web/` renders the living workspace but never owns lifecycle truth.

The default planner is deterministic `ScriptedDecisionProvider`; an LLM-backed provider can be configured. The server and web UI are implemented and supported development surfaces, not future placeholders.

Runtime boundaries:
- runtime owns lifecycle, scheduling, cancellation, retries, permissions, approvals, persistence, and authoritative state;
- harnesses own process/PTY behavior;
- context selects references rather than copying whole histories;
- events are immutable history;
- artifacts are durable references;
- LLMs may propose structured decisions, but runtime APIs validate and execute them;
- MCP/tools are capability layers, not Chef's orchestration protocol.

Intended loop:

`human intent → Mission → Orchestrator → Tasks → live agents/tools → shared context → artifacts → verification → human outcome`

## Key Directories
- `src/core/` — shared domain contracts and ID/time helpers.
- `src/orchestrator/` — planning, Mission coordination, and end-to-end execution.
- `src/runtime/` — scheduling, recovery, retries, capabilities, tools, Automations, and runtime projections.
- `src/harness/` — generic PTY harness plus specialized terminal-agent adapters and sideband protocol.
- `src/context/` — durable context references, scopes, and inbox materialization.
- `src/persistence/` — SQLite schema and `Repository` transactions/CRUD.
- `src/server/` — HTTP/SSE runtime projection and mutation API.
- `web/` — React/Vite + `@xyflow/react` living-workspace UI.
- `tests/` — executable Node regression/acceptance suites.
- `docs/` — current runtime/product specs, audits, context docs, and implementation plans.
- `scripts/` — manual smoke and diagnostic scripts.

## Current Implementation Baseline
Treat `master` as the shipped-state baseline and verify claims against code before selecting work.

Implemented on `master` includes:
- restart-safe SQLite runtime with durable Tasks, Sessions, Plans, Missions, Automations/runs, approvals, messages, events, artifacts, templates, and canvas state;
- bounded concurrent dispatch, retries, cancellation, timeout teardown, deterministic workspace snapshots, and atomic event sequencing;
- PTY transcript replay and live event subscription;
- direct worker send/interrupt/resize controls;
- approval-gated capability execution and fail-closed permission policy;
- durable typed canvas graph and runtime-owned node positions;
- `@xyflow/react` canvas UI;
- terminal nodes with live PTY surfaces;
- browser/tool runtime surfaces;
- Context Zones/context scopes and context sharing through typed canvas relationships;
- peer/agent messaging;
- HTTP/SSE server and Simple/Power UI modes;
- CI workflow validating runtime tests and the web build.

Do **not** re-open already-shipped migrations such as "add React Flow", "add terminal nodes", "add approvals", or "add server/UI" without first proving a concrete missing behavior.

Still-deferred or incomplete areas must be verified against current code and open PRs before implementation. Product-level work should follow `docs/PRODUCT_RUNTIME_SPEC_V0.2.md`, `docs/AUDIT.md`, current plans, and any newer accepted product guidance.

## Persistence & Runtime Invariants
- Persist authoritative mutations through `Repository` transactions. In-memory maps are indexes/session handles, not durable truth.
- Use `TaskMachine` and its allowed transition table; do not mutate Task lifecycle status ad hoc.
- Sideband files use structured envelopes separate from PTY stdout/stderr.
- Event sequence allocation must remain atomic; do not reintroduce separate `MAX(seq)` then insert logic.
- Dispatch concurrency is enforced inside the dispatch transaction; do not move capacity enforcement to a stale pre-dispatch snapshot.
- Plans, Missions, Automations, approvals, and canvas mutations must remain write-through durable state.
- `ChefRuntime.subscribeEvents` is the runtime seam for live projections; do not expose repository internals directly to UI clients.
- Canvas edges/relationships carry semantics, including context sharing. Do not treat every edge as mere visual decoration or sequencing.
- Agent identity is durable; a Session is an execution instance, not the identity itself.

## Canvas & UI Rules
- The web app is a projection over authoritative runtime state.
- Persist canvas mutations through runtime APIs before treating them as durable.
- Simple Mode should hide unnecessary runtime/provider jargon; Power Mode may expose detailed execution state.
- Missions and living workspace interactions do not require a global Run gate. Explicit Run/Stop semantics belong to Automations or other deliberately executable graphs.
- Terminal/browser surfaces are live runtime-backed nodes; preserve cleanup and lifecycle ownership boundaries.

## Development Commands
```bash
npm install
npm start
npm test
npm run typecheck
npm run server
node --experimental-strip-types scripts/smoke-orchestrator.ts
node --experimental-strip-types scripts/db-repro.ts
```

Web validation:

```bash
cd web
npm install
npx tsc -b
npm run build
```

`npm test` is the root gating regression command. Inspect `package.json` for the exact current suite list rather than copying an old suite count into new guidance.

## Code Conventions
- ESM TypeScript executes directly through Node native type stripping; avoid enums, namespaces, and parameter properties.
- Prefer `async`/`await`, async event queues, private `#` fields, and small structural DI interfaces.
- Operational failures generally throw; cleanup paths may intentionally swallow cleanup-only errors.
- Keep relational Task dependencies in `task_dependencies`; structured persisted values may use JSON columns where already established.
- Inline property access on a cast is disallowed (`ts-no-inline-cast-access`): use a named const with a reason or a real type guard.
- `ReturnType<typeof fn>` contracts are disallowed (`ts-no-return-type`): export named types at the owning module.
- Existing duplicated contracts such as `ContextReference`, `HarnessEvent`, or `SessionStatus` require care when changing imports/exports.
- Comments should explain non-obvious rationale, invariants, constraints, or tradeoffs. Do not narrate obvious code or preserve PR history such as `Fix 1` in production comments.

## Important Files
- `src/main.ts` — `createChef()` composition root and `ChefRuntime` facade.
- `src/orchestrator/orchestrator.ts` — Orchestrator and scripted decision flow.
- `src/orchestrator/llm-decision-provider.ts` — optional LLM-backed structured planning.
- `src/runtime/scheduler.ts` — dispatch, lifecycle, retries, and recovery.
- `src/runtime/task-machine.ts` — allowed Task transitions.
- `src/runtime/capabilities.ts` — capability/permission policy.
- `src/runtime/tool-runner.ts` — runtime-owned tool execution and approval gates.
- `src/runtime/browser-tool.ts` — browser capability/runtime surface.
- `src/runtime/layout.ts` — deterministic graph layout helpers.
- `src/harness/generic.ts` — generic PTY harness implementation.
- `src/harness/sideband.ts` — structured session inbox/outbox protocol.
- `src/context/context.ts` — context resolution/materialization.
- `src/persistence/database.ts` — authoritative repository and transactions.
- `src/persistence/schema.sql` — SQLite tables, foreign keys, and indexes.
- `src/server/http-server.ts` — HTTP/SSE runtime API.
- `web/` — disposable React Flow living-workspace projection.
- `handoff.md` — operational bug history and platform-specific constraints.
- `diag-handles.mjs` — PTY/handle diagnostic script.

## Runtime / Tooling Preferences
- Required runtime: Node.js `>=24.0.0`.
- Package manager: npm with `package-lock.json`.
- `node-pty` is native-sensitive; preserve Windows-specific handling documented in `handoff.md`.
- SQLite uses Node's `node:sqlite` `DatabaseSync` with a hand-written schema; there is no ORM migration framework.
- The repository has GitHub Actions CI. Never claim CI is absent without checking `.github/workflows/`.
- The root `typecheck` command is intended to be gating; inspect its actual result instead of assuming errors are tolerated.

## Testing & QA
- Read `docs/ENGINEERING_QUALITY_GUARDRAILS.md` before adding or restructuring tests.
- No Jest/Vitest framework; tests are executable Node scripts using `node:assert`.
- Tests use real temporary SQLite databases and, where appropriate, real PTY harness behavior.
- `npm test` is the canonical root regression suite and currently covers lifecycle, persistence, concurrency, replay, direct worker interaction, approvals/capabilities, tools, canvas behavior, context delivery/scopes, product-runtime v0.2 behavior, HTTP/server surfaces, and specialized harnesses.
- Web changes should also pass `cd web && npx tsc -b && npm run build`.
- CI exists, but a new PR must not be described as green until checks actually report success.
- Keep tests deterministic and cleanup in `try/finally`; avoid `process.exit()` in shared regression paths.
- Prefer behavior, scenario, and runtime-invariant tests over implementation-shape assertions.
- Do not add source-text or regex assertions to prove ordinary UI/product behavior. Existing source-regex UI suites are legacy debt and should not be expanded. Static source checks are acceptable only for true static architecture rules that cannot be expressed behaviorally.
- Before creating a new test file, check whether the scenario belongs in an existing domain suite. Test organization should follow durable product/runtime boundaries, not issue history.
- Coverage percentage and test count are not goals by themselves. Prefer fewer high-signal assertions over fragmented low-signal coverage.

## Known Operational Constraints
- `src/orchestrator/orchestrator.ts:#consumeSession` must forward every `exit`/`crash` event to `Scheduler.handleSessionEvent`; do not skip terminal events merely because the Task already appears terminal.
- Windows `EBUSY` cleanup and historical winpty handle leakage are documented in `handoff.md`; treat them as platform-specific evidence and re-test before changing cleanup semantics.
- Windows-only PTY settings such as `useConpty:false` must not leak into Linux/macOS behavior.
- Never broadly kill Node processes. Cleanup may terminate only exact child PIDs owned by Chef/harness code.

## Autonomous / AI Assistant Verification
Before implementing unattended work:
1. Read current `master`, recent commits, open PRs, relevant docs, and `docs/ENGINEERING_QUALITY_GUARDRAILS.md`.
2. Verify negative claims directly in the repository.
3. Avoid overlapping files/semantics with active PRs unless the task is explicitly a follow-up.
4. Prefer one bounded change with an explicit acceptance criterion.
5. Run relevant tests/build/typecheck and report only evidence actually observed.
6. Review every new or changed test for behavioral value: it should fail for a real product/runtime regression, not a harmless refactor.
7. Review comments for durable rationale. Remove comments that only narrate code or patch history.
8. Review the final diff from a critic perspective for runtime-authority violations, duplicated sources of truth, lifecycle regressions, speculative architecture, scope creep, brittle tests, or comment noise.
9. If no clear safe task exists, no-op rather than inventing work.