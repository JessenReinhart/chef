# Simple Mode Standard Flows

**Status:** active product invariant / implementation plan  
**Applies to:** Chef UI, Threads, Missions, issue recovery, history, approvals, artifacts, and standard project work  
**Relationship:** `CONVERSATION_THREADS_V1.md`, `MISSION_EXECUTION_ROUTING_V1.md`

## Product invariant

**Simple Mode must support every normal end-to-end Chef workflow.**

Power Mode is not a gateway to missing functionality. It is an expert lens that adds runtime internals, low-level controls, diagnostics, and configuration.

The user should never have to switch to Power Mode merely to:

- continue an earlier conversation;
- open another Thread;
- see what Chef is currently doing;
- inspect why normal work failed;
- retry or redirect failed work;
- answer an approval;
- review the result of a Mission;
- see relevant files/artifacts;
- see a human-readable activity/history summary;
- inspect the current worker at a useful product level;
- recover from a standard issue;
- perform ordinary project work.

If a standard flow requires Power Mode, treat that as a Simple Mode UX bug.

## Mental model

The two modes expose the **same authoritative runtime**, at different abstraction levels.

```text
                    same Chef runtime
                           │
             ┌─────────────┴─────────────┐
             │                           │
        Simple Mode                 Power Mode
        product language            runtime language
        intent + outcome             tasks + sessions
        useful progress              raw event history
        failure + recovery           IDs / harness / PID
        Thread history               context refs
        files/results                permissions / usage
        standard controls            direct intervention
```

Changing mode must never create a different Mission, Task, Thread, Session, or canvas state.

## Simple Mode should answer five questions

For any selected Thread / Mission / work item, Simple Mode should make these obvious:

1. **What are we working on?**
2. **What is Chef doing now?**
3. **What happened so far?**
4. **Is anything wrong or waiting for me?**
5. **What can I do next?**

A user should not need to understand Task IDs, Session IDs, harness names, event sequence numbers, context refs, or PTY lifecycle to answer those questions.

## Power Mode purpose

Power Mode exists for users who intentionally want implementation/runtime detail, such as:

- exact Task / Mission / Session IDs;
- harness identity and process state;
- raw event timeline;
- raw context references;
- permissions/capability policy;
- token/cost metadata;
- direct worker intervention;
- terminal/process controls;
- detailed node/edge semantics;
- advanced routing/configuration;
- debugging and forensic inspection.

Power Mode may expose more controls. It must not be required for normal recovery.

## Standard issue/recovery flow

When something fails in Simple Mode, do not show only a red badge that forces the user into Power Mode.

Target interaction:

```text
Mission needs attention

Implement authentication
Codex stopped while running tests.

Last useful activity:
"3 tests failed in auth.test.ts"

[Retry] [Ask Chef to fix it] [View details]
```

`View details` may expand a Simple Mode-friendly timeline:

```text
21:14  Started implementation
21:16  Updated auth service
21:18  Ran tests
21:18  3 tests failed
21:19  Worker stopped
```

Power Mode can show the forensic equivalent:

```text
task:f34...
session:a91...
harness:codex
exitCode:1
seq:812 session.data
seq:813 session.crash
contextRefs: ...
```

The first view is a standard product flow. The second is diagnostics.

## Thread/history behavior

Conversation Threads are a Simple Mode primitive, not a Power Mode feature.

Simple Mode must support:

```text
Project
├── Thread A
├── Thread B
└── Thread C
```

Within a Thread the user can:

- review previous conversation turns;
- see Missions created from that Thread;
- continue the discussion;
- inspect prior outcomes;
- recover from failed work;
- start another related Mission.

Power Mode may add raw Mission/Task/Session lineage to the same Thread.

## Canvas behavior

Simple Mode should keep the living workspace understandable without requiring the user to operate it like a node debugger.

Simple Mode:

- human names;
- useful relationships;
- live status;
- normal actions;
- concise failure/recovery state;
- selected Thread/Mission focus.

Power Mode:

- exact node types;
- edge relationship semantics;
- harness IDs;
- runtime ownership;
- context/permission inspection;
- low-level process controls.

The canvas remains the same underlying graph in both modes.

## Current known violations

Current UI already shares the same runtime between modes, which is correct, but some useful inspection is still Power-only.

Examples to repair:

- the full selected-node Runtime Inspector is rendered only when `mode === "power"`;
- event history is inside that Power-only inspector;
- ownership/session/context/usage details are mixed together in one Power-only panel instead of separating useful product status from expert diagnostics;
- pending/failed/completed header counts are Power-only even though failure visibility is relevant to normal work.

Approvals are already presented outside the Power-only inspector and are a good example of the intended rule: the normal action is available directly, while implementation detail can remain hidden.

## TODO

### Phase 0 — Freeze product semantics

- [x] Define Simple Mode as complete for standard workflows.
- [x] Define Power Mode as an expert/diagnostic lens over the same runtime.
- [ ] Add UI acceptance coverage that normal failure recovery does not require switching modes.
- [ ] Add UI acceptance coverage that Thread/history navigation works entirely in Simple Mode.

### Phase 1 — Simple work detail surface

- [ ] Add a Simple Mode work/Mission detail surface for the selected item.
- [ ] Show human-readable current activity.
- [ ] Show concise recent history.
- [ ] Show relevant failure reason / blocker.
- [ ] Show normal recovery actions: retry, redirect/ask Chef, approve/reject where applicable.
- [ ] Show relevant output/artifacts.
- [ ] Keep raw IDs, PID, harness internals, context refs, and raw event types out of the default view.

### Phase 2 — Thread integration

- [ ] Add Thread navigation to Simple Mode.
- [ ] Show selected Thread conversation and Mission history.
- [ ] Let the user continue previous work without Power Mode.
- [ ] Surface failed/blocked Mission state in the Thread itself.
- [ ] Make previous outputs/results discoverable from the Thread.

### Phase 3 — Progressive disclosure

- [ ] Add `View details` / expandable technical detail from Simple Mode where useful.
- [ ] Keep the first level human-readable.
- [ ] Let Power Mode open directly to the corresponding detailed runtime object when requested.
- [ ] Do not duplicate authoritative data between Simple and Power components.

### Phase 4 — Status and recovery

- [ ] Make failed/blocked/waiting-for-approval state visible in Simple Mode.
- [ ] Replace Power-only status counts with useful Simple Mode signals where they affect the user.
- [ ] Present worker failure as an actionable product event, not just `session.crash`.
- [ ] Provide last useful output in bounded/human-readable form.
- [ ] Distinguish Mission failure, Task failure, worker crash, cancellation, and approval wait without exposing unnecessary runtime vocabulary.

### Phase 5 — Verification

- [ ] Standard flow: create Thread → request work → observe progress → inspect result, entirely in Simple Mode.
- [ ] Recovery flow: Mission fails → inspect reason → retry/fix, entirely in Simple Mode.
- [ ] Continuity flow: reopen old Thread → read prior work → ask follow-up, entirely in Simple Mode.
- [ ] Approval flow: Mission waits → user resolves approval, entirely in Simple Mode.
- [ ] Artifact flow: completed Mission → user finds relevant output, entirely in Simple Mode.
- [ ] Switching Simple ↔ Power preserves selection and runtime state.
- [ ] Power Mode still exposes the advanced runtime diagnostics after Simple surfaces are added.

## Acceptance criteria

This invariant is satisfied when:

1. A non-technical user can complete all standard Chef flows without entering Power Mode.
2. Failures and blockers are inspectable and recoverable in Simple Mode.
3. Thread/history continuity is a normal Simple Mode workflow.
4. Power Mode adds depth rather than unlocking basic capability.
5. Both modes are projections of the same durable runtime state.
6. Low-level runtime vocabulary is progressively disclosed instead of being required for ordinary operation.
