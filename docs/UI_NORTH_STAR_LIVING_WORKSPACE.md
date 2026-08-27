# Chef UI North Star: The Living Workspace

**Status:** Authoritative product/UI direction  
**Scope:** Default user journey, workspace architecture, orchestration visibility  
**Supersedes:** `UI_NORTH_STAR_INTENT_FIRST.md` and `UI_LIVING_WORKSPACE_OVERHAUL.md` where they conflict

## 1. Product statement

Chef is a living workspace controlled primarily through natural language.

> **Users specify outcomes. Chef constructs the team and workspace. The canvas explains what Chef is doing.**

Chef is not a chat application that launches a workflow editor. It is not a graph editor that requires the user to assemble a workflow before work can start. It is one persistent project workspace where the user gives Chef an outcome, watches the right workers/tools materialize, intervenes when useful, and receives a verified result in the same place.

## 2. Reference workflow lessons

Chef combines two useful interaction models without copying either product wholesale.

### Nodeterm lesson: project and session clarity

Nodeterm is strongly project/canvas-first. A project folder is the foundation for terminals and agent sessions, and the user can inspect real agent/terminal execution spatially.

Chef adopts:

- unmistakable active-project context
- persistent spatial work
- inspectable real worker sessions
- direct terminal/agent access when wanted

Reference: https://nodeterm.dev/docs/get-started/quickstart

### October lesson: goal-first orchestration

October's strongest product idea is that the user provides the objective while the orchestration system decides which workers should participate and how work should be split/coordinated.

Chef adopts:

- outcome-first interaction
- automatic worker/tool selection
- automatic workspace/team construction
- collaboration and delegation as runtime behavior
- the human as supervisor, not manual dispatcher

Reference: https://www.october.dev/

### Chef's synthesis

> **Nodeterm shell + October brain.**

The project/workspace is always explicit, while team construction and orchestration are Chef's responsibility.

## 3. One canonical product surface

Chef has one default surface: **the Living Workspace**.

There must not be separate competing "Home" and "Workbench" applications. Conversation, current Mission, worker presence, artifacts, and project context belong to one continuous product surface.

Runtime/debug detail is progressive disclosure from that surface.

```text
Chef Living Workspace
├── Active project
├── Chef composer
├── Current Mission
├── Workers / tools that Chef brought in
├── Human-readable live activity
├── Approvals / blockers
├── Results / artifacts
└── Runtime details (optional)
```

Threads/history may organize continuity, but they are navigation/history concepts, not a second homepage.

## 4. Canonical journey

```text
Open Chef
   ↓
Confirm / select project
   ↓
Land in Living Workspace
   ↓
Tell Chef the outcome
   ↓
Immediate acknowledgement
   ↓
Chef plans and selects workers/tools
   ↓
Workers/tools appear in the workspace
   ↓
Visible human-readable progress
   ↓
User may redirect/intervene while work continues
   ↓
Chef verifies the result
   ↓
Result appears in the same workspace
   ↓
Continue naturally with follow-up work
```

This journey is the product contract.

## 5. Project context is safety-critical UX

The active project must be impossible to miss.

At minimum show:

- project name
- full or clearly inspectable project path
- an obvious Change Project action

The user should not be able to accidentally ask Chef to build a new app inside Chef's own repository without seeing that `/path/to/chef` is the active workspace.

Worker cwd must continue to come from the active project runtime. The UI only makes that truth obvious.

## 6. The composer is the primary control

There is one obvious place to tell Chef what outcome is wanted.

Examples:

- `Create a tic tac toe game.`
- `Fix the login regression and verify it.`
- `Research these options and recommend the best one.`
- `Make the generated page responsive.`

The user does not manually add Claude, OMP, Browser, Terminal, or a verifier before the request can start.

Manual worker/tool creation remains available as an advanced capability, but it must never be a prerequisite for normal Mission work.

## 7. The canvas represents reality, not configuration

This is a core Chef rule.

The default canvas should explain the team/work topology Chef actually created for the Mission.

The user says:

```text
Build this and make sure it works.
```

Chef may produce:

```text
              YOUR WORK
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
   Claude Code             Browser
   implementing            waiting
        │                     │
        └──────────┬──────────┘
                   ▼
                Verify
```

The graph is an observable consequence of orchestration, not a form the user must fill out first.

## 8. Chef owns team construction

Chef decides which eligible workers/tools are useful for a Mission.

The user should not need to know the harness registry ordering.

Routing may consider, in later iterations:

- capability fit
- task type
- availability/readiness
- recent reliability
- latency
- cost
- user preference
- failure fallback

The smarter router is a separate implementation iteration. This North Star does not require that router to land in the same PR.

What is required now is the product contract: **the user requests the outcome; Chef owns team construction.**

## 9. Observability is part of correctness

A Mission is not product-green merely because a worker process exists.

Chef must continuously answer:

- Did my request get accepted?
- What is Chef doing now?
- Which worker is doing it?
- Is another worker queued/waiting?
- Did something fail?
- What finished?
- Where is the result?

Default activity must be human-readable. Raw PTY output and structured events remain available under runtime detail.

Preferred progress language:

```text
Claude Code is inspecting the project.
Claude Code started implementing the game board.
Browser is waiting to verify the result.
Running tests.
The implementation finished. Verification started.
```

Avoid making the user infer progress from `session.data`, task IDs, or terminal control sequences.

## 10. Human-facing state hierarchy

The default experience intentionally collapses runtime detail.

Primary states:

- **Working**
- **Needs attention**
- **Done**
- **Ready / Waiting** when neutral state is necessary

Hierarchy:

```text
Workspace
└── Mission
    ├── Claude Code — Working
    ├── OMP — Queued
    └── Browser — Waiting
```

The runtime remains authoritative. The UI derives presentation from Mission/task/session state rather than inventing a second lifecycle.

## 11. Intervention without changing mental models

While a Mission is active, the same workspace remains interactive.

The user may:

- give Chef a follow-up or redirect
- select a worker and message/intervene directly
- inspect a worker's terminal
- approve requested actions
- cancel/retry failed work

These are deeper controls around the same Mission, not separate applications.

## 12. Results stay in the workspace

Completion must visibly hand the result back to the user.

For code work, show when available:

- result/project location
- changed files or artifact summary
- run command
- verification performed
- open/inspect actions

For documents/research/spreadsheets, show the relevant durable artifact directly.

The user should never need to search the filesystem to discover whether Chef actually produced something.

## 13. Runtime detail is progressive disclosure

Runtime/debug detail remains intentionally powerful:

- raw sessions/PTY
- task IDs
- events
- context refs/scopes
- Decision Library
- Rooms/messages
- harness readiness
- provider/config details
- permissions/capabilities

But it is opened from the same product, and returning to the Living Workspace must preserve authoritative state.

## 14. Reliability rules

### 14.1 One runtime truth

Mission/task/session state is owned by the runtime. UI state may control presentation only.

### 14.2 No hidden parallel app trees

Do not mount inactive advanced trees behind CSS. Persistent SSE/PTY UI connections can exhaust browser connection capacity even when visually hidden.

Only the active depth mounts.

### 14.3 Active project is explicit

Every worker inherits the active project cwd. The UI must show that project/path before and during execution.

### 14.4 Observability cannot depend on the raw terminal being open

Useful progress must be visible from the Living Workspace.

### 14.5 Product journey outranks isolated green tests

A PR touching the canonical journey is not complete until the actual journey is coherent:

`open → project → request → acknowledgement → visible work → completion → result`

## 15. Acceptance criteria

### Casual user

A user unfamiliar with agents/harnesses must be able to:

1. open Chef
2. immediately know which project Chef will modify
3. describe an outcome
4. see that work started
5. understand which workers are involved
6. see useful progress without opening a terminal
7. respond if Chef needs attention
8. understand when work is done and where the result is

### Developer

A developer can additionally:

1. inspect the generated work topology
2. select a worker
3. open terminal/browser surfaces
4. intervene directly
5. reveal runtime details
6. return to the Living Workspace without losing Mission state

### Architecture

- no separate default `IntentHome` product surface
- Living Workspace is the fresh-session/default surface
- project path is visible in default UI
- meaningful Mission activity is visible without runtime detail
- advanced runtime tree is mounted only when requested
- no global Run button for ordinary Missions

## 16. Current implementation slice

The first implementation of this North Star should:

- remove the competing Home/Workbench top-level split
- make Living Workspace the canonical default surface
- make active project name/path explicit
- keep the existing intent composer as the main entry point
- expose useful Mission/worker activity in plain language
- keep artifacts/results in the same surface
- preserve advanced runtime capability behind Runtime details
- preserve the active-depth connection-budget protection

Follow-up iterations may improve:

- Thread/history navigation inside the Living Workspace
- structured Claude/worker progress adapters
- smarter worker routing/fallback
- concurrent worker scheduling policy
- stable docked terminal/browser surfaces

Those follow-ups extend the same product model rather than adding new top-level products.

## 17. Decision rule

When deciding where a capability belongs:

> **If it helps the user understand or steer the outcome, keep it in the Living Workspace. If it explains runtime internals, put it under Runtime details.**

When deciding who constructs the workflow:

> **Chef constructs the team. The user specifies the outcome.**

When deciding what the canvas means:

> **The canvas explains reality. It is not a prerequisite configuration form.**
