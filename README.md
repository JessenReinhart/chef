# Chef AI Engineering OS

**Local-first visual AI engineering workspace.**

A human/CTO directs an Orchestrator/Squad Lead, which plans and dispatches work to multiple AI agents running in native terminal harnesses. The runtime is authoritative; the UI/canvas is a projection only.

## Architecture

```
Human / CTO
    │  natural-language instruction
    ▼
Orchestrator (Squad Lead)
    │  plan → tasks (investigator, verifier, …)
    ▼
Scheduler (runtime)
    │  dispatch, retry, lifecycle events
    ▼
Agent harnesses (node-pty, winpty on Windows)
    │  PTY stdout (terminal I/O)  ──────────── separate channel
    │  sideband inbox/outbox      ──────────── structured events
    ▼
Persistence (SQLite, local-first)
```

- **Runtime is the product** — the UI/canvas is disposable.
- **Terminal I/O and structured messaging are never mixed.** PTY bytes remain a separate harness channel; structured envelopes arrive via sideband outbox. Runtime lifecycle/events remain durable in SQLite.
- **Restart survival** — state, artifacts, tasks, sessions, plans, and messages persist across process restarts.
- **Atomic dispatch** — scheduler concurrency is enforced in the dispatch transaction, so concurrent callers cannot oversubscribe live sessions.
- **Human approvals & live observability** land on top of the same runtime.

## Quick Start

Requires Node.js ≥ 24 (uses `node:sqlite` and native TypeScript type stripping).

```bash
npm install
# Golden path: user message → plan → dispatch → PTY agents → artifacts → close/reopen
node --experimental-strip-types tests/golden-path.ts
# Handle-leak diagnostic
node --experimental-strip-types diag-handles.mjs
```

## Project Layout

```
src/
  main.ts                  createChef() wiring, ChefRuntime interface
  core/types.ts            domain types
  context/                 context reference system
  persistence/             Repository (SQLite) + schema
  runtime/                 Scheduler (dispatch, events, retry)
  server/http-server.ts   read-only HTTP/SSE projection API
  server/index.ts         inspector server entrypoint
tests/
  golden-path.ts           P0 golden path test
  timeout-cancellation.ts  plan timeout teardown
  seq-concurrency.ts       atomic event sequences
  cancel-facade.ts         terminal-task cancellation guard
  dispatch-concurrency.ts  maxConcurrency under concurrent dispatch
  plan-persistence.ts      plan close/reopen durability
  pty-replay.ts            PTY output replay
  live-events.ts           live event subscription
  direct-worker-interaction.ts  send/interrupt/resize regression
  http-server.ts           projection API smoke test
web/
  src/App.tsx              read-only dashboard (tasks, sessions, event stream)
```

## Inspector & Dashboard

```bash
npm run server          # projection API on http://127.0.0.1:4321
cd web && npm install && npm run dev   # dashboard proxying /api to the server
```

## Status

**Working:**
- Golden path end-to-end: user message → 2-agent plan → PTY dispatch → structured sideband delivery → artifact persistence → task completion.
- Close/reopen cycle: full task, session, artifact, message, event, and plan state survives restart.
- Concurrent dispatch respects `maxConcurrency`; timeout cancellation and terminal-task cancellation are regression-tested.
- PTY terminal output is persisted as ordered `session.data` events and survives restart.
- Live event subscription (`ChefRuntime.subscribeEvents`) delivers the persisted event stream with unsubscribe support.
- Direct worker controls (`sendInput`, `interruptSession`, `resizeSession`) persist `user.*` intervention events.
- HTTP/SSE projection API: `src/server/http-server.ts` exposes `/api/state`, `/api/events`, and session-control POST endpoints.
- Minimal React/Vite dashboard in `web/` consumes state and SSE events and displays tasks, sessions, and the live event stream.

**Known gaps:** canvas graph editing, approvals and permissions, workflows, MCP/tool adapters, and replay-driven resume are not implemented yet. See `handoff.md` and `AGENTS.md` for the evolving roadmap.

## Notes

- Windows: winpty backend (`useConpty: false`) — treat as a temporary compatibility layer.
- TypeScript native stripping: no enums, namespaces, or parameter properties.
- SQLite via `node:sqlite` `DatabaseSync` (sync, no migrations).
