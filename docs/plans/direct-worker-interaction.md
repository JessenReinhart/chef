# Direct Worker Interaction

## Goal
Expose safe, runtime-authoritative controls for an active worker session: send terminal input, interrupt the process, and resize its PTY. Each human intervention is persisted as an immutable runtime event.

## API

`ChefRuntime` exposes:

- `sendInput(sessionId, data)`
- `interruptSession(sessionId)`
- `resizeSession(sessionId, cols, rows)`

`Scheduler` resolves the active session through its durable session index, calls the owning `HarnessLike`, then appends an event with source `{ type: "user", id: "ui" }`:

- `user.input`, payload `{ data }`
- `user.interrupt`, payload `{}`
- `user.resize`, payload `{ cols, rows }`

The runtime remains authoritative: UI callers cannot access harnesses directly, and event persistence occurs through `Repository.appendEvent` before live subscribers are notified.

## Test

`tests/direct-worker-interaction.ts` runs a real PTY session with a small `cat` process, waits until the scheduler has registered the session, sends a line through `ChefRuntime.sendInput`, verifies the PTY data contains that line, and verifies the persisted `user.input` event contains the same payload. It also exercises interrupt and resize through the public facade.

## Acceptance

- Scheduler's harness contract includes `send`, `interrupt`, and `resize`.
- Unknown/non-active session IDs fail without creating events.
- Input, interrupt, and resize events are visible through `inspectState()`/`listEvents` and `subscribeEvents`.
- Existing lifecycle, replay, and concurrency tests remain green.
