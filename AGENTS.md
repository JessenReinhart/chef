# Repository Guidelines

## Project Overview
Chef is the P0 implementation of the AI Engineering OS spec (`AI_Engineering_OS_Specification_v0.1.pdf`): a local-first, restart-safe multi-agent task runtime. It turns a user message into a dependency-aware plan, runs agent tasks through PTY harnesses, and persists sessions, events, artifacts, and messages in SQLite. Spec mantra: "The UI is disposable. The runtime is the product."

## Architecture & Data Flow
`src/main.ts` assembles the dependency-injected runtime:

1. `Orchestrator` records the user message, asks a `DecisionProvider` for a plan, creates dependency-batched tasks, and coordinates execution.
2. `Scheduler` finds runnable tasks, persists task/session transitions transactionally, dispatches work, handles structured events, retries, and startup recovery.
3. `GenericTerminalHarness` runs child processes through `node-pty`; terminal output and structured sideband JSON events remain separate.
4. `ContextManager` resolves durable references and materializes task inboxes.
5. `Repository` is the authoritative SQLite writer; event, task, session, artifact, and message state survives restart.

The default path uses `ScriptedDecisionProvider`; no server or UI is present. Async/await and `AsyncIterable` event queues dominate. Dependencies are passed through structural interfaces/registries. IDs use `randomUUID()` and timestamps use epoch milliseconds.

Spec boundaries: runtime owns lifecycle, scheduling, cancellation, retries, permissions, and persistence; harnesses own process/PTY behavior; context selects references; events are immutable history; artifacts are durable references. LLMs may propose structured decisions, but runtime APIs validate and execute them. UI/canvas is a projection, never the source of truth; MCP is a capability layer, not the orchestration protocol.

The intended loop is `human intent → Orchestrator → tasks → harnesses → shared context → artifacts → verification → human outcome`. Preserve this separation when adding modules.

## Key Directories
- `src/core/` — shared type contracts and ID/time helpers.
- `src/orchestrator/` — plan creation and end-to-end task execution.
- `src/runtime/` — scheduling, recovery, retries, and task-state transitions.
- `src/harness/` — PTY process lifecycle and sideband envelopes.
- `src/context/` — reference resolution and inbox materialization.
- `src/persistence/` — SQLite schema and `Repository` CRUD/transactions.
- `tests/` — golden path plus timeout, cancellation, and multi-connection event-sequence regressions.
- `scripts/` — manual smoke and SQLite-handle reproduction scripts.
- `AI_Engineering_OS_Specification_v0.1.pdf` — the authoritative product spec.

## Implementation Status (Spec Roadmap)
- **P0 (in place):** headless runtime (workspace, tasks, event bus, persistence, generic PTY harness, `ScriptedDecisionProvider` stand-in for a real agent), orchestrator loop, structured worker messages, artifact references, restart survival, timeout/cancellation teardown, atomic event sequencing, and CAS-protected lifecycle transitions.
- **P1 (partially in place):** bounded concurrent dispatch with atomic live-session capacity checks, retries, durable plan history, deterministic workspace snapshots, PTY transcript replay via `session.data` events, and live event subscription. Specialized harness adapters (Pi/OMP/Freebuff/Claude), direct user-to-worker interaction, and approval-gated execution remain.
- **P2+ (not yet):** visual canvas (XYFlow/React Flow), terminal nodes, context inspector, MCP/tools, approvals/permissions, replay-driven resume, and hierarchical squads.

## Spec Divergences
- Spec suggests Drizzle ORM; the code uses raw `node:sqlite` `DatabaseSync` with a hand-written `schema.sql` and no migrations.
- Spec defines `nodes`/`edges`/`workflows`/`approvals` tables; `schema.sql` has `workspaces`, `projects`, `agents`, `harnesses`, `sessions`, `tasks`, `task_dependencies`, `messages`, `events`, `artifacts`, `decisions`, and durable `plans` — no workflow-graph or approvals tables yet.
- `AgentMessage` (spec §7.1) includes `channel`, `replyTo`, and `contextRefs`; check the local `Message`/`AgentMessage` type before assuming parity.
- Spec `Task.status` includes `"blocked"`/`"cancelled"`; local `TaskMachine` `ALLOWED` transitions define the actual set — consult it before adding statuses.
- No UI/desktop/web app exists yet; spec UI choices (React/Vite, Zustand, Tauri) do not apply.

## Development Commands
```bash
npm install
npm start
npm test
node --experimental-strip-types scripts/smoke-orchestrator.ts
node --experimental-strip-types scripts/db-repro.ts
npm run typecheck
```

`npm start` runs `src/main.ts`; `npm test` runs the golden-path, timeout-cancellation, seq-concurrency, and cancel-facade regression tests. The README also references `node --experimental-strip-types diag-handles.mjs` (root diagnostic script, present).

## Code Conventions & Common Patterns
- ESM TypeScript executed directly by Node native type stripping; avoid enums, namespaces, and parameter properties.
- Prefer `async`/`await`, async event queues, private `#` fields, and small structural DI interfaces.
- Most operational failures throw. Orchestrator catches plan/execution failures; cleanup paths commonly swallow cleanup errors.
- Use `TaskMachine` and its `ALLOWED` transition table for task-state validation; do not mutate lifecycle state ad hoc.
- Persist authoritative mutations through `Repository` transactions. In-memory maps are indexes/session handles, not durable state.
- Sideband files use atomic temp-file-plus-rename writes and FIFO polling. Do not mix PTY stdout with structured sideband events.
- JSON columns are used for persisted structured values. Keep task dependencies relational through `task_dependencies`.

Lifecycle invariants:
- `Orchestrator.#withTimeout` aborts the plan controller; `#executePlan` always runs session cleanup in `finally`.
- Harness outbox polls are drained before queue/sideband teardown; `finishDrain` and `#closed` prevent late queue resurrection.
- Scheduler terminal events claim live sessions with a status CAS; cancellation re-reads task state, CASes task/session state, and appends the cancellation event in one transaction.
- Event sequence allocation is one atomic `INSERT ... SELECT MAX(seq)+1 ... RETURNING` statement; do not reintroduce separate `MAX` then `INSERT` calls.
- `Repository.getWorkspaceSnapshot` uses one read transaction and deterministic ID tie-breakers for task/session/decision ordering.
- Dispatch concurrency is enforced inside `#dispatchOne`'s transaction via `countLiveSessions`; `#dispatchOne` re-reads the task fresh and returns null (no-op) for already-terminal or capacity-full tasks. Do not reintroduce pre-dispatch snapshot counting or `listSessions().findLast` session lookup.
- Plans are durable SQLite records with serialized `PlanTask[]`/task IDs and are exposed in `WorkspaceSnapshot.plans`; lifecycle writes occur at proposal, execution, and final status. Keep this write-through path authoritative rather than relying on `Orchestrator.#activePlan`.
- PTY chunks are forwarded through the existing harness event channel and persisted as immutable `session.data` runtime events with `{ encoding: "utf8", data }` payloads. Keep these separate from structured sideband artifacts; replay reads events by `sessionId` and sequence.
- `ChefRuntime.subscribeEvents` delivers every persisted runtime event synchronously after append, for both scheduler and orchestrator sources; an unsubscribe function removes the listener. Wire new runtime surfaces through this seam rather than exposing the repository directly to clients.
- Existing duplicated contracts (`ContextReference`, `HarnessEvent`, `SessionStatus`) require care when changing imports or exported types.
- Inline property access on a cast is disallowed (`ts-no-inline-cast-access`): use a named const with a one-line reason, or an `in`/`typeof` guard.
- `ReturnType<typeof fn>` contracts are disallowed (`ts-no-return-type`): export named types at the owning module instead.

## Important Files
- `src/main.ts` — `createChef()` composition root and lifecycle API (`start`, message handling, state inspection, `close`).
- `src/orchestrator/orchestrator.ts` — `Orchestrator` and `ScriptedDecisionProvider`.
- `src/runtime/scheduler.ts` — dispatch, event handling, retries, and recovery.
- `src/runtime/task-machine.ts` — allowed task transitions.
- `src/harness/generic.ts` — PTY harness implementation.
- `src/harness/sideband.ts` — session inbox/outbox protocol.
- `src/context/context.ts` — durable context resolution/materialization.
- `src/persistence/database.ts` — `Repository`, snapshots, transactions, and event append.
- `src/persistence/schema.sql` — SQLite tables, foreign keys, and indexes.
- `handoff.md` — operational bug history and platform-specific constraints.
- `diag-handles.mjs` — handle-leak diagnostic script at repo root.

## Runtime/Tooling Preferences
- Required runtime: Node.js `>=24.0.0`; native TypeScript stripping is required.
- Package manager: npm (`package-lock.json`, lockfile version 3). No Bun lockfile, `tsconfig.json`, `.nvmrc`, or CI configuration is present.
- Dependencies include `node-pty` and `@anthropic-ai/sdk`; the default scripted path does not call an external LLM.
- Pin `node-pty` to an exact version; it ships native binaries and its winpty backend is a temporary compatibility layer pending ConPTY/native evaluation.
- SQLite uses Node's `node:sqlite` `DatabaseSync`; there are no migrations.
- Windows PTY runs require the documented `winpty`/`useConpty:false` handling. Sideband root is under `tmpdir()/chef-sideband`.
- `package.json`'s `typecheck` command ends with `|| true`; treat it as non-gating and inspect errors rather than assuming success.

## Testing & QA
- No Jest/Vitest framework. Tests are executable Node scripts using `node:assert`.
- `tests/golden-path.ts` is the P0 E2E check: create runtime, send a user message, assert tasks/events/artifacts/sessions, close, reopen, and verify durable counts/state.
- Tests use real temporary SQLite databases and real `node-pty` harnesses; cleanup runs in `try/finally`.
- `scripts/smoke-orchestrator.ts` exercises the real Repository/Scheduler/Orchestrator stack and prints snapshots.
- `scripts/db-repro.ts` isolates SQLite close/unlink behavior. Root debug files (`diag-handles.mjs`, `golden-*.ts/mjs`, `test-out.txt`) diagnose handle leaks and are not additional coverage.
- There is no coverage configuration or CI gate. Untested or lightly tested surfaces include individual persistence CRUD methods, scheduler transition/retry branches, sideband edge cases, context resolution variants, and external Anthropic integration.

## Known Operational Issues
- `src/orchestrator/orchestrator.ts:#consumeSession` must forward every `exit`/`crash` event to `Scheduler.handleSessionEvent`; never restore an exit/crash skip based on already-terminal task status. Scheduler updates session status before its idempotent task guard. See `handoff.md` Bug 1.
- Windows `EBUSY` cleanup and four persistent winpty handles are documented in `handoff.md` Bugs 2–3. Winpty handle leakage is non-blocking but may cascade into SQLite removal failures; retest after Bug 1 changes.
- Windows-only PTY settings (`useConpty:false`) do not apply on Linux/macOS; `generic.ts` selects the backend by platform.

## Safe Cleanup Rules
- `tests/golden-path.ts` must not call `process.exit()`; use `try/finally` cleanup and `process.exitCode` for failure reporting.
- Never broadly kill Node processes. Cleanup may terminate only exact child PIDs owned by the harness, then remove temporary directories with force enabled.
- Root `golden-debug*.mjs`, `golden-path-{debug,delay,dump,gc,trace}.ts`, `test-out.txt`, and `scripts/{db-repro,smoke-orchestrator}.ts` are debugging/manual artifacts; verify before deleting. Keep `diag-handles.mjs` if handle diagnostics are needed.
- Follow `handoff.md` for platform-specific cleanup and known-bug retesting; do not treat historical Windows observations as current Linux behavior.

## AI Assistant Verification
- Verify negative repository claims (for example, a supposedly absent file or config) directly with `find`/`read` before recording them in project guidance; parallel scans can disagree.
