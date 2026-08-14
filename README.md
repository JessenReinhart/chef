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
- **Terminal I/O and structured messaging are never mixed.** PTY bytes stream as `data` events; structured envelopes arrive via sideband outbox as `structured` events.
- **Restart survival** — state, artifacts, tasks, sessions, and messages persist across process restarts.
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
  orchestrator/            Orchestrator (plan, execute, consume) + scripted decision provider
  harness/                 GenericTerminalHarness (node-pty) + sideband messaging
tests/
  golden-path.ts           P0 golden path test
```

## Status

**Working:**
- Golden path end-to-end: user message → 2-agent plan → PTY dispatch → structured sideband delivery → artifact persistence → task completion.
- Close/reopen cycle: full state survives restart.
- Stable `sendUserMessage` resolution (flaky exit-13 fixed).

**Known issues:** see `handoff.md` — sessions stuck `running` in DB (exit-skip in `#consumeSession`), possible EBUSY on project-dir cleanup, winpty handle leak.

## Notes

- Windows: winpty backend (`useConpty: false`) — treat as a temporary compatibility layer.
- TypeScript native stripping: no enums, namespaces, or parameter properties.
- SQLite via `node:sqlite` `DatabaseSync` (sync, no migrations).
