# Chef UI North Star: Intent First, Workbench Second

**Status:** Authoritative UI direction for the next Chef overhaul  
**Scope:** Product interaction model and UI architecture  
**Supersedes:** `UI_LIVING_WORKSPACE_OVERHAUL.md` where the two documents conflict

## 1. North star

Chef should feel like giving a capable team an outcome, then watching useful work happen.

The user should not need to understand agent infrastructure, workflow graphs, sessions, PTYs, event streams, or task state before Chef becomes useful.

The default experience is therefore:

> **Intent first. Activity second. Workbench when needed. Runtime details last.**

The runtime remains the product source of truth. The UI is a projection over Missions, Tasks, agents, sessions, events, artifacts, approvals, and other runtime state.

## 2. Why this direction changed

Recent hands-on use exposed a problem in the previous living-workspace direction: too many surfaces can control or describe the same work at the same time.

A user can encounter several competing interaction paths:

- a primary Chef goal input;
- another Chef/chat input;
- direct worker intervention;
- terminal input;
- Rooms or Messages;
- node selection and inspector actions;
- floating work surfaces;
- Simple and Power mode representations of similar state.

Each capability is useful by itself. Together, they create an unclear control model and many UI projections that can drift out of sync.

The result is two related problems:

1. **User confusion:** it is not obvious where the user should speak, what is authoritative, or whether Chef is currently working.
2. **Bug surface area:** Mission state, node state, inspector state, terminal state, counters, surfaces, and messages can each show a different interpretation of the same runtime activity.

The solution is not more onboarding. The interaction architecture must become simpler.

## 3. The product hierarchy

Chef has three levels of depth.

```text
DEFAULT EXPERIENCE
Chef + current work + meaningful activity
            |
            v
WORKBENCH
Graph + workers + tools + artifacts + work surfaces
            |
            v
RUNTIME / DEBUG DETAILS
Sessions + PTYs + events + context + raw task state + IDs
```

Users move deeper when they need more control or explanation. They do not choose a permanent beginner or expert identity.

### 3.1 Default experience

The default screen answers four questions:

1. What do you want Chef to do?
2. What is Chef doing now?
3. Does Chef need anything from you?
4. What did Chef produce?

The default screen should not require a graph.

### 3.2 Workbench

The Workbench is where users inspect and control how work happens.

It can expose:

- the live graph;
- agents and tools;
- terminals and browsers;
- files and artifacts;
- task relationships;
- direct worker interaction;
- deeper Mission state.

The Workbench is a powerful tool, not Chef's mandatory homepage.

### 3.3 Runtime and debug details

Low-level state is available for developers and troubleshooting, but it is not part of the normal product vocabulary.

Examples:

- session IDs;
- task IDs;
- event streams;
- context references;
- PTY state;
- raw permission capabilities;
- process lifecycle details;
- retry metadata.

## 4. Primary interaction invariant

> **There must be one obvious way to tell Chef what you want.**

The primary Chef composer is the default command surface for normal work.

Other input surfaces are contextual tools, not competing primary controls.

Examples:

- typing into a terminal means operating that terminal;
- messaging a worker means explicitly intervening in that worker;
- approving an action means resolving an approval request;
- editing a Mission means changing Mission requirements.

Direct worker interaction must remain possible, but it must look and feel like a deliberate intervention. It must also become a runtime event visible to the Orchestrator.

Chef must not show two equivalent global Chef inputs at the same time.

## 5. Default experience

A normal work session should resemble this mental model:

```text
+--------------------------------------------------+
| Chef                                Open Workbench|
|                                                  |
|               What are we doing?                 |
|       [ Fix the login bug in this project ]      |
|                                                  |
| Current work                                     |
| Fix login bug                                    |
|                                                  |
|  Working                                         |
|  Claude is investigating authentication          |
|  Next: run verification                          |
|                                                  |
| Needs your attention                             |
| Allow edit to auth.ts?              [Review]     |
|                                                  |
| Results                                          |
| No final result yet                              |
|                                                  |
| Ask Chef anything...                             |
+--------------------------------------------------+
```

This is not a dashboard full of runtime widgets. It is a calm control surface around the current outcome.

### 5.1 Required default surfaces

The default product should have only a small number of first-class surfaces:

- **Chef composer** for intent and follow-up;
- **Current Work** for the active Mission and meaningful progress;
- **Attention** for approvals, blockers, and required user decisions;
- **Results** for artifacts and completed outcomes;
- **Open Workbench** for deeper inspection and control.

## 6. State hierarchy

The UI must not expose every runtime state at the same visual level.

### 6.1 Human-facing state

At the highest level, Chef should prefer a small state vocabulary:

- **Working**
- **Needs attention**
- **Done**

A secondary state such as **Stopped** or **Failed** can appear when the whole work item cannot continue.

### 6.2 Mission and worker detail

Deeper views can explain the human-facing state with more specific information:

```text
Work: Fix login bug
|
+-- Working
|   +-- Claude: Investigating
|   +-- Test Agent: Waiting
|
+-- Needs attention
    +-- Terminal command failed
```

### 6.3 Runtime state

The runtime may retain a richer state machine. The UI does not need to flatten all of it into badges.

Task, agent, session, process, and Mission states can differ without creating contradictory top-level messages. The UI derives one meaningful user-facing interpretation.

## 7. The graph is not the homepage

The graph remains important, but its job changes.

It is best for:

- understanding orchestration;
- inspecting relationships;
- seeing handoffs;
- debugging blocked work;
- directly controlling workers and tools;
- building or editing advanced reusable structures.

It is not required for:

- asking Chef to do something;
- checking whether Chef is still working;
- approving a request;
- reading a result;
- downloading or opening an artifact;
- doing a simple follow-up.

The Workbench graph is therefore an inspection and control environment, not the primary conversation metaphor.

## 8. Nodes and work surfaces are different things

A node represents a runtime participant or relationship in the Workbench.

A work surface is where the user directly interacts with that participant.

```text
NODE                    WORK SURFACE
Terminal        ->      Interactive terminal
Claude Code     ->      Agent conversation / terminal
Browser         ->      Browser viewport
File            ->      File preview or editor
Artifact        ->      Result preview
```

Nodes should stay compact and stable.

A Terminal node should not also be responsible for being a draggable floating terminal window, task participant, inspector target, PTY lifecycle controller, resizable viewport, and status dashboard at the same time.

### 8.1 Surface behavior

By default, interactive surfaces should open in a stable dock, panel, or focused workspace region instead of floating over the graph.

This reduces:

- focus bugs;
- drag and resize conflicts;
- z-index problems;
- unclear selection state;
- accidental graph interaction;
- duplicate lifecycle state.

Floating surfaces can remain an optional advanced interaction later if there is a clear use case.

## 9. Progressive depth replaces the hard Simple / Power split

Chef should not require users to switch between two product identities.

Instead, each object can expose increasing depth:

```text
summary -> contextual detail -> Workbench -> runtime/debug detail
```

Examples:

### Agent

```text
Claude is investigating
        ->
Claude detail card
        ->
Open in Workbench
        ->
Session / terminal / events / context
```

### Failure

```text
Needs attention
        ->
Tests failed
        ->
Open verification work
        ->
Raw command output and event history
```

This keeps advanced capability available without making low-level concepts permanent UI chrome.

## 10. Direct intervention

Direct intervention is a power feature and must stay possible.

It should not be a permanent textarea in every inspector.

A user deliberately chooses an action such as:

- **Message Claude**
- **Open terminal**
- **Redirect task**
- **Retry**
- **Stop worker**

Chef records the intervention as runtime state. The Orchestrator sees it and adapts if needed.

This keeps direct control without creating a second invisible orchestration path.

## 11. Rooms and messages

Agent-to-agent messaging and channels remain useful runtime capabilities.

They should not be a required top-level navigation concept for normal work.

Default users should see meaningful collaboration through activity summaries and Mission progress.

Rooms, channels, and raw messages belong in Workbench or debug depth unless a future use case proves they deserve a first-class product surface.

## 12. Bug-resistance rules

The UI redesign must reduce state duplication, not only change visual styling.

### 12.1 Runtime authority

The runtime remains authoritative for:

- Mission state;
- task state;
- agent identity;
- session lifecycle;
- approvals;
- artifacts;
- events;
- messages;
- execution state.

UI components must not invent parallel lifecycle state when runtime state already exists.

### 12.2 Derived presentation

Top-level labels, counters, and summaries should be derived from the same normalized runtime state.

Do not independently compute Mission status in the Mission panel, graph node, inspector, and header.

### 12.3 One entity, one active identity

Selecting an agent, opening its surface, and inspecting its session must refer to the same underlying entity mapping.

A surface is a view of an entity. It is not a second entity with a separate lifecycle.

### 12.4 Event-driven updates

Important state transitions should come from persisted runtime events or authoritative runtime queries. Avoid local optimistic state that can survive after the runtime disagrees.

### 12.5 Friendly status is a projection

A user-facing status such as **Working** can summarize several valid runtime states. It must not become a second state machine that the runtime has to synchronize manually.

## 13. What should leave the default UI

The next overhaul should remove or demote these elements from the default experience:

- duplicate global Chef inputs;
- permanent Rooms navigation;
- permanent Node Library;
- permanent inspector;
- permanent direct-intervention textarea;
- raw task and session IDs;
- raw permission chips;
- raw event-stream state;
- floating terminal/browser surfaces by default;
- the hard Simple / Power mode toggle.

These capabilities are not deleted. They move to the depth where they are useful.

## 14. What must remain easy to reach

Simplification must not cripple Chef for developers.

From the Workbench, a power user should still be able to quickly:

- inspect any agent;
- open a real terminal;
- open a browser session;
- inspect task relationships;
- inspect artifacts;
- message a worker directly;
- stop or retry work;
- inspect context;
- inspect events and logs;
- configure agents and tools;
- understand why the Orchestrator made an important decision.

The goal is fewer competing controls, not fewer capabilities.

## 15. UX acceptance tests

### 15.1 First-time user

Give Chef to a user who does not know what an agent harness, PTY, task graph, or event bus is.

Without documentation, the user should be able to:

1. give Chef a goal;
2. understand that work started;
3. see meaningful progress;
4. notice when Chef needs input;
5. approve or reject the request;
6. understand when the work is done;
7. open the result.

If the user asks which input they should use to talk to Chef, the design failed.

### 15.2 Developer

A developer should be able to move from the same default experience into the Workbench and:

1. identify which worker owns a task;
2. inspect the live terminal or browser;
3. send a direct intervention;
4. inspect relevant logs and events;
5. understand a failure;
6. return to the high-level Mission without losing context.

### 15.3 State consistency

For one Mission, the header, activity view, node cards, inspector, and surfaces must not report conflicting interpretations of whether the work is active, waiting, failed, or complete.

## 16. Implementation order

The next UI overhaul should prefer interaction simplification before visual polish.

### Phase 1: establish one control plane

- keep one primary Chef composer;
- create one Current Work surface;
- create one Attention surface;
- create one Results surface;
- move secondary controls behind contextual actions.

### Phase 2: make Workbench a deliberate depth

- move graph editing and runtime-heavy controls into Workbench;
- make nodes compact;
- separate nodes from interactive surfaces;
- use stable docked work surfaces.

### Phase 3: normalize presentation state

- derive top-level status from authoritative runtime state;
- remove duplicated local lifecycle logic;
- unify entity selection and surface identity;
- test failure, retry, cancellation, and session-exit paths.

### Phase 4: polish

Only after the interaction model is stable:

- refine motion;
- refine spatial layout;
- refine visual hierarchy;
- add richer artifact previews;
- add semantic zoom where it helps.

## 17. Decision rules

When a new UI feature is proposed, ask:

1. Does this create another place to tell Chef what to do?
2. Does this create another copy of state the UI must synchronize?
3. Does a normal user need this before they can get an outcome?
4. Can this live one level deeper without reducing capability?
5. Is this representing runtime truth, or inventing frontend truth?
6. Does this make Chef feel more like a capable team, or more like infrastructure software?

If a feature adds another control plane or another lifecycle state without a strong reason, do not add it.

## 18. Final product mantra

> **Tell Chef the outcome. See what matters. Go deeper only when you need to.**

And for implementation:

> **One control plane. One runtime truth. Many levels of detail.**
