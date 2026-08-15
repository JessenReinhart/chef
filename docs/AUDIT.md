# Chef — Specification Audit

Audit of `AI_Engineering_OS_Specification_v0.1.pdf` against the current codebase. Status per requirement: **implemented** (verified by tests/usage), **partial** (works but incomplete), **deferred** (intentionally not shipped; future capability), **absent** (not started).

## Product Model (§1–3)

| Requirement | Status | Evidence |
|---|---|---|
| Human → Orchestrator → harnesses hierarchy | implemented | `Orchestrator` in `src/orchestrator/orchestrator.ts`; `createChef().sendUserMessage` |
| Workspace persistence | implemented | `workspaces` table; `Repository.getWorkspaceId/createWorkspace` |
| Agent logical identity | implemented | `agents` table, `AgentId` |
| Harness adapter abstraction | implemented | `Harness` interface; `GenericTerminalHarness`; Phase 8 specialized adapters |
| Session lifecycle | implemented | `sessions` table; spawn → running → completed/crashed/terminated |
| Task lifecycle | implemented | `TaskMachine` transitions; pending → assigned → running → completed/failed/cancelled/blocked |
| Artifact as first-class reference | implemented | `artifacts` table; provenance, version, URI |
| Immutable event log | implemented | `events` table, atomic seq allocation, replay |
| Structured messages | implemented | `messages` table; `AgentMessage` envelope |
| Context reference system | implemented | `ContextReference`; `ContextManager` resolution |
| Workflow graph serializable | implemented | `WorkflowGraph`, `buildPlanGraph`; Phase 1 `ExecutionGraph` |
| Node visual/runtime unit | implemented | `NodeDefinition` registry (9+ types) |

## Architecture Boundaries (§4)

| Requirement | Status | Evidence |
|---|---|---|
| UI is projection, not source of truth | implemented | `src/server/http-server.ts` read-only projection; web fetches `/api/state`, `/api/graph` |
| Runtime owns lifecycle/scheduling/permissions/persistence | implemented | `Scheduler`, `Repository`, `TaskMachine` |
| Harness layer owns PTY/process behavior | implemented | `GenericTerminalHarness`; sideband separation |
| Context layer selects references | implemented | `ContextManager` |
| Event layer immutable history | implemented | append-only `events`; live subscription |
| Artifact layer durable references | implemented | `artifacts` table + repo methods |
| LLM proposes; runtime validates/executes | implemented | `DecisionProvider` → `Orchestrator` → scheduler transitions |

## Runtime & Orchestrator (§5)

| Requirement | Status | Evidence |
|---|---|---|
| Orchestrator loop: understand → inspect → decompose → plan → assign → execute → observe → evaluate → verify → report | implemented | `Orchestrator.#executePlan`; scripted provider fallback |
| Deterministic runtime rule | implemented | decisions validated; runtime applies transitions |
| `handleUserMessage` contract | implemented | `ChefRuntime.sendUserMessage` |
| `inspectState` contract | implemented | `ChefRuntime.inspectState` → `WorkspaceSnapshot` |
| `proposePlan` contract | implemented | `DecisionProvider.proposePlan`; LLM provider in Phase 6 |
| `executePlan` contract | implemented | `Orchestrator` |
| `handleEvent` contract | implemented | `Scheduler.handleSessionEvent` |
| Retry policy | implemented | `Scheduler` retry budget; `retryTask` |
| Timeout/cancellation | implemented | `Orchestrator.#withTimeout`; `cancel-facade` test |

## Harness System (§6)

| Requirement | Status | Evidence |
|---|---|---|
| GenericTerminalHarness (mandatory P0) | implemented | `src/harness/generic.ts` |
| PTY semantics (stdin/out, resize, signals) | implemented | node-pty; send/resize/interrupt/terminate |
| Sideband communication separation | implemented | `sideband.ts`; FIFO polling; atomic rename |
| ClaudeCodeHarness | implemented | `src/harness/claude-code.ts` (Phase 8, detection + spawn) |
| PiHarness | implemented | `src/harness/pi.ts` |
| OMPHarness | implemented | `src/harness/omp.ts` |
| FreebuffHarness | implemented | `src/harness/freebuff.ts` |
| Future harnesses (Codex, Aider, custom) | partial | generic adapter covers arbitrary CLIs; specialized detection registry extensible |

## Communication & Events (§7)

| Requirement | Status | Evidence |
|---|---|---|
| Message envelope with type/channel/refs | implemented | `AgentMessage`; `messages` table |
| Event envelope (id, workspace, timestamp, source, type, payload) | implemented | `RuntimeEvent` |
| IRC-like channels | partial | `channel` field on messages; no channel subscription UI |
| Channel is projection; events are system of record | implemented | events table authoritative |

## Context System (§8)

| Requirement | Status | Evidence |
|---|---|---|
| Context hierarchy (global → workspace → project → workflow → task → agent → session) | partial | task/workspace refs supported; hierarchy not fully surfaced |
| Smallest useful context injection | implemented | `ContextManager` reference-based materialization |
| Context reference types | implemented | artifact/event/message/task/decision/file |
| Context adapter per harness | partial | inbox materialization; harness-specific injection not universal |

## Tasks, Workflows & Scheduling (§9)

| Requirement | Status | Evidence |
|---|---|---|
| Task model (title, status, assignedTo, deps, contextRefs, priority) | implemented | `Task` interface; `task_dependencies` table |
| Workflow graph with control/data/conditional/error/approval edges | implemented | Phase 1 `GraphEdgeSpec` kinds; `buildPlanGraph` |
| Only runnable tasks start | implemented | `#dispatchOne` dependency check |
| Concurrency limits | implemented | `countLiveSessions` atomic capacity check; `dispatch-concurrency` test |
| Cancellation propagates | implemented | `cancel-facade`, `timeout-cancellation` tests |
| Failed tasks retry per policy | implemented | `Scheduler` retry budget |
| Persist state before/after transitions | implemented | transactional `Repository` writes |
| Crash tolerance + resume | implemented | startup recovery; `plan-persistence` test |

## Artifacts & Decisions (§10)

| Requirement | Status | Evidence |
|---|---|---|
| Artifact model with version/provenance | implemented | `Artifact`; `artifacts` table |
| Reference over copy | implemented | context refs; URIs |
| Durable decisions | implemented | `decisions` table; `Decision` type |
| Project memory | partial | decisions stored; no long-term memory summarization |

## Permissions & Approvals (§11)

| Requirement | Status | Evidence |
|---|---|---|
| Capability model | implemented | `Capability` union; `capabilityRegistry` |
| Role defaults (engineer/orchestrator/human) | implemented | `ROLE_POLICIES` per spec §11.2 |
| Approval flow (request → human → approve/deny → resume/stop) | implemented | `approvals` table; `Scheduler.requestApproval/resolveApproval`; HTTP endpoints; Phase 8 tool gates |
| Approval-gated destructive ops | implemented | tool-runner `#withApproval`; tests |
| Fail-closed permission checks | implemented | `checkPermission` defaults deny |

## Visual Canvas (§12)

| Requirement | Status | Evidence |
|---|---|---|
| Canvas is projection | implemented | `buildPlanGraph` from snapshot |
| Node categories (agent/tool/control/workflow/human) | implemented | `NodeCategory` |
| Serializable workflow definition | implemented | `WorkflowGraph`/`ExecutionGraph` JSON |
| XYFlow/React Flow target | partial | current SVG canvas; React Flow is planned replacement (spec target, not yet shipped) |

## UX (§13)

| Requirement | Status | Evidence |
|---|---|---|
| Chat with Orchestrator (intent, not low-level) | implemented | Chat with Chef SSE; LLM decision provider |
| Plan/squad state/progress/blockers display | implemented | workbench; console timeline; approval queue |
| Direct worker interaction | implemented | terminal send/interrupt; `direct-worker-interaction` test |
| Squad state dashboard | implemented | `App.tsx` state strip; inspector |

## Tools, Browser, Git (§14)

| Requirement | Status | Evidence |
|---|---|---|
| MCP as capability layer, not orchestration | implemented | `mcp-client.ts` (Phase 8) |
| Browser sessions (Playwright) | implemented | `browser-tool.ts`; honest error without Playwright |
| Git operations | implemented | tool-runner git; scoped to repo root |
| Filesystem scoped | implemented | `validateFilePath` root scoping; out-of-root denial |
| Terminal deterministic execution | implemented | PTY harness + `runCommand` |

## Persistence (§15)

| Requirement | Status | Evidence |
|---|---|---|
| SQLite local-first | implemented | `node:sqlite` `DatabaseSync` |
| All spec tables | implemented | workspaces, projects, agents, harnesses, sessions, tasks, messages, events, artifacts, workflows(plans), approvals, decisions, templates |
| Event-sourced direction preserved | partial | append-only events + conventional tables; no projection rebuild from events yet |

## Observability & Replay (§16)

| Requirement | Status | Evidence |
|---|---|---|
| Node inspector (status/task/context/events/terminal) | implemented | InspectorPanel; WideInspector; LogsPanel; terminal panes |
| Replay (reconstruct state from events) | implemented | PTY replay; `afterSeq` SSE replay; `pty-replay` test |

## Reliability (§17)

| Requirement | Status | Evidence |
|---|---|---|
| Harness crash → BLOCKED/RETRYABLE | implemented | crash handling; failure tests |
| Runtime restart recovery | implemented | durable plans/tasks/sessions; `plan-persistence` test |
| Bounded retries | implemented | retry budget |
| Cancellation | implemented | orchestrator/scheduler cancel; tests |
| Failed worker does not corrupt workspace | implemented | isolation; failure tests |

## Security (§18)

| Requirement | Status | Evidence |
|---|---|---|
| No raw API keys to workers | implemented | env-based provider config; secrets not passed to harness |
| Project filesystem scoped | implemented | tool-runner root scoping |
| Destructive ops approval-gated | implemented | `#withApproval` |
| Audit privileged actions as events | implemented | `approval.requested` events; event log |

## Tech Stack (§19)

| Requirement | Status | Evidence |
|---|---|---|
| React + TS + Vite | implemented | `web/` |
| XYFlow/React Flow | partial | planned replacement for SVG |
| Zustand/query cache | deferred | React state + polling adequate for projection |
| Node runtime | implemented | Node ≥24 |
| Drizzle ORM | divergence | raw `node:sqlite` per repo convention (documented in AGENTS.md) |
| PTY library | implemented | node-pty |
| Playwright | partial | browser-tool optional; not a hard dependency |
| MCP | implemented | Phase 8 client |

## Milestones (§21)

| Milestone | Status | Evidence |
|---|---|---|
| P0 headless runtime | implemented | golden-path test |
| P0 orchestrator loop | implemented | plan → task → harness → artifact → report |
| P0 agent communication | implemented | messages/events |
| P0 artifact references | implemented | artifacts table + context refs |
| P1 multi-agent | partial | sequential multi-task; concurrent multi-harness scheduling exists |
| P1 harness adapters | implemented | claude/pi/omp/freebuff + generic fallback |
| P1 direct worker interaction | implemented | send/interrupt/resize; test |
| P2 visual canvas | partial | SVG projection live; React Flow pending |
| P2 terminal nodes | partial | terminal panes wired; canvas-embedded terminals pending |
| P2 context inspector | implemented | ContextBusPanel, inspector endpoints |
| P3 MCP | implemented | mcp-client (Phase 8) |
| P3 approvals & permissions | implemented | full approval flow + capability policy |
| P3 replay & recovery | implemented | replay + restart recovery tests |
| P4 hierarchical squads | deferred | future capability; squad lead pattern in Orchestrator |

## Acceptance Tests (§22)

| Scenario | Status | Evidence |
|---|---|---|
| P0 Golden Path | implemented | `tests/acceptance.ts` + `tests/golden-path.ts` |
| Multi-agent | implemented (scripted provider) | `tests/acceptance.ts`; real multi-harness needs LLM provider |
| Direct intervention | implemented | `tests/acceptance.ts`; `direct-worker-interaction.ts` |
| Failure acceptance | implemented | `timeout-cancellation.ts`, `acceptance.ts` |
| Visual workflow | implemented | template seeding + graph projection tests |

## Known Deferred / Divergences

1. **React Flow canvas** — spec target; current SVG canvas is functional projection. Replacing requires XYFlow dependency + position persistence, not yet shipped.
2. **Drizzle ORM** — repo convention uses raw `node:sqlite` (documented divergence).
3. **Hierarchical squads (P4)** — Orchestrator acts as squad lead; multi-level tech/QA/research leads not implemented.
4. **IRC channels UI** — message `channel` field exists; channel rooms not exposed.
5. **Context hierarchy depth** — workspace/task refs work; full global→session hierarchy not surfaced.
6. **Event-sourced projection rebuild** — events append-only; rebuild-from-events not implemented.
7. **Playwright hard dependency** — optional; browser tool degrades honestly.
8. **LLM provider live integration** — `LLMDecisionProvider` implemented and tested with mocks; real API call requires `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` at runtime.
9. **Wide Inspector config persistence** — inspector validates and drafts; runtime node-config update endpoint not yet wired.
