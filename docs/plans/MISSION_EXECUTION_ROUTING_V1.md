# Mission Execution Routing V1

**Status:** active implementation plan  
**Product sources:** `docs/PRODUCT_BIBLE.md`, `docs/PRODUCT_RUNTIME_SPEC_V0.2.md`  
**Branch / PR:** `fix/llm-openai-response-debugging` / #92

## Goal

Repair the Mission execution path so a user goal becomes an executable, observable plan that is delegated to real Chef workers instead of conflating node types, agent identities, and harness IDs.

The product rule remains:

> **Human intent → Mission → Orchestrator → live agents/tools → shared context → artifacts/decisions → verified outcome.**

And the runtime rule remains:

> **LLMs decide; the runtime validates and executes.**

This plan is intentionally runtime-first. It does not redesign the whole canvas or replace the existing Node Execution Engine.

## Current failure mode

The current chat Mission path has three semantic collisions:

1. The LLM planner receives node-registry types such as `agent.llm`, `tool.terminal`, and `tool.file`.
2. `PlanTask.assignedTo` is then validated against that node registry, so the value behaves like a node type even though the domain contract says it is an `AgentId`.
3. During execution the same `assignedTo` value is treated as a real worker identity / harness lookup key.

For an LLM-generated task this can become:

```text
assignedTo = "agent.llm"
        ↓
Orchestrator treats "agent.llm" as an AgentId
        ↓
no registered harness with that identity
        ↓
fallback GenericTerminalHarness(command = "node")
        ↓
bare Node REPL starts without the task instruction
        ↓
Mission waits until the global 60 s execution timeout
```

The current Simple Mode message also reports `taskCount` as "teammates", even though one task is not necessarily one spawned worker and scheduler concurrency is currently one.

## Target mental model

Keep these concepts separate:

| Concept | Meaning | Example |
| --- | --- | --- |
| `nodeType` | Kind of work / runtime capability | `agent.llm`, `tool.terminal`, `tool.browser` |
| `assignedTo` | Logical worker identity that owns a Task | `codex`, `claude-code`, future `frontend-agent` |
| harness | Process adapter backing an agent identity | Codex CLI adapter, Claude Code adapter |
| Session | One execution instance | PTY process for one Task |

V1 uses the existing built-in harness IDs (`codex`, `claude-code`, `aider`, `pi`, `omp`, `freebuff`) as built-in logical agent identities. Persistent user-defined agent profiles can later map a friendly AgentId to a preferred harness without changing the Task contract again.

## V1 scope decision

Mission planning V1 will only auto-dispatch task kinds that have a proven Mission execution path.

For this repair, that means:

- `agent.llm` tasks may be delegated to an available task-capable AI harness;
- approval remains a gate (`approvalId`) on a Task;
- generic terminal is **not** an AI-agent fallback;
- direct `tool.*` Mission tasks are not silently routed through a PTY until their Node Execution Engine bridge has an explicit input/config contract.

The existing Node Registry / Node Execution Engine remains authoritative for typed node execution and Automation-style graphs. This plan fixes the Mission-to-worker path without pretending those two execution models are already fully unified.

## Intended flow

```text
User goal
  ↓
POST /api/chat
  ↓
Orchestrator creates Mission(status=planning)
  ↓
Planner receives:
  - user goal
  - context references
  - execution-capable Mission task types
  - currently available task-capable workers
  ↓
Planner returns PlanTask[]
  - nodeType describes the work kind
  - assignedTo identifies the selected worker, when explicit
  ↓
Runtime validates plan
  - known nodeType
  - executable Mission task kind
  - assigned worker exists and is task-capable
  - dependencies are valid
  ↓
Mission becomes active
  ↓
Plan is projected to the canvas before execution starts
  ↓
For each dependency-ready Task:
  - choose explicit worker or deterministic available worker
  - persist Task ownership
  - spawn worker in task mode
  - deliver the Task instruction + bounded context
  - stream meaningful lifecycle/output events
  ↓
worker exits / reports terminal result
  ↓
Scheduler persists terminal state
  ↓
Orchestrator evaluates, advances dependencies, verifies, reports
```

## Execution contract

A worker that is auto-selected for a Mission must be **task-capable**, not merely detectable.

A task-capable harness must be able to answer:

1. Can this adapter execute one bounded Task non-interactively?
2. How is the Task prompt passed to the CLI?
3. Does the CLI terminate when that Task is complete?
4. What command/args will be persisted on the Session record?

Interactive-only harnesses may still exist in the living workspace and be opened directly. They must not be auto-routed for a Mission until they implement the task execution contract.

No silent `node` / shell fallback is allowed for an AI task.

## Timeout semantics

Keep timeouts separated by responsibility:

- **LLM proposal timeout:** bounds one provider request. Existing default: 60 s.
- **Task/session timeout:** optional worker-specific execution safety bound, if configured.
- **Mission timeout:** must not default to the same 60 s provider timeout. Missions are long-running work and should be cancellation-driven by default, with an optional explicit overall deadline.

The timeout regression test must continue to support a deliberately short configured Mission timeout so cancellation teardown remains tested.

## Observability

`CHEF_LLM_DEBUG=1` remains provider-transport debugging.

Add runtime execution diagnostics behind `CHEF_RUNTIME_DEBUG=1` (or one equivalent explicit switch) for:

```text
[chef:runtime] plan.proposed plan=<id> tasks=4
[chef:runtime] task.routed task=<id> nodeType=agent.llm worker=codex
[chef:runtime] session.spawn task=<id> worker=codex command=codex args=[exec,...]
[chef:runtime] session.exit task=<id> worker=codex code=0 durationMs=...
[chef:runtime] task.completed task=<id>
```

On failure, include the Task/Session/worker IDs, exit code, and a bounded last-output preview. Do not log API keys, provider secrets, full environment maps, or unbounded transcripts.

## TODO

### Phase 0 — Freeze the contract in tests/docs

- [x] Document current failure and target semantics in this plan.
- [ ] Add regression coverage proving `nodeType` and `assignedTo` are independent concepts.
- [ ] Add a regression proving an unknown/non-task-capable assignee fails closed instead of spawning bare `node`.

### Phase 1 — Separate planning semantics

- [ ] Add `nodeType` to `PlanTask`.
- [ ] Update LLM Plan JSON/schema parsing so `nodeType` is validated against the runtime node registry.
- [ ] Stop validating `assignedTo` against the node registry.
- [ ] Give the planner the actual available task-capable worker IDs.
- [ ] If `assignedTo` is omitted for `agent.llm`, route deterministically to an available task-capable worker.
- [ ] Reject a plan before execution when no suitable worker exists.

### Phase 2 — Task-capable harness execution

- [ ] Add an explicit task-execution capability/contract to specialized harness adapters.
- [ ] Implement and test task-mode command construction for adapters whose CLI contract is known and bounded.
- [ ] Spawn a Mission worker with the Task instruction, not an empty interactive process.
- [ ] Persist the actual command/args used by the Session.
- [ ] Remove the `GenericTerminalHarness(command="node")` AI-worker fallback.
- [ ] Keep interactive-only harnesses available for direct workspace use but exclude them from automatic Mission routing.

### Phase 3 — Mission lifecycle and timeout repair

- [ ] Remove the unconditional 60 s default timeout around an entire Mission execution.
- [ ] Preserve an explicit configurable Mission timeout for tests / user policy.
- [ ] Ensure timeout/cancel teardown terminates only owned Sessions and leaves durable Task/Mission history coherent.
- [ ] Distinguish timeout-driven termination from a spontaneous worker crash in runtime diagnostics and user-facing reports.

### Phase 4 — Realtime projection and truthful UI wording

- [ ] Materialize/project the accepted plan to the canvas before worker execution starts.
- [ ] Let live Task/Session events update those nodes while the Mission runs.
- [ ] Stop describing `taskCount` as teammate count.
- [ ] Show worker identity only when a real worker was assigned.

### Phase 5 — Debugging and verification

- [ ] Add opt-in runtime routing/session diagnostics with bounded output previews.
- [ ] Add end-to-end regression: user goal → LLM plan → real task-capable test harness → Task completion → Mission completion.
- [ ] Keep provider parsing regressions from PR #92 green.
- [ ] Run root `npm test`.
- [ ] Run root `npm run typecheck`.
- [ ] Run web TypeScript build / `npm run web:build` for UI changes.
- [ ] Review final diff for runtime-authority, lifecycle ownership, and silent fallback regressions.

## Acceptance criteria

V1 is complete when:

1. A configured LLM can propose an `agent.llm` Mission task without using `assignedTo` as a node type.
2. The planner can see which task-capable workers are actually available.
3. An explicit invalid worker assignment is rejected before a process is spawned.
4. An omitted worker assignment resolves deterministically to a real task-capable worker or fails clearly when none exists.
5. The spawned worker receives the Task instruction and has a bounded completion contract.
6. No Mission AI task silently falls back to bare Node or a generic shell.
7. A normal Mission is not killed merely because it runs longer than 60 seconds.
8. Explicit timeout/cancellation still tears down owned PTYs and persists coherent terminal state.
9. The canvas/progress surface does not claim N tasks means N teammates.
10. Debug logs can explain planner → router → worker → Session → terminal state without exposing secrets.

## Deferred follow-up

The following are deliberately outside this repair and should remain separate work unless implementation proves they are required:

- persistent user-defined agent profiles mapping AgentId → preferred harness/model/tools;
- model/cost-aware worker routing;
- automatic load balancing across multiple equivalent workers;
- direct Mission routing for every `tool.*` node through `NodeExecutionEngine`;
- full unification of Mission plans and Automation execution graphs;
- multi-session concurrency per persistent agent identity;
- agent cloning/team templates;
- advanced verification/replanning policy.
