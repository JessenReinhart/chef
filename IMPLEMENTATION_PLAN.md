# Chef Finished Product — Implementation Plan

## Goal
Deliver Chef as a runtime-first visual AI workbench: durable local execution, real workflow nodes, human approvals, agent/tool integrations, Simple Mode, Power Mode, streaming chat, and verifiable end-to-end workflows.

## Current baseline
- Runtime: SQLite-backed tasks, sessions, events, artifacts, retries, cancellation, approvals, PTY replay, live events, durable plans.
- Backend: `ChefRuntime`, HTTP state/graph/event/session/approval endpoints.
- Web: Vite/React dashboard with polling, SVG graph projection, approval controls.
- Known gap: `ScriptedDecisionProvider` creates a fixed plan and does not interpret user intent.

## Global constraints
- Runtime state remains authoritative; UI is a projection/control surface.
- Preserve PTY output versus structured sideband separation.
- Persist important lifecycle mutations transactionally through `Repository`.
- Use Node >=24 native TypeScript stripping; no enums, namespaces, parameter properties, dynamic imports, or inline type-only imports.
- Keep graph definitions UI-library independent; React Flow is only a renderer/editor.
- LLMs propose bounded decisions; runtime validates and executes them.
- No fake providers, placeholder handlers, silent fallbacks, or unbounded retries.
- Every phase adds focused executable tests and is verified before integration.

## Shared node contract
The node registry is the source of truth for both modes:

```ts
export type NodeCategory = "agent" | "tool" | "control" | "workflow" | "human";
export type NodeStatus = "idle" | "ready" | "running" | "waiting" | "completed" | "failed" | "cancelled";
export interface NodeDefinition<TConfig = unknown> {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;
  inputs: readonly PortDefinition[];
  outputs: readonly PortDefinition[];
  config: ConfigSchema<TConfig>;
  execute(ctx: NodeExecutionContext<TConfig>): Promise<NodeExecutionResult>;
}
```
The initial registry must cover AI Agent, Terminal, File/Data, Browser, Transform, Logic, Human Approval/Input, Database, and Output, with explicit ports, validation, status events, and durable artifacts.

---

## Phase 1 — Core Node Registry + Execution Engine
**Assigned agent:** `NodeForge` (primary), `RuntimeReview` (review)
**Dependencies:** existing `src/core/*`, `Repository`, `Scheduler`, `ContextManager`.
**Blocks:** all UI node rendering, templates, workflow execution, and chat-generated plans.

Tasks:
1. Add UI-independent node contracts and registry under `src/core/nodes.ts` and `src/runtime/node-registry.ts`.
2. Implement definitions for the nine required node categories/types, with typed ports and config schemas.
3. Add deterministic graph validation: unique IDs, valid types, ports, acyclic control dependencies, required inputs, and bounded execution.
4. Add `NodeExecutionEngine` that executes runnable graph nodes through runtime adapters, persists node events/status, propagates data/artifacts, handles approval waits, cancellation, and bounded failure edges.
5. Add focused tests for registry lookup, config validation, dependency ordering, data transfer, approval blocking, failure propagation, and cancellation.

Acceptance: a persisted workflow graph containing the nine node types executes deterministically without the UI and emits reconstructable events/artifacts.

## Phase 2 — API + Backend Services
**Assigned agent:** `RuntimePilot`
**Dependencies:** Phase 1 node contracts; existing runtime/persistence.
**Parallelism:** may proceed against stable interfaces while NodeForge works; merge only after contract check.

Tasks:
1. Persist workflow definitions, nodes, edges, templates, node runs, and tool registrations in SQLite using the existing repository transaction style.
2. Add runtime APIs for workflow CRUD, template listing/creation, node execution, retries, approvals, artifacts, context, logs, and session inspection.
3. Add request validation and stable JSON error envelopes.
4. Add SSE streams for runtime events, chat messages, node status, and terminal data with disconnect cleanup.
5. Add HTTP integration coverage for all new routes and restart durability.

Acceptance: the complete runtime can be rebuilt from SQLite and controlled through documented HTTP/SSE endpoints.

## Phase 3 — React Flow Canvas + UI Layout
**Assigned agent:** `CanvasSmith`
**Dependencies:** Phase 1 graph/node contract; Phase 2 graph APIs.
**Tasks:**
1. Add XYFlow/React Flow with the version documented for the current web package.
2. Replace the SVG-only projection with an infinite canvas, minimap, fit/zoom controls, selectable nodes, connection validation, and read-only runtime status projection.
3. Add left navigation and searchable node library.
4. Build reusable node renderers for all nine node types with category colors, status indicators, ports, approval state, and result badges.
5. Add right contextual inspector shell and bottom execution console slots without moving authority into client state.
6. Add browser smoke coverage for graph rendering, drag/connect/configure, approval controls, and responsive layout.

Acceptance: a user can drag, connect, configure, and run a workflow while the canvas remains a projection of backend state.

## Phase 4 — Simple Mode Templates + Guided Wizard
**Assigned agent:** `SimpleFlow`
**Dependencies:** Phase 1 registry; Phase 2 workflow/template APIs; Phase 3 node components.
**Tasks:**
1. Add first-class templates: Monthly Financial Report, Cash Flow Analysis, Budget vs Actual, and Developer Fix/Verify.
2. Build plain-language template selection and guided setup wizard for files, recipients, thresholds, and approvals.
3. Build simple inspector fields with progressive disclosure and accessible validation.
4. Add friendly labels and statuses; hide runtime/model terminology in Simple Mode.
5. Add mode toggle preserving the same workflow definition and runtime IDs.
6. Add tests for template creation, wizard validation, mode switching, and workflow launch.

Acceptance: a non-technical user can select a template, answer guided questions, run it, approve a checkpoint, and download a result.

## Phase 5 — Power Mode Advanced Panels
**Assigned agent:** `PowerDeck`
**Dependencies:** Phase 1 node events; Phase 2 SSE/session APIs; Phase 3 canvas shell.
**Tasks:**
1. Implement dark Power Mode styling matching the visual spec without duplicating workflow state.
2. Add live Logs panel with node/session filters and event timestamps.
3. Add interactive terminal panes wired to existing send/resize/interrupt APIs and PTY replay.
4. Add Context Bus inspector for selected references, artifacts, decisions, and events.
5. Add Wide Inspector for model, temperature, token, permissions, retry, and harness configuration.
6. Add keyboard navigation, focus states, reduced-motion support, and responsive desktop layout tests.

Acceptance: advanced users can inspect and intervene in running sessions while Simple Mode remains unchanged.

## Phase 6 — Chat with Chef Streaming
**Assigned agent:** `ChatStream`
**Dependencies:** Phase 1 bounded decision schema; Phase 2 SSE; existing Orchestrator.
**Tasks:**
1. Add a provider-neutral decision adapter using the configured OpenAI-compatible/Anthropic clients, with structured JSON schema validation and timeout/error handling.
2. Replace the fixed scripted plan for configured providers while retaining an explicit deterministic test provider.
3. Add chat message persistence, streaming assistant events, cancellation, and reconnect/replay semantics.
4. Let Chat with Chef explain, build, modify, and troubleshoot workflows by proposing validated graph patches; runtime applies only approved operations.
5. Add provider configuration through environment variables and safe secret handling.
6. Add tests for valid/invalid model decisions, provider failure, streaming reconnect, graph patch validation, and user-visible reports.

Acceptance: “Build a monthly report” creates a real template-backed graph; “add an approval before email” produces a validated graph patch and approval node.

## Phase 7 — Execution Console + Results
**Assigned agent:** `ConsoleAtlas`
**Dependencies:** Phase 1 node events/artifacts; Phase 2 SSE; Phase 3 layout.
**Tasks:**
1. Add bottom node-status timeline with running/completed/failed/waiting states and progress indicators.
2. Add artifact/result cards with preview, provenance, version, download, and share actions.
3. Add retry/replan/error UI tied to runtime policies, never client-only mutations.
4. Add approval queue and blockers summary to the main dashboard.
5. Add cost/token/session metrics where available and explicit “unknown” display otherwise.
6. Add UI tests for status transitions, failure recovery, artifacts, and approval flows.

Acceptance: users can observe execution, understand blockers, recover failures, and access durable outputs.

## Phase 8 — Tool/MCP + Specialized Harnesses
**Assigned agent:** `CapabilityCrew`
**Dependencies:** Phase 1 execution context; Phase 2 tool APIs; existing generic PTY harness.
**Tasks:**
1. Add a capability registry and permission policy for terminal, filesystem, browser, git, GitHub, and MCP tools.
2. Implement deterministic terminal/filesystem/git tools with scoped project roots and approval gates for destructive actions.
3. Add Playwright browser sessions as inspectable tool nodes with artifact/context outputs.
4. Add MCP client adapters as capability integrations, never as orchestration protocol.
5. Add Claude Code, Pi, OMP, and Freebuff adapter configurations where detection is available; preserve generic fallback.
6. Add security and failure tests for scope violations, malformed tool calls, provider failure, and approval denial.

Acceptance: a developer workflow can research, edit, test, browse, commit, and gate sensitive operations through runtime-owned policies.

## Phase 9 — Integration, Documentation, and Verification
**Assigned agent:** `QAAtlas` (verification), all agents supply focused tests.
**Dependencies:** Phases 1–8.
**Tasks:**
1. Run the P0 golden path, multi-agent acceptance, direct-intervention acceptance, failure/recovery acceptance, and visual workflow acceptance.
2. Add end-to-end tests for Simple Mode Accountant workflow and Power Mode Developer workflow.
3. Update README, API reference, architecture notes, setup/provider docs, and UI usage docs from actual behavior.
4. Run backend tests, web build/typecheck, security checks, and restart/replay scenarios.
5. Perform a spec-to-implementation audit covering every concrete requirement and record any intentionally deferred future capability.
6. Remove obsolete SVG-only paths and dead scaffolding only after the replacement passes.

Acceptance: all shipped behavior is documented, tested, restart-safe, and honestly labeled against the specification.

---

## Coordination protocol
- Agents edit only their assigned files and communicate interface changes through `src/core/nodes.ts` and `IMPLEMENTATION_PLAN.md`.
- No agent changes another agent's active files without an IRC handoff.
- Each implementation agent writes a short report to `.superpowers/reports/<agent>.md` and runs only focused tests; the main thread runs full verification after integration.
- Reviewers inspect diffs and acceptance criteria before a phase is marked complete.
- Phase 1's registry contract is frozen before UI agents consume it; additive changes require a compatibility note and tests.

## Documentation references
- `AI_Engineering_OS_Specification_v0.1.pdf`, sections 5, 6, 9, 11–18, 21–22.
- `Chef_UI_Visual_Spec.pdf`, sections 1–8.
- Official React Flow / XYFlow docs for node/edge APIs and viewport controls.
- Official Anthropic SDK docs and OpenAI-compatible structured-output docs for provider adapters.
- Existing repository guidance in `AGENTS.md`.
