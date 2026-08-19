# Chef — Product & Runtime Specification

**Version 0.2 — Living Workspace Model**

This revision replaces Chef's workflow-first product mental model with a live, node-based AI workspace while preserving deterministic automation as an optional capability.

## 0. Revision Summary

Chef is **not primarily a workflow builder that waits for a user to press Run**. It is a persistent, living workspace in which agents, terminals, browsers, files, tools, and shared context can remain active and directly inspectable.

- The canvas represents the living runtime, not merely an executable workflow definition.
- Agent and interactive tool nodes may be live as soon as they are created, connected, restored, or explicitly activated.
- Edges primarily describe relationships: communication, context/data access, delegation, dependency, or optional control flow.
- A global **Run** button is not the default interaction.
- User intent normally creates a **Mission**. The Orchestrator executes and adapts that Mission continuously.
- Repeatable deterministic workflows remain supported as an optional **Automation** capability, where Run/Stop semantics are appropriate.
- Simple Mode and Power Mode remain presentation layers over the same runtime; they are not separate execution models.

## 1. Product Definition

**One-liner:** Chef is a visual AI workspace where humans collaborate with a live team of agents and tools on a shared canvas, while an Orchestrator can turn intent into missions, coordinate work, and optionally execute repeatable automations.

Core mental model: **open a workspace, bring in people-like agents and useful tools, connect or group them, give Chef a goal, and watch the workspace respond in real time.**

Chef should feel closer to an approachable collaborative desktop workspace than to an IDE, DAG runner, or n8n-style automation editor.

### Product mantras

- The runtime is the product; the canvas is the live window into it.
- The workspace is alive; execution is not gated by a global Run button.
- Human intent → Mission → Orchestrator → live agents/tools → artifacts/decisions → outcome.
- Connections express relationships first; execution ordering is explicit only when needed.
- Automation is a capability inside Chef, not Chef's default mental model.
- LLMs are replaceable. Harnesses are replaceable. Durable state, context, artifacts, and events are not.

## 2. Core Product Objects

| Object | Definition |
| --- | --- |
| Workspace | Persistent environment containing live nodes, projects, missions, automations, context zones, events, artifacts, decisions, and configuration. |
| Node | A live or passive object on the canvas: Agent, Terminal, Browser, File/Data, Tool, Human, Context, Output, or Control. |
| Agent | Logical AI worker identity backed by Claude Code, Codex CLI, Pi, OMP, Aider, a generic LLM agent, or another harness. |
| Surface | An inspectable interactive node such as Terminal or Browser. It can remain live independently of a Mission. |
| Edge | A typed relationship between nodes. Communication/context/data edges do not imply sequential execution. |
| Context Zone | A visual group defining a shared contextual world, with persisted membership and context policy. |
| Mission | Goal-oriented work created from human intent. The Orchestrator may plan, assign, spawn, message, retry, verify, and replan while active. |
| Automation | Reusable executable graph with explicit triggers, dependencies, control flow, retries, approvals, and Run/Schedule semantics. |
| Task | Unit of work owned by an agent/tool within a Mission or Automation. |
| Artifact | Durable output/reference such as a file, report, code change, research finding, image, test result, or dataset. |
| Event | Immutable record of meaningful runtime activity. |
| Decision | Durable project/workspace conclusion, constraint, choice, or lesson. |

## 3. Interaction Model

### 3.1 Default: Live Workspace

The default canvas is persistent and reactive. It does not sit in a pre-execution state waiting for Run.

- Dropping an Agent creates/configures an agent identity and, according to policy, can start or restore its harness/session.
- Dropping a Terminal or Browser creates an inspectable surface that can be opened and used immediately.
- Sending a message to an agent is immediate.
- Connecting compatible nodes establishes a relationship immediately.
- Moving a node into a Context Zone updates its context membership immediately.
- Runtime events update node status on the canvas in real time.
- **Idle is a valid live state.** A node need not continuously consume tokens or CPU to be considered present/alive.

### 3.2 Mission Interaction

The primary high-level action is not **Run Workflow**. It is **giving Chef a goal**.

```text
USER: "Review this workbook and prepare the monthly variance report."

CHEF / ORCHESTRATOR:
- creates Mission
- inspects available nodes, files, and context
- forms a plan
- assigns work to existing agents/tools or creates suitable workers
- observes results and failures
- requests approval only when policy requires it
- verifies the outcome
- reports completion and leaves artifacts in the workspace
```

A Mission can be paused, cancelled, resumed, or redirected. The user may intervene directly in any worker without leaving the workspace.

### 3.3 Automation Interaction

Automation is the explicit executable-workflow mode. It is appropriate for repeatable jobs such as monthly reports, ingestion pipelines, scheduled research, CI-like verification, or document generation.

- Automations may expose **Run, Stop, Schedule, Trigger, Retry**, and execution history.
- Control/dependency edges determine execution order where configured.
- Automations reuse the same agents, tools, context, and artifacts available in the workspace.
- The Orchestrator may invoke an Automation as part of a Mission.

## 4. Canvas Semantics

### 4.1 Canvas Principle

The canvas is a projection and control surface over authoritative runtime state. It should **not** be described primarily as a workflow editor. Its first responsibility is to show the user's current AI workspace: who/what exists, what is connected, what is happening, and what context/results are available.

### 4.2 Node Categories

- **Agent** — AI Accountant, Research Agent, Claude Code, Codex, Pi, generic LLM worker.
- **Surface / Tool** — Terminal, Browser, Git, GitHub, filesystem, database, MCP tool.
- **File / Data** — Excel, CSV, PDF, folder, dataset, document.
- **Human** — input, review, approval, collaborator.
- **Context** — shared project knowledge, memory, scoped context source.
- **Output** — report, workbook, document, code artifact, export/delivery.
- **Control** — condition, router, merge, loop, approval, trigger; primarily for Automations or advanced Mission plans.

### 4.3 Edge Types

| Edge | Meaning | Sequential? |
| --- | --- | --- |
| Communication | Nodes may exchange structured messages/events. | No |
| Context / Data | Target can consume selected source outputs, references, or context. | No by default |
| Delegation | One agent may assign/request work from another within policy. | No fixed order |
| Dependency | Target work waits for source condition/completion. | Yes |
| Control | Explicit execution path such as condition/router/loop. | Yes |
| Error | Routes or exposes failure handling. | Only when configured |
| Approval | Waits for human authorization. | Yes |

### 4.4 Context Zones

Context Zones are first-class visual containers answering: **which nodes inhabit the same contextual world?**

- Membership is persisted as runtime state; geometry alone is not the source of truth.
- A zone may expose shared files, artifacts, decisions, messages, events, instructions, and memory references.
- Context remains selectively injected. Zone membership does not dump the entire history into every prompt.
- Nested zones may represent Workspace → Project → Mission or other scoped worlds.
- A node can show which context it currently sees and why.

## 5. UI / UX

### 5.1 Default Layout

- **Center:** infinite live canvas; visual center of gravity.
- **Left:** Node Library, templates, files/resources, optional workspace navigation.
- **Right:** contextual Inspector for the selected node, edge, zone, Mission, or Automation.
- **Bottom/dockable:** Chef conversation, activity/events, results, terminal/browser surfaces as appropriate.
- **Top:** workspace identity, mode switch, Mission status, search/command surface, safety controls. **Run must not be the dominant global action.**

### 5.2 Live Status Language

Agents: `Offline`, `Starting`, `Idle`, `Thinking`, `Working`, `Waiting`, `Blocked`, `Needs Input`, `Failed`.

Terminal/Browser: `Closed`, `Starting`, `Connected`, `Busy`, `Disconnected`, `Failed`.

Mission: `Planning`, `Active`, `Waiting for Approval`, `Blocked`, `Verifying`, `Completed`, `Cancelled`, `Failed`.

Automation run: `Queued`, `Running`, `Waiting`, `Completed`, `Failed`, `Cancelled`.

### 5.3 Simple Mode

- Friendly names and outcomes, not runtime jargon.
- Chef conversation/command surface is prominent: users describe what they want.
- Templates create useful workspaces, Missions, and Automations without exposing graph theory.
- Nodes can look like people, apps, files, and steps rather than abstract runtime components.
- Harness settings, model parameters, PTY details, raw context refs, and event internals stay hidden.
- Users can still directly open a node and ask it something.

### 5.4 Power Mode

- Expose harness/session state, terminal streams, structured messages, event history, context refs, permissions, costs/tokens, task ownership, and advanced edge semantics.
- Allow direct worker intervention, manual task assignment, session lifecycle controls, and detailed Mission plans.
- Allow building explicit Automations and subgraphs.
- Power Mode is denser, **not a different runtime**.

## 6. Orchestrator Semantics

The Orchestrator is a privileged live agent and runtime coordinator. It is **not a Run button with an LLM behind it**.

It receives human intent continuously, inspects workspace state, creates Missions and Tasks, prefers existing suitable workers before spawning new ones, delegates through runtime-owned protocols, observes events, adapts plans, invokes Automations as tools, requests approvals, verifies outcomes, and summarizes meaningful progress.

**Runtime rule:** LLMs decide; the runtime validates and executes. Live/realtime behavior does not give LLMs direct authority over lifecycle, permissions, persistence, or scheduling.

## 7. Runtime Architecture

```text
DESKTOP UI
  Canvas | Chef | Inspector | Terminals | Browsers | Activity
                         |
                    Runtime API
                         |
RUNTIME
  Workspace Manager | Mission Manager | Orchestrator
  Task/Scheduler     | Automation Engine | Agent Manager
  Context Manager    | Permission/Approval Manager
                         |
        Events | Context | Artifacts | Decisions
                         |
                   Harness Manager
                         |
       Claude / Codex / Pi / OMP / Generic PTY / Tools
```

The Automation Engine is only one consumer of the runtime. The runtime must also support long-lived workspace entities and sessions outside an active automation run.

## 8. Persistence & Recovery

- Persist workspace graph relationships, Context Zone membership, node configuration, sessions, Missions, Tasks, Automations, messages, events, artifacts, approvals, and decisions.
- Closing and reopening Chef reconstructs the workspace as a living environment, including meaningful historical state.
- Processes that cannot survive shutdown are restored/reconnected according to harness policy; the UI distinguishes restored identity from a newly spawned process.
- Runtime crashes must not erase Mission/task/artifact history.
- Event history should answer what happened, who did it, what context was used, and why the Orchestrator acted.

## 9. Example Mental Models

### Developer: live engineering room

```text
[Project Context Zone]
  Orchestrator
      |
  Claude Code <----communication----> Pi
      |                                |
   Terminal                         Browser
      \________ shared artifacts ______/

User: "Fix the flaky checkout test."
```

No global Run is required. The Orchestrator creates a Mission, delegates investigation, agents exchange findings, tests run in terminals, and the canvas updates live. The user can open any node and intervene.

### Accountant: casual workspace

```text
[Monthly Close Context]
  January GL.xlsx
        |
  AI Accountant <----> Review Assistant
        |                    |
  Report Preview          Source Docs

User: "Prepare the monthly variance report and flag anything unusual."
```

Chef creates a Mission and uses the existing workspace. The user sees understandable progress and reviews the result without needing to know about LLMs, harnesses, PTYs, or context buses.

### Repeatable automation

```text
Trigger / Manual Run
       |
Read Workbook
       |
Validate -> Analyze -> Human Review -> Generate PDF -> Deliver
```

Here a **Run** button is correct because the user is executing a repeatable automation with explicit control flow.

## 10. Acceptance Tests

1. Add an Agent node and interact with it without first running the whole canvas.
2. Add a Terminal node and use it independently of a Mission.
3. Connect two agents with a Communication edge without implying sequential execution.
4. Place nodes in a Context Zone; shared context membership is persisted and inspectable.
5. Tell Chef `Investigate and fix this bug.` Chef creates a Mission and coordinates workers without a global Run action.
6. Intervene directly in a worker during a Mission; the intervention becomes an event and the Orchestrator remains coherent.
7. Close and reopen the workspace; graph relationships, context membership, Mission/task history, artifacts, and decisions remain available.
8. Create an Automation with dependency/control edges; Run/Stop exists for that Automation or Automation-focused surface.
9. Simple Mode hides technical runtime terminology while preserving the same underlying live state.
10. Power Mode exposes sessions, terminals, context refs, events, task state, permissions, and execution details.

## 11. Migration from v0.1

| v0.1 | v0.2 |
| --- | --- |
| Drag → connect → configure → run. | Open/add → connect or group → give intent → observe/intervene. Run is reserved for Automations. |
| Workflow graph dominates the canvas. | Workspace graph dominates; Missions and Automations exist within it. |
| Edges mainly describe execution/data/control. | Edges primarily describe typed relationships; sequencing is explicit. |
| Workflow execution is the default action. | Live interaction and Missions are the default. |
| Simple/Power modes center on running workflows. | Both center on the same living workspace with different disclosure. |
| Node status focuses on running/completed/failed. | Persistent live states include idle, working, waiting, connected, blocked, and offline. |

## 12. Implementation Guardrails

- **Do not implement a dominant global Run button on the main workspace canvas.**
- Do not treat every edge as a DAG dependency.
- Do not require a Mission to make every interactive node usable.
- Do not equate live with always-running expensive inference; agents may be Idle while identity/context/session state remains present.
- Do not make Context Zones visual-only decoration; persist membership and context policy.
- Do not let spatial UI geometry become authoritative runtime state.
- Do not fork Simple and Power Mode into separate execution systems.
- Preserve deterministic scheduling, permissions, persistence, approvals, cancellation, retries, and auditability.
- Make Automation a first-class but optional executable graph.
- Optimize the default experience around intent, collaboration, visibility, and intervention.

## 13. Revised Design Mantra

> **A living workspace first. Missions when you want an outcome. Automations when you want repeatability.**
