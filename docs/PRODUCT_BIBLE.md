# Chef — Product Bible

**Status:** Product north-star proposal  
**Purpose:** Define what Chef should become, how it should feel, what capabilities belong in the product, and how future implementation decisions should be judged.  
**Relationship to existing specs:** This document sits above `PRODUCT_RUNTIME_SPEC_V0.2.md`. The runtime spec defines product/runtime semantics; this Product Bible defines the broader product vision, experience, principles, feature families, roadmap, and decision framework.

---

## 0. The Short Version

Chef is a **living AI workspace** where people, agents, tools, files, context, and ongoing work coexist in one persistent visual environment.

The user should not feel like they are programming a workflow engine or operating a swarm framework. They should feel like they have opened a room where an AI team is already present, where work can be discussed, delegated, observed, interrupted, reviewed, resumed, and eventually automated.

The core loop is:

> **Human intent → Mission → Orchestrator → live agents and tools → shared context → artifacts and decisions → verified outcome**

And the core product mantra is:

> **A living workspace first. Missions when you want an outcome. Automations when you want repeatability.**

Chef should ultimately make multi-agent work feel as understandable and approachable as working with a good team in a shared room.

---

## 1. North Star

### 1.1 One-liner

**Chef is a visual AI workspace where a human can assemble, direct, and collaborate with a persistent team of AI agents and tools in real time.**

### 1.2 Product promise

A user should be able to:

1. Open Chef and immediately understand what exists in the workspace.
2. See which agents and tools are available, what they are doing, and what they know.
3. Give Chef a goal in plain language.
4. Let the Orchestrator coordinate suitable workers.
5. Watch meaningful progress without babysitting raw logs.
6. Jump into any worker, terminal, browser, artifact, or decision when desired.
7. Redirect work while it is happening.
8. Review what changed and why.
9. Close Chef and come back later without losing the workspace's state or history.
10. Turn useful repeated behavior into an Automation only when repeatability is actually needed.

### 1.3 Emotional goal

Chef should feel like:

- opening a studio, operations room, or engineering room that is already alive;
- having capable coworkers who are visible and reachable;
- being able to understand what the team is doing without understanding agent infrastructure;
- retaining control without needing to manually coordinate every step;
- building up institutional knowledge instead of starting every AI conversation from zero.

Chef should **not** feel like:

- wiring boxes together before anything can happen;
- configuring a DAG before talking to an AI;
- supervising a collection of opaque autonomous bots;
- reading terminal spam to determine whether work is progressing;
- rebuilding context every time an agent or app restarts.

---

## 2. What Chef Is — and What It Is Not

### Chef is

- a persistent AI workspace;
- a live control surface over an authoritative runtime;
- a place for direct human ↔ agent collaboration;
- a place for agent ↔ agent collaboration;
- an Orchestrator-led environment for goal-oriented Missions;
- a host for real tools and real agent harnesses;
- a durable context, artifact, event, decision, and memory system;
- an optional automation platform when deterministic repeatability is useful;
- local-first by default, with room to grow into shared/team workspaces later.

### Chef is not

- primarily a workflow builder;
- primarily an IDE;
- a proprietary replacement for Claude Code, Codex CLI, Pi, OMP, Aider, or future harnesses;
- an LLM chat wrapper with a graph painted around it;
- a system where every connection means execution order;
- a system where an LLM directly owns lifecycle, persistence, permissions, or scheduling;
- a black-box autonomous swarm where users lose track of who did what;
- a canvas whose geometry is the source of truth.

---

## 3. The Product Thesis

AI agents are becoming individually capable, but useful real-world work increasingly requires **coordination** rather than one more isolated chat session.

A strong agent can inspect code, research a topic, manipulate files, browse, run tools, or produce a report. The missing layer is the environment around the agent:

- who is responsible for what;
- what context each worker has;
- how workers communicate;
- which outputs are authoritative;
- how work survives restarts;
- how a human can observe and intervene;
- how failures are handled;
- how useful repeated behavior becomes reusable;
- how decisions and institutional knowledge accumulate over time.

Chef's opportunity is to become that environment.

The long-term moat is not any specific model. It is the **stateful coordination layer** around models and tools: identity, context, missions, artifacts, decisions, permissions, events, collaboration, observability, and durable workspace memory.

---

## 4. Primary Users and Jobs to Be Done

Chef should support different levels of technical sophistication without splitting into separate products.

### 4.1 Builder / Engineer

**Job:** "I want several capable agents and real tools to work on a software problem without me manually coordinating every handoff."

Needs:

- real terminal-native agents;
- project/repository context;
- inspectable tasks and plans;
- direct terminal access;
- testing and verification;
- artifacts and diffs;
- Git/GitHub integration;
- strong control over permissions and destructive actions;
- logs and event history when debugging.

### 4.2 Analyst / Researcher

**Job:** "I want agents to research, synthesize, compare, and produce durable outputs while keeping sources and reasoning traceable."

Needs:

- browser/research tools;
- file ingestion;
- source/artifact provenance;
- shared context;
- review checkpoints;
- reports and structured outputs;
- easy reuse of successful processes.

### 4.3 Operator / Knowledge Worker

**Job:** "I want to give Chef a business outcome and review the result without learning agent infrastructure."

Needs:

- Simple Mode;
- friendly templates;
- guided setup;
- plain-language progress;
- approvals;
- files and outputs rather than logs;
- minimal exposure to models, tokens, harnesses, PTYs, or graph semantics.

### 4.4 Power User / AI Operator

**Job:** "I want to configure my own team of agents, models, tools, permissions, context policies, and reusable Automations."

Needs:

- Power Mode;
- agent/harness configuration;
- model routing;
- context policy inspection;
- concurrency/cost controls;
- custom tools;
- reusable agent/team templates;
- observability and replay.

---

## 5. The Core Mental Model

Chef should be understandable through six concepts.

### 5.1 Workspace

A persistent place where people, agents, tools, files, context, Missions, Automations, artifacts, events, and decisions live together.

### 5.2 Presence

An agent or surface can exist in the workspace even when it is not actively consuming compute.

"Live" means **present, addressable, stateful, and inspectable**, not "always generating tokens."

### 5.3 Relationships

Connections indicate relationships such as communication, shared context, delegation, data access, dependency, or control.

Connections do **not** mean execution order unless the user explicitly chooses a dependency/control semantic.

### 5.4 Mission

A goal-oriented body of work created from human intent.

A Mission can evolve. The Orchestrator can plan, delegate, observe, retry, replan, request approval, verify, and report.

### 5.5 Artifact

A durable thing produced or consumed during work: a file, code change, report, finding, image, test result, dataset, plan, diff, or other referenceable output.

### 5.6 Automation

A repeatable executable process with explicit triggers, dependencies, retries, approvals, scheduling, and run history.

Automation is **optional** and should never redefine the entire workspace as a workflow graph.

---

## 6. The Experience Model

Chef should support three overlapping ways of working.

### 6.1 Direct interaction

The user opens an agent and talks to it directly.

Examples:

- ask a Research Agent a question;
- send a command to a coding agent;
- type in a Terminal;
- use a Browser;
- inspect a file or artifact;
- tell an agent to stop, reconsider, or explain itself.

No Mission or Automation is required for basic direct interaction.

### 6.2 Mission-driven work

The user gives Chef a goal:

> "Investigate why checkout is flaky and fix it."

Chef creates a Mission. The Orchestrator decides how to coordinate the available workspace.

The user sees:

- the Mission goal;
- current plan;
- active workers;
- meaningful progress;
- blockers;
- approvals;
- important decisions;
- artifacts;
- verification;
- final outcome.

### 6.3 Automation-driven work

The user wants repeatability:

> "Run this financial-close process every month."

Only here do explicit Run, Stop, Schedule, Trigger, Retry, and deterministic control-flow semantics become primary.

---

## 7. Product Pillars

### Pillar A — Living Presence

Chef should make agents and tools feel like persistent workspace participants rather than disposable function calls.

Feature direction:

- visible presence state;
- identity and role;
- current objective;
- availability / busy state;
- current Mission/task;
- recent activity;
- inbox / pending requests;
- direct conversation;
- wake/start, idle, reconnect, stop, and restore semantics;
- session history without conflating identity with process lifetime.

### Pillar B — Coordination

The Orchestrator should make multi-agent work coherent.

Feature direction:

- Mission planning;
- task decomposition;
- worker selection;
- delegation;
- handoffs;
- retries and replanning;
- dependency handling;
- concurrency management;
- verification;
- escalation;
- human approvals;
- final synthesis.

### Pillar C — Shared Context

Agents should share the **right** information, not every token ever generated.

Feature direction:

- Context Zones;
- reference-based context;
- source provenance;
- context previews;
- "why does this agent know this?" inspection;
- project decisions;
- contextual memory;
- agent-specific scopes;
- relevance ranking;
- context budgets;
- context handoff summaries.

### Pillar D — Durable Work

Useful work should survive process death, app restarts, model changes, and time.

Feature direction:

- artifacts;
- decisions;
- events;
- Mission history;
- task history;
- session history;
- artifact lineage;
- recover/resume;
- replay;
- checkpoints;
- long-lived project memory.

### Pillar E — Human Control

Autonomy should be observable and interruptible.

Feature direction:

- inspect any worker;
- direct intervention;
- pause/cancel;
- permissions;
- approval gates;
- clear responsibility;
- reversible actions where possible;
- visible destructive-operation boundaries;
- explanation of important Orchestrator decisions.

### Pillar F — Progressive Disclosure

Chef should remain casual-user friendly while retaining deep control for power users.

Feature direction:

- Simple Mode;
- Power Mode;
- friendly templates;
- plain-language status;
- expandable technical details;
- same runtime underneath both modes;
- no separate "beginner product" and "expert product."

### Pillar G — Reusability

Useful patterns should become reusable without forcing users into workflow-authoring mode from day one.

Feature direction:

- workspace templates;
- agent/team templates;
- Mission recipes;
- Automation extraction;
- reusable Context Zones;
- saved tool configurations;
- organization-level templates later.

---

## 8. The Canvas

The canvas is the visual center of gravity, but it is not the source of truth.

Its job is to answer, at a glance:

- Who and what is here?
- Who is working?
- What is connected?
- What context is shared?
- What Mission is active?
- Where are the outputs?
- Is anything blocked?
- Where does the user need to intervene?

### 8.1 Canvas objects

Primary visible object families:

- Agents;
- Orchestrator;
- Terminal;
- Browser;
- File / Data;
- Tool / Integration;
- Human / Approval;
- Artifact / Output;
- Context Zone;
- Mission surface;
- Automation surface;
- advanced Control nodes where appropriate.

### 8.2 Canvas interactions

The canvas should eventually support:

- drag/drop nodes;
- spatial organization;
- persisted positions;
- grouping into Context Zones;
- typed connections;
- direct node messaging;
- quick-create via command palette;
- multi-select and group operations;
- zoom from workspace overview into individual work;
- follow-active-worker mode;
- Mission highlighting;
- visual handoff animation/event indication;
- collapse/expand groups;
- inspect lineage between artifacts and workers.

### 8.3 What the canvas must avoid

- looking like an n8n clone by default;
- requiring edges before agents can work;
- turning every spatial relationship into runtime execution semantics;
- overwhelming casual users with ports, schemas, and graph jargon;
- pretending something is live when only a static frontend state exists.

---

## 9. Agent Presence

Presence is one of the most important future differentiators.

Every agent should eventually have a compact answer to:

- Who are you?
- What role do you have?
- What are you currently responsible for?
- Are you available?
- What are you working on?
- What do you need?
- What did you recently produce?
- Which context can you see?
- Which tools are available to you?
- Which Mission are you participating in?

### 9.1 Suggested agent states

- Offline
- Starting
- Idle
- Thinking
- Working
- Waiting
- Needs Input
- Waiting for Approval
- Blocked
- Failed

### 9.2 Identity vs session

An Agent is a persistent identity.

A Session is an execution instance.

The UI should never teach users that an agent disappears merely because a CLI process exited.

### 9.3 Agent home / profile

Future agent configuration should include:

- name;
- icon/avatar;
- role;
- description;
- preferred harness;
- model/provider preference;
- capabilities;
- permissions;
- default tools;
- default context policy;
- working style / instructions;
- concurrency limits;
- cost preferences;
- optional memory scope.

---

## 10. Orchestrator

The Orchestrator is Chef's primary coordination intelligence.

It should feel like a capable lead, not a chatbot glued to a Run button.

### 10.1 Responsibilities

- understand intent;
- inspect workspace state;
- identify usable existing agents/tools;
- decide whether a Mission is needed;
- decompose goals;
- assign work;
- coordinate handoffs;
- monitor progress;
- resolve failures;
- replan;
- request approval;
- verify completion;
- produce concise progress updates;
- preserve important decisions and artifacts.

### 10.2 Orchestrator visibility

Chef should let users choose how much orchestration detail they see:

**Simple:**

> "Researching the issue → implementing a fix → verifying tests."

**Power:**

- task graph;
- worker assignment;
- plan revisions;
- dependency state;
- context references;
- messages;
- events;
- retry reasons;
- verification criteria.

### 10.3 Orchestrator rule

> **LLMs decide; the runtime validates and executes.**

No model should silently mutate authoritative state outside runtime-owned APIs and policy.

---

## 11. Missions

Mission should become Chef's main goal-oriented product primitive.

### 11.1 Mission anatomy

A Mission should eventually expose:

- title;
- human goal;
- success criteria;
- status;
- active plan;
- workers;
- tasks;
- blockers;
- approvals;
- artifacts;
- decisions;
- verification state;
- timeline;
- final result;
- follow-up actions.

### 11.2 Mission lifecycle

Suggested lifecycle:

`Planning → Active → Waiting / Blocked / Approval → Verifying → Completed`

with side exits:

`Cancelled` or `Failed`.

### 11.3 Mission control

Users should be able to:

- pause;
- resume;
- redirect;
- cancel;
- add requirements;
- remove scope;
- assign a specific worker;
- ask for a second opinion;
- request stronger verification;
- approve/deny privileged steps;
- continue a completed Mission with a follow-up.

### 11.4 Mission history

A Mission should remain understandable after completion.

Someone opening it later should be able to answer:

- What was requested?
- What plan was followed?
- Who did what?
- What changed?
- Which artifacts were produced?
- Which decisions were made?
- What failed or was retried?
- How was success verified?

---

## 12. Agent-to-Agent Collaboration

Chef should make collaboration explicit and inspectable rather than hiding it inside one giant prompt.

### 12.1 Structured messaging

Agents should communicate through platform-owned structured messages/events when appropriate.

Examples:

- request;
- response;
- finding;
- result;
- question;
- delegation;
- artifact reference;
- escalation;
- review feedback;
- status update.

### 12.2 Handoffs

A handoff should eventually show:

- sender;
- receiver;
- reason;
- summary;
- referenced artifacts/context;
- expected outcome;
- completion/result.

### 12.3 Channels / rooms

The existing message channel concept can evolve into lightweight shared rooms:

- `#general`
- `#frontend`
- `#backend`
- `#research`
- `#review`
- Mission-specific channels

Channels should remain projections over durable messages/events rather than becoming the system of record.

### 12.4 Collaboration visualization

The canvas can show meaningful communication without becoming visual noise:

- recent edge pulse;
- unread badge;
- handoff marker;
- pending request;
- artifact transfer;
- collapsed communication history on demand.

---

## 13. Context Zones and Shared Context

Context Zones are a visual and runtime primitive for defining a shared contextual world.

### 13.1 Context Zone examples

- Project Context;
- Checkout Bug Mission;
- Monthly Financial Close;
- Research Room;
- Customer X;
- Release 2.0;
- Frontend Team.

### 13.2 Zone contents

A zone may make selected references available to members:

- files;
- artifacts;
- decisions;
- messages;
- relevant events;
- instructions;
- datasets;
- source material;
- memory summaries.

### 13.3 Context visibility

Users should eventually be able to inspect:

> **"What does this agent currently know, and why?"**

This is a major trust feature.

Useful UI:

- current context refs;
- source scope;
- relevance reason;
- inherited zone;
- task-specific additions;
- estimated context size;
- stale/outdated context warnings.

### 13.4 Context is not memory dumping

Zone membership must not mean copying every event, conversation, and file into every prompt.

Context should remain:

- reference-based;
- scoped;
- relevance-ranked;
- selectively materialized;
- inspectable.

---

## 14. Memory and Decisions

Chef should become more useful the longer a workspace exists.

### 14.1 Durable decisions

Important conclusions should be saved as first-class decisions:

- architecture choices;
- constraints;
- user preferences;
- accepted tradeoffs;
- rejected approaches;
- business rules;
- lessons learned;
- unresolved questions.

### 14.2 Project memory

Future memory should not be a mysterious vector store.

It should have inspectable categories such as:

- Decisions;
- Requirements;
- Known Facts;
- Conventions;
- Lessons;
- Open Questions;
- Reusable Procedures.

### 14.3 Memory maintenance

The Orchestrator may propose:

- promoting a finding to a durable decision;
- superseding an old decision;
- marking information stale;
- summarizing completed Mission history;
- extracting a reusable procedure.

The runtime should preserve provenance.

---

## 15. Artifacts and Provenance

Artifacts should feel like shared work products, not random attachments buried in chat.

### 15.1 Artifact shelf

Every workspace and Mission should have an inspectable artifact collection.

Examples:

- source file;
- generated report;
- code patch;
- branch/commit;
- research note;
- test output;
- screenshot;
- browser finding;
- table/dataset;
- exported PDF;
- final deliverable.

### 15.2 Artifact metadata

Users should be able to inspect:

- creator;
- creation time;
- Mission/task;
- version;
- source/provenance;
- consumers;
- related decisions;
- verification status.

### 15.3 Lineage

Long-term, Chef should support visual artifact lineage:

`source → analysis → finding → implementation → verification → final output`

This makes agent work auditable and understandable.

---

## 16. Human Approval, Permissions, and Trust

Chef must preserve human agency even as autonomy increases.

### 16.1 Permission model

Permissions should be capability-based and explicit.

Examples:

- filesystem;
- terminal;
- network;
- browser;
- Git;
- GitHub;
- deploy;
- spawn agents;
- assign tasks;
- external communication;
- destructive operations.

### 16.2 Approval experience

Approval requests should explain:

- what action is requested;
- which agent requested it;
- why it is needed;
- what scope is affected;
- what could go wrong;
- whether the action is reversible.

### 16.3 Autonomy levels

Future Chef could expose understandable autonomy presets:

- **Ask often** — approval before meaningful side effects;
- **Balanced** — trusted local actions proceed, privileged actions ask;
- **Hands-off** — broad autonomy within an explicit sandbox/policy.

Power users can override individual capabilities.

---

## 17. Observability Without Log Babysitting

Chef should separate **meaningful progress** from raw operational detail.

### 17.1 Simple activity

Show events like:

- "Research Agent found likely root cause."
- "Code Agent is implementing the fix."
- "Verification failed: 2 tests still failing."
- "Chef reassigned verification."
- "Approval needed before pushing to GitHub."

### 17.2 Power observability

Expose:

- runtime events;
- terminal output;
- structured messages;
- context refs;
- tool calls;
- task transitions;
- retries;
- session lifecycle;
- permissions;
- model/provider;
- tokens/cost when available.

### 17.3 Replay

Replay should answer:

- what happened;
- in what order;
- who caused it;
- what context was involved;
- what changed;
- why the next step happened.

It does not require deterministic reproduction of identical LLM output.

---

## 18. Simple Mode and Power Mode

These are two disclosure levels over the same runtime.

### 18.1 Simple Mode

The user sees:

- people-like roles;
- goals;
- progress;
- files;
- outputs;
- approvals;
- clear status;
- templates;
- Chef conversation.

Avoid exposing:

- PTY;
- harness;
- context bus;
- raw event types;
- model temperature;
- provider details;
- graph port semantics;
- runtime IDs.

### 18.2 Power Mode

The user may inspect and configure:

- models/providers;
- harness/session state;
- terminal streams;
- tools;
- context references;
- task dependencies;
- typed edges;
- permissions;
- event logs;
- costs/tokens;
- retries;
- Automation control flow.

### 18.3 Mode switch rule

Switching mode must never rebuild or fork workspace state.

---

## 19. Templates and Onboarding

The best first experience is not an empty canvas.

### 19.1 Template categories

- Developer Fix & Verify;
- Repository Review;
- Research & Brief;
- Monthly Financial Report;
- Data Cleanup & Analysis;
- Competitive Research;
- Content Production;
- Release Readiness;
- Customer Investigation;
- Incident Investigation.

### 19.2 Template behavior

A template may create:

- suggested agents;
- tools;
- Context Zones;
- permissions;
- starter files;
- an optional Mission recipe;
- an optional Automation.

The user should be able to customize it naturally after creation.

### 19.3 Empty-state onboarding

Chef should ask an outcome-oriented question such as:

> "What are we working on?"

rather than:

> "Choose a node type."

---

## 20. Automations

Automations are important, but they must remain conceptually separate from the living workspace.

### 20.1 When Automation is appropriate

- repeated report generation;
- scheduled research;
- recurring repository maintenance;
- ingestion pipelines;
- release checks;
- document generation;
- deterministic business processes;
- repeated approval flows.

### 20.2 Automation-specific concepts

- Trigger;
- Schedule;
- Run;
- Stop;
- Retry;
- Dependency;
- Condition;
- Loop;
- Approval;
- Error path;
- execution history.

### 20.3 Extracting an Automation from work

A compelling future feature:

> After a successful Mission, Chef can suggest: **"This looks repeatable. Save it as an Automation?"**

This lets automation emerge from useful work instead of forcing workflow design up front.

---

## 21. Tools, Integrations, and Harnesses

Chef should be open to heterogeneous agents and tools.

### 21.1 Harness philosophy

Do not reimplement capable external agents unnecessarily.

Chef should host or coordinate:

- Claude Code;
- Codex CLI;
- Pi;
- OMP;
- Aider;
- generic terminal agents;
- local models;
- future remote agents.

### 21.2 Tool categories

- Terminal;
- Filesystem;
- Browser;
- Git;
- GitHub;
- MCP;
- database;
- spreadsheets;
- documents;
- APIs;
- monitoring;
- communication systems;
- custom tools.

### 21.3 Integration rule

MCP and third-party tools are capability layers. They do not replace Chef's orchestration, state, context, permission, event, or Mission semantics.

---

## 22. Economics and Resource Awareness

Chef should eventually make resource use understandable without turning every interaction into a billing dashboard.

Possible capabilities:

- per-Mission cost estimate;
- per-agent token/cost usage;
- model routing preferences;
- budget caps;
- concurrency caps;
- "fast / balanced / thorough" Mission preference;
- local-model preference;
- stop conditions for runaway work;
- cost-aware Orchestrator planning.

Simple Mode should communicate these in human terms. Power Mode can expose raw metrics.

---

## 23. Notifications and Attention Management

Chef should notify users based on **attention required**, not every event.

Useful attention states:

- approval required;
- blocked and needs user input;
- Mission completed;
- Mission failed;
- unexpected cost/budget threshold;
- external side effect pending;
- important worker question;
- Automation failure.

The product should actively avoid notification spam from normal internal agent chatter.

---

## 24. Multi-Human Collaboration — Later, Not Required for Core Chef

The architecture should leave room for shared workspaces.

Potential future capabilities:

- multiple human collaborators;
- presence/cursors;
- comments;
- review assignments;
- approval routing;
- workspace roles;
- shared organization templates;
- audit history;
- remote runtime/worker hosting.

This is strategically useful, but the single-human + AI-team experience should become excellent first.

---

## 25. Current Baseline

The current repository already establishes much of the runtime foundation needed for this direction:

- persistent workspaces, tasks, sessions, messages, events, artifacts, and decisions;
- Mission-oriented Orchestrator flow;
- terminal-native harness support;
- direct worker interaction;
- approvals and permissions;
- live event subscription and replay;
- Simple and Power UI modes;
- live canvas projection;
- Context Zones;
- Chat with Chef;
- deterministic Automations as a separate concept;
- tool runner, browser capability, MCP clients, and specialized harness adapters.

Known baseline gaps include:

- current canvas implementation still uses an SVG projection rather than the intended React Flow / XYFlow interaction model;
- hierarchical squads remain future work;
- channel/room UI is not yet surfaced;
- full context hierarchy is not yet exposed;
- long-term project memory is still shallow;
- artifact lineage and deep Mission UX are still immature;
- some Power Mode configuration persistence remains incomplete.

The next product phase should therefore focus less on adding random backend capability and more on making the **living-workspace model undeniable in the user experience**.

---

## 26. Recommended Feature Roadmap

This roadmap is product-priority oriented, not a commitment to exact engineering sequencing.

### Phase A — Make the Living Workspace Feel Real

**Goal:** The user opens Chef and immediately understands that agents and tools are present and usable.

Priorities:

1. React Flow / XYFlow canvas migration.
2. Persisted node position and layout.
3. Proper Agent cards with presence state and current responsibility.
4. Context Zone interaction polish.
5. Typed relationship edges with understandable visual language.
6. Direct node conversation/action affordance.
7. Clear distinction between Agent identity and Session lifecycle.
8. Workspace restoration that visibly reconstructs prior state.
9. Better empty state and quick-create flow.
10. Remove any remaining workflow-runner framing from the default workspace.

**Success test:** A new user can open Chef, add an agent, talk to it, add a tool, group context, and understand current activity without learning workflow terminology.

### Phase B — Make Missions the Center of Goal-Oriented Work

**Goal:** Giving Chef an outcome becomes the best way to coordinate complex work.

Priorities:

1. First-class Mission panel/surface.
2. Mission goal + success criteria.
3. Plan visualization.
4. Worker roster.
5. Mission timeline.
6. Blocker and approval presentation.
7. Redirect/pause/resume controls.
8. Verification state.
9. Final outcome summary.
10. Follow-up / continue Mission.
11. Mission-scoped artifacts and decisions.
12. Better Orchestrator progress summarization.

**Success test:** A user can hand Chef a non-trivial goal, leave it working, return, and understand exactly what happened without reading raw logs.

### Phase C — Make Collaboration Visible

**Goal:** Multi-agent work should look and feel like collaboration, not hidden parallel prompts.

Priorities:

1. Structured agent inbox/outbox UI.
2. Handoff visualization.
3. Communication edge activity.
4. Agent questions / pending requests.
5. Lightweight channels/rooms.
6. Review requests between agents.
7. "Second opinion" action.
8. Clear delegation ownership.
9. Shared artifact references.

**Success test:** A user can explain who asked whom for what and how a result moved through the team.

### Phase D — Make Context and Memory a Product Feature

**Goal:** Chef becomes smarter over time while remaining inspectable.

Priorities:

1. "What this agent knows" inspector.
2. Context provenance.
3. Context scope inheritance.
4. relevance ranking / budget controls.
5. durable project memory categories.
6. decision promotion and supersession.
7. Mission summarization into memory.
8. stale-context warnings.
9. context handoff summaries.

**Success test:** Users trust context sharing because they can inspect where information came from and correct it.

### Phase E — Artifacts, Review, and Verification

**Goal:** The work product becomes as important as the chat.

Priorities:

1. Artifact shelf.
2. Mission artifact collection.
3. previews.
4. version history.
5. provenance.
6. artifact lineage.
7. review status.
8. verification evidence.
9. diff-aware code artifacts.
10. export/delivery actions.

**Success test:** A completed Mission leaves behind an understandable set of durable outputs rather than a transcript.

### Phase F — Reusable Teams and Automations

**Goal:** Successful patterns become reusable without turning Chef into a workflow builder.

Priorities:

1. save Agent configuration as template;
2. save team/workspace template;
3. Mission recipes;
4. extract successful Mission into Automation;
5. schedules/triggers;
6. run history;
7. versioned Automation definitions;
8. Automation failure recovery;
9. template marketplace/library direction.

**Success test:** Repetition becomes easy after users discover useful patterns organically.

### Phase G — Extensibility and Ecosystem

**Goal:** Chef becomes a durable host for heterogeneous agents and capabilities.

Priorities:

1. harness plugin SDK;
2. tool/plugin SDK;
3. capability discovery;
4. agent capability metadata;
5. custom node definitions;
6. organization template packs;
7. remote worker protocol;
8. sandbox/container execution;
9. local model routing;
10. integration management UI.

### Phase H — Shared / Team Chef

**Goal:** Move from "one human with an AI team" to "human teams working with AI teams."

Potential scope:

- shared workspace;
- multi-human presence;
- roles;
- approval routing;
- review ownership;
- remote runtime;
- organization policy;
- audit and compliance;
- shared memory/template governance.

This should follow a strong single-user product rather than precede it.

---

## 27. Feature Backlog — Candidate Ideas

These are candidates, not commitments.

### Workspace

- Workspace home / recents
- Search everything
- Command palette
- Workspace snapshots/checkpoints
- Duplicate/fork workspace
- Workspace activity digest
- Workspace health / blockers

### Agents

- Agent profile cards
- Role presets
- Agent inbox
- Availability indicator
- Persistent identity
- Preferred model/harness
- Capability badges
- "Ask this agent" quick action
- Duplicate agent
- Save agent as template
- Compare two agents' proposals
- Temporary specialist spawn

### Orchestrator

- Planning mode
- Ask-before-execute toggle
- Thoroughness slider
- Cost/budget policy
- Worker-selection explanation
- Replan history
- Escalation policy
- Verification policy
- User-defined standing instructions

### Missions

- Mission dashboard
- Mission timeline
- Success criteria checklist
- Mission notes
- Pause/resume
- Redirect
- Add worker
- Remove worker
- Ask for second opinion
- Stronger verification
- Follow-up Mission
- Mission clone
- Mission retrospective

### Context

- Context Zone templates
- Context inspector
- Source provenance
- Context diff
- Pin context
- Exclude context
- Context freshness indicator
- Relevance score
- Context budget
- Context inheritance map

### Artifacts

- Artifact shelf
- Preview
- Versioning
- Approval/review state
- Lineage graph
- "Produced by" / "Used by"
- Download/export
- Promote to workspace reference
- Compare versions

### Collaboration

- Agent channels
- Handoff cards
- Mention agent
- Request review
- Agent questions
- Shared notes
- Threaded discussions

### Automations

- Extract from Mission
- Scheduled trigger
- Webhook trigger
- File-change trigger
- Manual run
- Run history
- Test/dry-run
- Versioning
- Environment variables/secrets
- Failure policy
- Approval steps
- Retry policy

### Trust and Safety

- Permission presets
- Per-agent permissions
- Sandbox profiles
- Audit log
- Destructive action preview
- Approval routing
- Secret management
- Network allowlist
- Spending caps

### Developer Experience

- Git worktree support
- Branch awareness
- PR artifact
- Test result artifact
- Diff review surface
- Repository map/context
- terminal multiplexing
- dev-server process surfaces
- CI integration

### Non-Developer Experience

- Spreadsheet preview
- document/report preview
- structured table artifacts
- file-import wizard
- output delivery
- business templates
- review/approval workflow without technical terminology

---

## 28. Prioritization Rules

When choosing what to build next, prefer features that strengthen more than one of these:

1. **Presence** — makes the workspace feel alive.
2. **Comprehension** — helps users understand what is happening.
3. **Control** — helps users intervene safely.
4. **Durability** — preserves useful work/state.
5. **Coordination** — improves multi-agent outcomes.
6. **Reuse** — turns successful work into future leverage.
7. **Approachability** — lowers technical knowledge required.

Be suspicious of features that mostly increase configuration surface without improving the user's outcome.

---

## 29. Product Guardrails

### Always

- Keep runtime state authoritative.
- Preserve direct worker access.
- Make privileged actions auditable.
- Keep context selective and inspectable.
- Treat artifacts and decisions as durable product objects.
- Separate identity from process/session lifetime.
- Preserve Simple/Power as disclosure levels over one runtime.
- Make failure visible and recoverable.
- Prefer existing agents/tools before spawning needless workers.
- Make meaningful progress legible without requiring log reading.

### Never

- Reintroduce a dominant global Run button on the living workspace.
- Treat every edge as a DAG dependency.
- Require users to build a graph before talking to an agent.
- Allow spatial canvas geometry to become runtime truth.
- Make an LLM the sole authority for permissions or lifecycle.
- Hide destructive actions behind vague autonomy.
- Dump full histories into every agent context by default.
- Fork Simple Mode into a separate weaker execution system.
- Build features merely because other node editors have them.

---

## 30. Success Metrics

Early product metrics should focus on whether Chef actually improves coordinated work.

Possible measures:

### Activation

- time from workspace creation to first useful agent interaction;
- time to first completed Mission;
- percentage of users completing a Mission without reading documentation;
- percentage of template starts that reach a useful output.

### Coordination quality

- Mission completion rate;
- percentage requiring manual rescue;
- average number of useful handoffs;
- retry/replan rate;
- verification pass rate;
- number of failed Missions with understandable root cause.

### Human control

- approval response success;
- cancellation reliability;
- percentage of users able to identify current worker/responsibility;
- frequency of direct intervention that preserves Mission coherence.

### Durability

- successful restore after restart;
- Mission/artifact retrieval after days/weeks;
- reuse of prior decisions/context;
- repeated Mission converted into reusable template/Automation.

### Product comprehension

Qualitative test:

> After five minutes, can a user explain the difference between a Workspace, Agent, Mission, Context Zone, Artifact, and Automation?

If not, the product model is still too confusing.

---

## 31. "Does This Feel Like Chef?" Acceptance Test

A feature or design is aligned with Chef when the answer to most of these is yes:

- Does it make the workspace feel more alive?
- Does it make agents easier to understand as participants?
- Does it improve human control rather than reduce it?
- Does it strengthen durable state/context/artifacts?
- Does it make coordination visible?
- Can a casual user benefit without learning runtime jargon?
- Can a power user inspect the underlying detail?
- Does it work without pretending the canvas is the execution engine?
- Does it preserve heterogeneous agent/tool support?
- Does it help users achieve outcomes rather than configure infrastructure?

If a feature makes Chef look more like a generic workflow builder but does not improve these qualities, it should probably not be prioritized.

---

## 32. Open Product Questions

These should remain explicit rather than being accidentally decided by implementation.

1. How autonomous should the Orchestrator be by default?
2. Should Missions always be explicit objects, or can very small intents remain direct chat actions?
3. How much of the Orchestrator's plan should Simple Mode expose?
4. How should Context Zone membership interact with task-specific context?
5. What is the best UX for an agent that has identity but no active process/session?
6. How should Chef represent multiple concurrent Missions in one workspace?
7. When should Chef suggest spawning a new specialist vs reusing an idle agent?
8. What should be considered durable memory vs ordinary historical events?
9. When should Chef suggest extracting an Automation from completed work?
10. What is the right abstraction for remote agents/workers later?
11. Which surfaces belong directly on the canvas vs in docked panels?
12. How should token/cost controls appear without distracting casual users?
13. Should channels become a major UI surface or remain lightweight collaboration metadata?
14. How much visual motion is helpful for live collaboration before it becomes distracting?
15. What is the smallest delightful non-developer workflow that proves Chef is broader than an AI coding tool?

---

## 33. Near-Term Recommended Implementation Sequence

If product work resumes immediately after this Bible, the recommended order is:

1. **React Flow / XYFlow living canvas migration** with persisted layout.
2. **Agent Presence Card v1**: identity, role, live status, current responsibility, direct-open action.
3. **Mission Surface v1**: goal, plan, workers, progress, blockers, approvals, result.
4. **Context Inspector v1**: what this agent sees and which zone/task supplied it.
5. **Artifact Shelf v1** scoped to workspace and Mission.
6. **Agent handoff/message visibility** with lightweight communication activity.
7. **Mission controls**: pause, resume, redirect, cancel, second opinion.
8. **Durable memory/decision UX** rather than only backend storage.
9. **Automation extraction prototype** from a successful Mission.
10. **Channel/room experiment** only after direct handoffs and Mission UX are understandable.

This sequence intentionally prioritizes **product legibility and presence** over adding more backend primitives that users cannot yet feel.

---

## 34. Final Product Mantras

> **The runtime is the product. The canvas is the live window into it.**

> **The workspace is alive; execution is not gated by Run.**

> **Agents are participants, not boxes in a DAG.**

> **Context should be shared deliberately, not dumped blindly.**

> **Artifacts, decisions, and events outlive any model or session.**

> **Human intent creates Missions. Repeated behavior becomes Automation.**

> **Simple and Power are two views of the same truth.**

> **LLMs decide; the runtime validates and executes.**

> **Chef should make an AI team feel understandable, persistent, and controllable.**

---

## 35. Decision Rule for Future PRs

Every significant product PR should be able to answer:

1. Which Product Bible pillar does this strengthen?
2. Which user problem does it solve?
3. Does it preserve the living-workspace mental model?
4. Does it introduce a new authoritative state concept? If yes, where does that state live?
5. How is the feature observable and recoverable?
6. How does Simple Mode present it?
7. How does Power Mode inspect it?
8. What happens after restart?
9. What permissions or approvals does it require?
10. What acceptance test proves it behaves like Chef rather than a static UI mock?

If those questions cannot be answered, the feature probably needs more product definition before implementation.
