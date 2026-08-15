# Chef AI Engineering OS — Handoff

## Goal

Build **Chef AI Engineering OS** — a local-first visual AI engineering workspace.

Architecture: Human/CTO → Orchestrator/Squad Lead → multiple AI agents → native terminal harnesses.

- Runtime is authoritative; UI/canvas is a projection only.
- Orchestrator is the primary human interface.
- Terminal I/O (PTY stdout) and structured messaging/events (sideband) are separate channels, never mixed.
- SQLite local-first persistence (`node:sqlite` `DatabaseSync` sync API); no migrations.
- TypeScript native stripping (`--experimental-strip-types`); no enums, namespaces, or parameter properties.
- Restart survival: state survives process restart, artifacts persist, context refs preserved.
- Live observability, eventual node canvas.

## Project

- **Repo root**: `C:/Users/LGSM228/chef`
- **Node**: v24.11.1 (`--experimental-strip-types`)
- **Platform**: Windows 11, winpty backend (`useConpty: false`)
- **GitHub**: `JessenReinhart/chef` (private)

## Architecture (current)

```
src/
  main.ts                          — createChef() wiring, ChefRuntime interface
  core/types.ts                    — domain types (TaskId, WorkspaceId, etc.)
  context/                         — context reference system
  persistence/
    database.ts                    — Repository (SQLite CRUD, transactions)
    schema.sql                     — schema (idempotent CREATE TABLE IF NOT EXISTS)
  runtime/
    scheduler.ts                   — Scheduler (dispatch, handleSessionEvent, retry)
  orchestrator/
    orchestrator.ts                — Orchestrator (handleUserMessage, executePlan, consumeSessions)
                                    — ScriptedDecisionProvider (investigator + verifier scripts)
  harness/
    generic.ts                     — GenericTerminalHarness (node-pty adapter)
    sideband.ts                    — SidebandDirectory (inbox/outbox file-based messaging)
tests/
  golden-path.ts                   — P0 golden path test
```

- ✅ Golden path runs: user message → orchestrator plans (2 tasks: investigator + verifier) → scheduler dispatches → PTY sessions spawn → structured sideband events and PTY data events delivered → artifacts and replay events persisted → tasks complete.
- ✅ Close/reopen cycle: workspace, plans, tasks, events, artifacts, sessions, and messages all survive restart.
- ✅ `sendUserMessage` promise settles reliably (was flaky exit-13, now fixed — see below).
- ✅ `diag-handles.mjs` runs clean in the current Linux verification environment.
- ✅ No `process.exit()` in golden path (diag uses `process.exit(0)` in finally for handle dump).
- ✅ Concurrent dispatch is guarded atomically by live session count; plan timeout/cancellation and terminal-task cancellation are covered by regressions.
- ✅ `ChefRuntime.subscribeEvents` provides a failure-isolated live projection stream.

### Bug 1 fix (applied): exit events always reach the scheduler
The exit-skip in `#consumeSession` was removed; every non-aborted event is forwarded to `scheduler.handleSessionEvent`, whose exit/crash branch claims the session with a status CAS. Sessions no longer stick `running`.

### Dispatch hardening (applied)
`#dispatchOne` re-reads the task inside its transaction, aborts on terminal/capacity-full states, and enforces `maxConcurrency` via `countLiveSessions`; it returns the inserted `Session` directly instead of a `listSessions().findLast` lookup. `dispatchPending` loops until capacity or no runnable tasks.

### Durable plans, PTY replay, and live events (applied)
Plans persist in a `plans` table and appear in `WorkspaceSnapshot.plans`; PTY output persists as ordered `session.data` runtime events; `ChefRuntime.subscribeEvents` streams persisted events with failure isolation.

### Bug 1: Sessions stuck "running" in DB (ROOT CAUSE IDENTIFIED)

**Location**: `src/orchestrator/orchestrator.ts:404-411` (`#consumeSession`)

**Problem**: The exit/crash event skip logic:
```ts
if (event.type === "exit" || event.type === "crash") {
  const task = this.#repository.getTask(taskId);
  if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "blocked")) continue;
}
await this.#runtime.handleSessionEvent(workspaceId, sessionId, event);
```

The structured event completes the task BEFORE the exit event arrives. When the exit event comes, the task is already "completed", so `continue` skips `handleSessionEvent`. The scheduler's `handleSessionEvent` exit branch (scheduler.ts:308-345) is the ONLY place session status gets updated to "completed"/"crashed" in DB. So sessions stay "running" forever.

**Impact**:
- `golden-path.ts` assertion `snapshot.sessions.some(s => s.status === "completed")` fails.
- On reopen, `recoverOnStartup` sees "running" tasks → marks them "blocked" → appends `task.blocked` events → event count mismatch (16 ≠ 14) → reopen assertions fail.

**Fix**: Remove the exit-skip in `#consumeSession`. The scheduler's `handleSessionEvent` is already idempotent for tasks (`if (task.status !== "running") return;` at scheduler.ts:317), but it ALWAYS updates session status (scheduler.ts:310-314 runs before the task guard). So the skip is harmful — it prevents session status updates.

```ts
// REMOVE lines 406-409 in orchestrator.ts #consumeSession:
// if (event.type === "exit" || event.type === "crash") {
//   const task = this.#repository.getTask(taskId);
//   if (task && (task.status === "completed" || ...)) continue;
// }
// Just pass ALL events to handleSessionEvent:
for await (const event of stream) {
  if (event.type === "data") continue;
  await this.#runtime.handleSessionEvent(workspaceId, sessionId, event);
}
```

### Bug 2: EBUSY on `rm(projectDir)` after close (DEPENDS ON BUG 1)

**Error**: `EBUSY: resource busy or locked, unlink '...\chef.sqlite'` (errno -4082)

**Status**: Likely a cascade from Bug 1. Sessions stuck "running" → `recoverOnStartup` on reopen writes to DB → close/reopen cycle leaves something holding the DB file. The `rm` in the `finally` block of `golden-path.ts` fails 6/6.

**Evidence**:
- `DatabaseSync.close()` releases the file in isolation (tested — unlink OK after close).
- `golden-debug2.mjs` (same close→reopen→close→rm flow but with `process.exit(0)`) passes 6/6.
- `golden-path.ts` (natural exit, `finally` block rm) fails 6/6.
- Adding 300ms delay before rm does NOT help.
- Handle dump before rm shows identical handles (2 Socket + 1 MessagePort + 1 Socket) in both passing and failing runs.

**Hypothesis**: Fix Bug 1 first (sessions reach terminal state), then retest EBUSY. If it persists, investigate whether `recoverOnStartup`'s transaction or the scheduler's `#sessions` Map retains a reference to the DB through an unclosed prepared statement.

### Bug 3: Handle leak after close (4 handles persist)

**Handles**: 2 Socket (Pipe, `_isStdio=true`) + 1 MessagePort + 1 Socket (null handle)

**Source**: winpty backend's `_inSocket`/`_outSocket` and ConoutConnection worker thread. The `#destroyAgentResources` method in `generic.ts` tries to destroy these, but:
- The 2 `_isStdio=true` sockets are likely node-pty's internal IPC pipes for the winpty agent process — these may be stdio pipes of the winpty agent itself, not directly destroyable.
- The MessagePort is the ConoutConnection worker — `terminateConoutWorker` calls `worker.terminate()` but the MessagePort handle may linger.

**Status**: Non-blocking for now (process exits anyway), but causes the EBUSY cascade. ChatGPT's strategic note: consider whether Chef should continue forcing winpty at all — modern node-pty has moved away from it; treat as temporary compatibility backend.

## Fixes Already Applied

### `src/harness/generic.ts` (current state):

1. **`#endedQueues` map** — finished session queues stay readable. When `#finish()` runs (PTY exits), it moves the queue from `#sessions` to `#endedQueues`. The `events()` method checks both. This fixes the race where the orchestrator's `#consumeSession` calls `harness.events(sessionId)` AFTER `#finish()` already deleted the session from `#sessions` — previously threw "No active session", now returns the closed queue (which iterates to done, delivering the buffered exit event).

2. **`terminateConoutWorker`** — sets `conout._isDisposed = true` before clearing `_drainTimeout` and terminating `_worker`. Prevents a deferred `dispose()` from arming a fresh non-unref'd drain timer.

3. **`#destroyAgentResources` `_isReady` fallback** — if `readField(pty, "_isReady") === false`, calls `agent.kill()` directly before socket teardown. WindowsTerminal.kill() defers to `_agent.kill()` until first `'data'` event; killed-not-ready sessions would never get real native kill (microsoft/node-pty#333).

4. **`close()` pushes terminal exit event** — `close()` bypasses `#finish()`, so it manually pushes `{ type: "exit", exitCode: ... }` before closing the queue. Without this, consumers parked in `for await (const e of events(id))` would see the iterator complete with no terminal event.

### `src/orchestrator/orchestrator.ts` (NOT YET FIXED):

- **`#consumeSession` exit-skip** — see Bug 1 above. This is the next fix to apply.

## Temp Files (safe to delete)

These were created during debugging and can be removed:
- `golden-debug.mjs`, `golden-debug2.mjs`
- `golden-path-debug.ts`, `golden-path-delay.ts`, `golden-path-dump.ts`, `golden-path-gc.ts`, `golden-path-trace.ts`
- `diag-handles.mjs` (keep if you want the diagnostic script)
- `test-out.txt`
- `scripts/db-repro.ts`, `scripts/smoke-orchestrator.ts`

## Constraints & Preferences

- Runtime is product; UI disposable. Orchestrator primary human interface.
- PTY stdout / structured sideband = separate channels, never mixed.
- `node:sqlite` `DatabaseSync` sync; no migration.
- TypeScript native stripping: no enums/namespaces/parameter properties.
- node-pty `^1.1.0`; Windows spawn `useConpty: false` (winpty backend). Pin exact node-pty version.
- Sideband default root `join(tmpdir(), "chef-sideband")`; dirs `<root>/<sessionId>/inbox/`, `outbox/`.
- Orchestrator constants: `DEFAULT_TIMEOUT_MS = 60_000`, `SLEEP_STEP_MS = 50`, `SESSION_ACTIVE_WAIT_MS = 1_000`. All orchestrator timers unref'd.
- No `process.exit()` in golden path. No broad Node kill; only exact owned child PIDs.
- Project rules:
  - `ts-no-inline-cast-access`: no inline object cast for property read. Use named const cast with one-line reason, or `in`/`typeof` guard.
  - `ts-no-return-type`: no `ReturnType<typeof fn>` contracts; export named types at owning module.

## Next Steps

1. **Fix Bug 1**: Remove exit-skip in `#consumeSession` (orchestrator.ts:406-409). Pass all non-data events to `handleSessionEvent`.
2. **Retest Bug 2**: Run `golden-path.ts` 6× after Bug 1 fix. If EBUSY persists, investigate DB handle retention.
3. **Investigate Bug 3**: If EBUSY persists after Bug 1+2, add a bounded wait in `close()` for actual process termination, or retry `rm` with backoff.
4. **Clean up temp files** listed above.
5. **Audit**: full `scheduler.ts` read, all `DatabaseSync` open/close paths, `spawn`/`Worker`/`MessagePort`/`setInterval`/`setTimeout` audit, README run instructions, extract demo agents to `examples/`.
6. **Strategic**: Evaluate whether to keep winpty or switch to ConPTY / native spawn. ChatGPT recommends treating winpty as temporary.

## Key Files to Read First

| File | Purpose | Lines |
|------|---------|-------|
| `src/harness/generic.ts` | PTY adapter, teardown, ended-queue fix | 488 |
| `src/orchestrator/orchestrator.ts` | Plan/execute/consume, Bug 1 location | 597 |
| `src/runtime/scheduler.ts` | Dispatch, handleSessionEvent, retry | 460 |
| `src/persistence/database.ts` | Repository, SQLite CRUD | 949 |
| `src/main.ts` | createChef wiring, close() | 149 |
| `tests/golden-path.ts` | P0 golden path test | 67 |

## External Reviews Summary

Two external reviews (ChatGPT + Claude) were consulted:

**ChatGPT**:
- `#finish()` reentrancy: guard checks session in map; delete happens after cleanup → duplicate finalization possible. Wants explicit `finished` flag.
- `close()` mostly correct but no wait for termination.
- `forget()` orphans PTYs (current usage safe — terminate before forget).
- Winpty private cleanup = compatibility workaround; isolate behind version-specific adapter.
- P0 = idempotent `#finish` + investigate unresolved `sendUserMessage`.
- Strategic: consider moving away from winpty entirely.

**Claude**:
- WindowsTerminal.kill() defers to `_agent.kill()` until `_isReady` — killed-before-ready child leak (node-pty#333). Fixed.
- `_drainTimeout` not unref'd by node-pty — clearing necessary. Fixed.
- `terminateConoutWorker` must set `_isDisposed = true` or later `dispose()` arms fresh timer. Fixed.
- `close()` bypassing `#finish()` meant NO terminal exit event → parked consumer never settles. Fixed.
- `#finish()` reentrancy: current `#sessions.has()` guard is safe (`_outSocket` 'close' fires once; `.destroy()` on destroyed socket is no-op). Divergence with ChatGPT — not yet resolved. Recommended: belt-and-braces `finished` flag on ActiveSession.
