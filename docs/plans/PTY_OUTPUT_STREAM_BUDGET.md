# PTY output stream budget

<!-- project-status:in-progress -->

This is the bounded implementation contract for #668. PTY output is a live product signal, but it must not turn every terminal chunk into an unbounded SQLite write or an equally high-volume SSE broadcast.

## Runtime contract

- Keep a short in-memory tail for terminal diagnostics.
- Coalesce adjacent PTY data chunks for a short wall-clock window instead of persisting every chunk independently.
- Flush immediately when the pending buffer reaches a byte budget.
- Flush pending output before a session reaches a terminal state or is cancelled, so useful final output is not lost.
- Persist each session.data payload under a hard UTF-8 byte ceiling.
- Preserve the existing session.data event type, task/session lineage, and ordered event stream. Consumers must not need a new protocol.
- A noisy worker may lose chunk-level timing fidelity, but it must retain recent output and terminal completion/crash semantics.

## Initial budget

The first implementation target is:

- **8 KiB maximum per persisted session.data payload**
- **100 ms coalescing window**
- flush on size threshold, exit/crash, and cancellation

These limits are deliberately small enough to bound SQLite rows and SSE bursts while remaining responsive for the Simple Mode heartbeat and Power Mode terminal view.

## Acceptance

A behavioral/runtime test should prove that:

1. normal terminal output is still replayable after restart;
2. output from one session keeps its task/session lineage;
3. no persisted session.data payload exceeds the byte ceiling, including multibyte UTF-8 output;
4. buffered output is flushed before exit/crash/cancellation state is finalized;
5. the existing canonical todo journey still observes worker progress and completion.

Do not replace this with source-text assertions. The useful proof is the persisted event stream produced by a real harness/session.

## Platform note

Windows PTY delivery can produce larger or differently chunked bursts than Linux. The budget is therefore expressed in bytes rather than assumed character count, and the flush behavior must not depend on a particular PTY chunk size.

<!-- project-status:ready -->