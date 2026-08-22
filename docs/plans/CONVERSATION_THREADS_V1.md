# Conversation Threads V1

**Status:** active implementation plan  
**Product context:** Chef project continuity / Mission UX  
**Relationship:** follow-up foundation after `MISSION_EXECUTION_ROUTING_V1.md`

## Goal

Add a durable conversation/thread layer so one Chef project can contain multiple coherent work streams without collapsing every user message into one workspace-global chat log.

The target hierarchy is:

```text
Project / Workspace
  ↓
Thread
  ↓
Mission
  ↓
Plan
  ↓
Task
  ↓
Worker Session
```

Terminology is intentional:

- **Thread** = conversation continuity / work stream.
- **Mission** = one concrete goal Chef executes.
- **Task** = one unit of Mission work.
- **Session** = one worker execution instance / PTY process.

Do not reuse `Session` for conversations. `Session` already has an execution meaning in the runtime.

## Current failure mode

Chef currently has no first-class conversation identity.

Chat persistence uses one hard-coded workspace channel:

```text
channel = "chat"
```

`GET /api/chat/messages` returns the entire workspace chat history and `POST /api/chat` accepts only a message. There is no `threadId` / `conversationId` boundary.

Each call to `handleChatMessage()` also creates a new Mission immediately and proposes a plan using the current user message as the goal. Previous chat turns are persisted but are not assembled into the next planning context.

Effective behavior today:

```text
Project A
└── one workspace-global chat
    ├── "Build feature A"        → Mission 1
    ├── "Change the button"      → Mission 2 with little conversational continuity
    ├── "Build feature B"        → Mission 3
    └── "Continue what we did"   → Mission 4 with ambiguous prior context
```

This causes two product problems:

1. unrelated work streams pollute the same chat history;
2. related follow-up turns do not have an explicit durable continuity boundary.

## Target mental model

A project contains many Threads. A Thread contains conversational history and can create multiple Missions over time.

Example:

```text
Project: chef
│
├── Thread: "Authentication"
│   ├── user/assistant messages
│   ├── Mission 1: implement sign-in
│   ├── Mission 2: add forgot-password flow
│   ├── Mission 3: fix reset-email regression
│   ├── relevant artifacts
│   └── relevant decisions
│
├── Thread: "Dashboard redesign"
│   ├── messages
│   ├── Mission 4
│   └── Mission 5
│
└── Thread: "Investigate flaky tests"
    ├── messages
    └── Mission 6
```

One Thread is **not** one Mission.

A follow-up user request can either:

- start a new Mission in the current Thread;
- redirect/revise an active Mission when that is semantically appropriate;
- ask a conversational question without spawning execution work.

The Orchestrator remains responsible for choosing which action is appropriate. The runtime remains authoritative for state changes.

## Context layers

Thread support must preserve three distinct context scopes:

### 1. Project context

Facts broadly true across the project:

- repository structure;
- architecture decisions;
- durable project memory;
- coding conventions;
- user/project preferences;
- reusable artifacts and decisions.

### 2. Thread context

Facts relevant to the current work stream:

- recent conversation turns;
- rolling Thread summary;
- Missions created in this Thread;
- Thread-linked artifacts;
- Thread-linked decisions;
- explicit context references.

### 3. Mission context

Facts specific to one executable goal:

- current goal;
- Plan / Task graph;
- worker assignments;
- live execution state;
- Mission artifacts;
- verification result.

A new Thread inherits project context but not arbitrary history from other Threads.

## Durable model

Introduce a first-class `Thread` entity.

Suggested V1 contract:

```ts
export type ThreadId = string;

export type ThreadStatus = "active" | "archived";

export interface Thread {
  id: ThreadId;
  workspaceId: WorkspaceId;
  title: string;
  status: ThreadStatus;
  summary?: string;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

Add `threadId` to conversational and goal-oriented records where continuity matters:

```ts
AgentMessage.threadId?: ThreadId
Mission.threadId?: ThreadId
```

V1 should avoid placing `threadId` on low-level execution records such as Session. Session can resolve its Thread transitively through Task → Mission → Thread.

Artifacts and Decisions do not require a mandatory physical `thread_id` column in V1 if they are already linked to Mission/Task. A query/helper can resolve Thread lineage through those relations. Add direct Thread linkage only where it materially simplifies retrieval and provenance.

## Thread lifecycle

Minimum lifecycle:

```text
create
  ↓
active
  ↓
rename / update summary / continue work
  ↓
archive
```

Deleting Threads is intentionally deferred. Archive is safer because Mission, Decision, Artifact, and event history should remain durable.

A workspace should always have at least one usable Thread in the UI.

## Existing data migration

Existing workspace-global `channel="chat"` history must remain visible after migration.

On migration / first startup after Thread support:

1. create one default Thread for any workspace that has old chat messages and no Thread;
2. title it conservatively, e.g. `Previous work` or derive a title only if deterministic;
3. assign legacy chat messages to that Thread;
4. assign existing chat-created Missions when a reliable relationship exists;
5. do not invent relationships between historical Missions and messages when provenance is ambiguous.

Migration must be idempotent.

## HTTP/API target

Prefer explicit Thread-scoped routes rather than overloading the old global chat API indefinitely.

Suggested V1 API:

```text
GET    /api/threads
POST   /api/threads
GET    /api/threads/:threadId
PATCH  /api/threads/:threadId
POST   /api/threads/:threadId/archive

GET    /api/threads/:threadId/messages
POST   /api/threads/:threadId/chat
GET    /api/threads/:threadId/chat/stream
```

Possible request:

```json
POST /api/threads/:threadId/chat
{
  "message": "Keep email/password login too"
}
```

The runtime must validate that the Thread belongs to the active Workspace.

The old `/api/chat*` surface may remain temporarily as a compatibility alias to the workspace's default/current Thread. It should not remain the canonical API after V1.

## Planning context assembly

Do not solve continuity by dumping the entire Thread transcript into every LLM call.

V1 context assembly should use a bounded hybrid:

```text
current user turn
+ recent Thread messages (verbatim, bounded)
+ rolling Thread summary
+ recent/relevant Missions in this Thread
+ relevant Artifact / Decision references
+ project context references
```

Suggested new planning context shape:

```ts
interface PlanProposalContext {
  workspaceId: WorkspaceId;
  threadId?: ThreadId;
  goal: string;
  recentMessages?: ThreadMessageContext[];
  threadSummary?: string;
  relatedMissions?: MissionContext[];
  contextRefs?: ContextReference[];
  events?: RuntimeEvent[];
  availableWorkers?: AvailableWorker[];
}
```

Thread history is context, not authority. The runtime validates all proposed execution actions exactly as it does today.

## Rolling Thread summary

V1 should support a durable summary field so long Threads remain useful without unbounded prompt growth.

Rules:

- summary is advisory context, not authoritative state;
- recent messages remain verbatim and take precedence over summary text;
- update the summary after meaningful completed turns/Missions, not on every token/event;
- summary generation failure must not block the Thread or Mission;
- summary must not silently overwrite explicit durable Decisions.

A deterministic/basic summarizer may be used first. LLM-generated rolling summaries can follow if provider cost/latency is acceptable.

## Chat turn semantics

Thread support should not preserve the current assumption that **every user message must create a Mission**.

The desired Orchestrator decision is conceptually:

```text
new Thread message
  ↓
classify intent in Thread context
  ├── conversational response only
  ├── create new Mission
  ├── redirect/revise active Mission
  └── request approval / clarification when genuinely required
```

However, do not build a second unconstrained LLM control plane just for classification. V1 may keep "execution-oriented message creates a Mission" behavior while the Thread data model/context boundary lands, then add explicit turn-intent routing in a follow-up slice.

The important V1 invariant is that a new Mission is linked to the correct Thread and planned with bounded Thread context.

## UI target

Thread navigation should make work streams obvious without turning Chef into a generic chat app.

Suggested left-side project navigation:

```text
CHEF
chef/
────────────────────────
+ New thread

Recent
● Add authentication
  active mission

○ Dashboard redesign
  2 missions

○ Flaky test investigation
  completed
```

Selecting a Thread changes the work lens:

- chat shows only that Thread's messages;
- Mission/progress UI prioritizes Missions from that Thread;
- canvas can focus/highlight Thread-relevant nodes while retaining access to the project-global workspace;
- artifacts/decisions can be filtered to the Thread where lineage is known.

Do not duplicate a separate canvas per Thread in V1. The canvas remains project/workspace durable state; Thread is a contextual lens over it.

## Naming

Thread title creation should be simple and predictable.

V1 order:

1. explicit user rename wins;
2. initial title may derive from the first user message using a short deterministic truncation;
3. optional LLM title generation is deferred unless it adds clear value.

Avoid mysterious automatic renaming after the user has edited a title.

## Realtime behavior

Chat SSE events must carry `threadId` so multiple Thread views cannot consume each other's events accidentally.

Example event payloads:

```text
chat.user        { threadId, content, ... }
chat.plan.*      { threadId, missionId, planId, ... }
chat.assistant   { threadId, content, ... }
```

Thread-specific stream endpoints should still use durable event sequence replay semantics so reload/restart does not lose progress.

## TODO

### Phase 0 — Freeze semantics

- [x] Define `Project → Thread → Mission → Plan → Task → Worker Session` hierarchy.
- [x] Reserve `Session` for worker execution; use `Thread` for conversation continuity.
- [ ] Add contract tests proving two Threads in one Workspace do not share chat history implicitly.
- [ ] Add contract test proving one Thread can contain multiple Missions.

### Phase 1 — Persistence model

- [ ] Add `ThreadId`, `Thread`, and Thread status contracts.
- [ ] Add durable `threads` table/repository methods.
- [ ] Add optional `threadId` to persisted messages.
- [ ] Add optional `threadId` to Missions.
- [ ] Add indexes for Workspace + Thread chronological retrieval.
- [ ] Add idempotent migration/default Thread for legacy workspace chat data.
- [ ] Preserve existing durable message/Mission history without guessing ambiguous provenance.

### Phase 2 — Runtime and API

- [ ] Add Thread CRUD runtime facade.
- [ ] Add Thread-scoped message list/send APIs.
- [ ] Add Thread-scoped SSE stream/replay.
- [ ] Include `threadId` on relevant `chat.*` events.
- [ ] Validate Thread ownership against active Workspace.
- [ ] Keep `/api/chat*` only as temporary compatibility/default-Thread aliases if needed.

### Phase 3 — Context continuity

- [ ] Extend planning context with `threadId`.
- [ ] Load bounded recent Thread messages for each new turn.
- [ ] Include rolling Thread summary.
- [ ] Include relevant previous Missions from the current Thread.
- [ ] Include Thread-relevant Artifact / Decision refs where provenance supports it.
- [ ] Do not inject unrelated messages from sibling Threads.
- [ ] Add prompt-size bounds / deterministic truncation rules.

### Phase 4 — Thread summary

- [ ] Add durable optional `Thread.summary`.
- [ ] Update summary after meaningful completed work.
- [ ] Keep recent messages verbatim as the highest-priority conversational context.
- [ ] Make summary update failure non-fatal.
- [ ] Add regression proving an old long Thread can continue using summary + recent turns without loading the entire transcript.

### Phase 5 — UI navigation

- [ ] Add Thread list / current Thread state.
- [ ] Add `+ New thread`.
- [ ] Load only selected Thread messages.
- [ ] Support rename and archive.
- [ ] Show useful Thread status metadata (active Mission / Mission count / last activity) without noisy technical detail.
- [ ] Preserve selected Thread across reload when reasonable.
- [ ] Give canvas/Mission panels a selected-Thread lens without duplicating project state.

### Phase 6 — Turn semantics follow-up

- [ ] Stop assuming every message must create a new Mission.
- [ ] Distinguish conversation-only turns from executable requests.
- [ ] Allow a follow-up turn to redirect/revise an active Mission when appropriate.
- [ ] Keep runtime authority and approval boundaries intact.

### Phase 7 — Verification

- [ ] Regression: Workspace A, Thread A and B have isolated message lists.
- [ ] Regression: Thread A creates Mission 1, then follow-up creates Mission 2 with Thread A context.
- [ ] Regression: Thread B does not receive Thread A chat context.
- [ ] Regression: legacy global chat migrates to a default Thread exactly once.
- [ ] Regression: restart preserves Thread selection data/history and Mission lineage.
- [ ] Regression: SSE replay is filtered by Thread.
- [ ] Root `npm test`.
- [ ] Root `npm run typecheck`.
- [ ] Web build / UI acceptance tests.
- [ ] Final review for accidental cross-Thread context leakage.

## Acceptance criteria

Conversation Threads V1 is complete when:

1. One Workspace can contain multiple durable Threads.
2. Messages are retrieved and streamed by Thread, not only by Workspace.
3. One Thread can contain multiple Missions.
4. Every new chat-created Mission is linked to its originating Thread.
5. Planning a follow-up turn includes bounded context from the same Thread.
6. Planning does not automatically include sibling Thread histories.
7. Existing chat data survives migration in a default Thread.
8. The UI can create, switch, rename, and archive Threads.
9. Worker `Session` semantics remain execution-only and are not overloaded for conversations.
10. Thread continuity survives runtime/browser restart because it is durable, not frontend-only state.

## Deferred follow-up

Keep these outside V1 unless implementation proves they are required:

- branching/forking a Thread from an earlier message;
- merging Threads;
- cross-Thread search and semantic retrieval UI;
- automatic Thread clustering;
- shared Thread participants / multi-user collaboration;
- per-Thread git branches/worktrees;
- LLM-generated titles by default;
- aggressive automatic summary compaction;
- Thread-specific isolated canvases;
- cross-project Threads.
