# Chef UI North Star: Intent First, Workbench Second

**Status:** Authoritative UI direction for the next Chef overhaul  
**Scope:** Product interaction model and UI architecture  
**Supersedes:** `UI_LIVING_WORKSPACE_OVERHAUL.md` where the two documents conflict

## 1. North star

Chef should feel like giving a capable team an outcome, then watching useful work happen.

The user should not need to understand agent infrastructure, workflow graphs, sessions, PTYs, event streams, or task state before Chef becomes useful.

The interaction hierarchy is:

> **Intent first → activity second → Workbench when needed → runtime details last.**

The runtime remains authoritative. The UI is a projection that decides how much of that state is useful to show at each depth.

## 2. Core product invariant

There must be only **one obvious primary way** to tell Chef what the user wants.

For normal goal-oriented work, that surface is the Chef composer.

Direct worker messages, terminal input, graph editing, Rooms, interventions, runtime controls, and low-level inspectors are advanced capabilities. They remain available, but they must not compete with the Chef composer in the default experience.

If a first-time user asks, "Where do I type what I want?", the interface has failed.

## 3. Chef is not graph-first

The graph is valuable for inspection, orchestration, debugging, and direct control, but it is not the mandatory homepage.

Chef should open into an intent-and-activity surface that answers:

- What do you want Chef to do?
- What is Chef currently doing?
- Does anything need your attention?
- What finished?

The graph becomes the **Workbench**: a deeper workspace that the user opens when they want to inspect or manipulate how the work is happening.

This changes the previous mental model from:

`Simple graph ↔ Power graph`

to:

`Chef Home / Activity → Workbench → runtime/debug detail`

The underlying runtime and objects remain the same.

## 4. Progressive depth, not separate products

Do not make the user choose whether they are a "simple" or "power" user before using Chef.

The product should reveal capability through depth:

### Level 1: Chef Home

The default surface.

Show:

- Chef composer
- current work / Mission
- concise activity
- approvals or blockers that need the user
- recent meaningful outcomes
- entry to Workbench

Hide:

- node ports
- edge semantics
- PTY/session IDs
- event streams
- task IDs
- provider internals
- context-ref internals
- permission matrices
- raw token/runtime counters unless specifically requested

### Level 2: Workbench

For users who want to inspect or shape execution.

Show:

- graph/canvas
- agents and tools
- artifacts
- contextual node cards
- surfaces such as terminals and browsers
- relationships
- Mission highlighting
- direct worker actions

### Level 3: Runtime / Debug detail

For troubleshooting and deep control.

Show:

- sessions
- PTY state
- raw events
- task IDs
- context refs
- permission policy
- harness/provider details
- retry/lifecycle internals
- usage and cost telemetry

Each level must be reachable without rebuilding or duplicating the underlying workflow.

## 5. Human-facing state model

The runtime may keep detailed lifecycle states. The primary UI should intentionally collapse them.

For normal work, users mainly need:

- **Working**
- **Needs attention**
- **Done**

A fourth neutral state such as **Waiting** or **Ready** is acceptable when necessary.

Examples of runtime projection:

| Runtime detail | Primary UI |
| --- | --- |
| pending / assigned / spawning / running | Working |
| approval requested / blocked / actionable failure | Needs attention |
| completed / verified | Done |
| idle / dependency wait with no user action | Waiting / Ready |

Do not display several independent counters and labels that make the same Mission appear active, failed, completed, and pending at the same time.

## 6. One state hierarchy

Status must be understandable as a hierarchy:

```text
Workspace
└── Current work / Mission
    ├── Working
    │   └── Claude: investigating auth
    ├── Waiting
    │   └── verifier
    └── Needs attention
        └── terminal command failed
```

Mission, task, node, and session state may all exist internally, but the default UI presents the most useful user-level interpretation.

When detailed state is needed, the user deliberately opens deeper inspection.

## 7. Node is not surface

A canvas node is a compact representation of a runtime participant or tool.

An interactive **surface** is the place where the user directly works with that participant.

Do not make one visual object simultaneously own graph geometry, PTY input, resize state, window stacking, runtime lifecycle, selection, and detailed inspection.

Conceptually:

```text
NODE                     SURFACE
Agent              →     agent work / terminal
Terminal           →     interactive terminal
Browser            →     browser viewport
File / Artifact    →     preview / editor
```

Nodes should stay compact on the canvas. Interactive surfaces should open in a stable workspace region.

## 8. Surface behavior

Workbench surfaces should prefer docked or otherwise stable regions instead of arbitrary floating windows over the graph.

Reasons:

- fewer focus and z-index conflicts
- fewer drag/resize state machines
- less overlap with graph interaction
- clearer identity between selected node and active surface
- easier persistence and restoration
- lower synchronization surface

Floating surfaces may be added later for explicit multi-window use cases, but they must not be the baseline implementation.

A surface must have one stable runtime identity. Re-rendering, moving, or selecting a node must not silently create a second session or second source of lifecycle state.

## 9. Default Chef Home

The default screen should feel closer to a capable work assistant than an IDE.

A representative information structure:

```text
Chef                                      Open Workbench

                     What are we doing?

             [ Describe the outcome here... ]

                     Chef is working

              ✓ Inspect project
              ● Investigate login failure
              ○ Verify the fix

Needs your attention
Claude needs permission to edit auth.ts
                                [Allow] [Review]

Ask Chef anything...
```

This is an information architecture example, not a pixel contract.

Important properties:

- the composer is visually dominant
- the current goal is obvious
- progress is meaningful, not log spam
- approvals are impossible to miss
- there is no graph configuration prerequisite
- there is no global Run button for normal Mission work

## 10. Workbench

The Workbench is where the graph belongs.

Its job is to help answer:

- Who is involved?
- What is each worker doing?
- What tools and artifacts are in use?
- How are they related?
- Which worker or surface do I want to inspect?

The canvas should not be surrounded by permanent panels simply because those panels exist.

Prefer contextual access to:

- Node Library
- Inspector
- direct worker messaging
- relationship controls
- runtime details
- Rooms
- context inspection

The user should be able to expand the Workbench into a dense engineering environment, but density must be intentional.

## 11. Direct worker interaction

Direct worker interaction remains a core Chef capability.

It is not removed. Its UX role changes.

Default flow:

`Chef composer → Orchestrator → coordinated work`

Advanced flow:

`Workbench → select worker → contextual action → talk directly / open surface / intervene`

This preserves control without teaching casual users that they must decide whether to message Chef, a node, a Room, a terminal, or an inspector textarea for every request.

## 12. Rooms and messages

Rooms are useful for advanced collaboration and observability, but they are not top-level navigation in the default product experience.

They should be reachable from Workbench or collaboration context when useful.

The event/message system remains durable and authoritative regardless of whether Rooms are visible.

## 13. Automations

Automations remain intentionally separate from normal Mission work.

Normal Mission:

`give outcome → Chef coordinates continuously`

Automation:

`define repeatable behavior → run / schedule / stop / retry`

Explicit Run/Stop controls belong to Automations and other intentionally executable processes, not to the default Chef goal loop.

## 14. UI architecture rules for reliability

The new UI direction is also a reliability strategy.

### 14.1 No parallel lifecycle truth

Frontend components must not invent independent Mission, task, node, or session lifecycle state when the runtime already owns it.

Local state may control presentation such as:

- selected object
- open panel
- composer draft
- viewport
- temporary resize dimensions

Local state must not independently decide whether authoritative work is running, failed, completed, blocked, or approved.

### 14.2 Derive status from one runtime snapshot

Mission summaries, counters, node badges, activity, and inspectors should derive from the same authoritative runtime projection whenever possible.

Avoid multiple polling/subscription paths that independently infer the same status.

### 14.3 Stable entity identity

A node, task, session, and surface are related entities, not interchangeable IDs.

UI code must make that relationship explicit rather than storing whichever ID happens to be convenient in a generic selection field.

### 14.4 One owner for interactive process surfaces

The component that owns an interactive terminal/browser surface owns its UI connection lifecycle.

Canvas selection may request a surface to open, but should not also implement a second stream/session lifecycle.

### 14.5 Do not persist presentation projections as runtime semantics

Friendly layout, collapsed status, hidden details, Home cards, and activity grouping are presentation.

Do not write those projections back into runtime state unless the user actually changed an authoritative object.

## 15. Visual direction

Chef should feel like a modern desktop AI product, not a generic admin dashboard and not a purple agent-builder template.

Direction:

- restrained dark or warm-neutral surfaces depending on context
- deliberate red/coral Chef accent
- strong typography hierarchy
- fewer simultaneous borders and boxes
- generous focus around the current outcome
- compact dense Workbench when requested
- polished, high-information UI without decorative AI-dashboard clutter
- motion for state transitions, not constant ambient noise

Avoid visual treatment that implies every capability deserves a permanent panel.

## 16. UX guardrails

Before adding a new visible control, ask:

1. Is this needed for the user's outcome, or only for runtime inspection?
2. Does another UI already perform this action?
3. Could this be contextual instead of permanent?
4. Is this state already represented somewhere else?
5. Would a non-technical user know which of the competing controls to choose?

If two different top-level inputs can both plausibly answer "tell Chef what I want", remove or demote one.

## 17. First implementation slice

The first slice should prove the hierarchy without rewriting the runtime.

### Phase A: Entry surface

- add Chef Home / Activity as the default entry
- make the existing graph UI the Workbench
- provide obvious navigation into and out of Workbench
- reuse the existing Orchestrator chat/Mission API

### Phase B: Activity projection

- derive simple Working / Needs attention / Done presentation from runtime state
- show current Mission goal and meaningful worker activity
- show pending approvals prominently
- remove raw counters from the default experience

### Phase C: Workbench cleanup

- demote permanent Node Library and Inspector where practical
- move Rooms out of global/default navigation
- make direct intervention contextual
- replace the Simple/Power switch with deeper inspection affordances

### Phase D: Surface cleanup

- make terminal/browser/agent surfaces stable and docked
- ensure each surface has a single runtime connection owner
- remove overlapping floating-surface state machines

## 18. Acceptance tests

### Casual-user test

A user who has never heard of agents, harnesses, PTYs, nodes, or context buses should be able to:

1. open Chef
2. type an outcome
3. understand that Chef is working
4. see when Chef needs permission or input
5. understand when the work is done

They should not need to open Workbench.

### Developer test

A developer should be able to:

1. give Chef an outcome from the same default surface
2. open Workbench
3. inspect workers and relationships
4. open a terminal/browser/agent surface
5. directly intervene when desired
6. inspect runtime/debug detail when troubleshooting
7. return to the normal Chef view without losing state

### Reliability test

The UI must not require several independently synchronized status models to explain one Mission.

For a given runtime snapshot, the default surface must produce one coherent user-level state.

## 19. Decision rule

When UX convenience and runtime correctness conflict:

> **Runtime state remains authoritative. Simplify the projection, not the runtime contract.**

When advanced capability and default usability conflict:

> **Keep the capability. Move it deeper.**

When graph visibility and user intent conflict:

> **Intent wins by default. Workbench remains one click away.**

## 20. Implementation status

The first bounded implementation slice now follows this document:

- `IntentHome` is the default entry surface for fresh sessions.
- the primary composer uses the existing `/api/chat` Orchestrator path.
- current Mission/task state, approvals, and latest Chef output are projected on Home.
- user-facing activity is collapsed to Ready, Working, Needs attention, and Work complete.
- the existing graph UI and advanced feature overlays remain intact behind **Open Workbench**.
- the selected product surface is presentation-only local state and does not mutate runtime lifecycle state.
- a regression test guards the intent-first entry and keeps Workbench/runtime machinery out of the default Home component.

This is intentionally the first slice, not the completion of Phases C and D. Workbench panel cleanup and interactive-surface ownership remain follow-up implementation work.
