# Agent Presence V1

**Status:** implementation plan  
**Product source:** Chef Product Bible — Pillar A / Agent Presence  
**Branch:** `agent/agent-presence-v1`

## Goal

Make agent nodes feel like persistent workspace participants instead of task-shaped rectangles.

An agent card should answer, at a glance:

1. Who is this agent?
2. What is its current presence state?
3. What is it responsible for right now?
4. Which Mission is it participating in?
5. Is there a live execution session behind it?

The key semantic rule is:

> **Agent identity is durable; a Session is only one execution instance.**

A completed, crashed, or terminated Session must not make the agent identity disappear.

## Why this is next

The Product Bible's near-term sequence starts with the living canvas, then Agent Presence. The current `BlueprintCanvas` already uses `@xyflow/react`, so the XYFlow migration is effectively present on `master`. Presence is therefore the first genuinely missing slice of the proposed sequence.

The runtime already gives us the durable ingredients:

- persistent canvas agent nodes;
- task ownership and status;
- Mission ownership;
- durable Sessions;
- approval state;
- runtime events;
- persisted `liveStatus` for standalone nodes.

V1 should compose those sources into one read-only presence projection rather than create a second authoritative state model.

## Product behavior

### Presence states

V1 supports:

- `offline`
- `starting`
- `idle`
- `thinking`
- `working`
- `waiting`
- `needs_input`
- `waiting_for_approval`
- `blocked`
- `failed`

### State precedence

Presence is derived in this order:

1. pending human approval → `waiting_for_approval`
2. live spawning Session → `starting`
3. live running Session → `working`
4. blocked Task → `blocked`
5. failed Task → `failed`
6. assigned Task → `starting`
7. running Task without a visible live Session → `working`
8. cancelled Task → `offline`
9. completed Task → `idle`
10. persisted canvas `liveStatus`
11. fallback → `offline`

The projection is deliberately deterministic and explainable.

## Runtime projection

Add `buildAgentPresence(snapshot)` as a pure runtime projection.

Each record contains:

- persistent canvas `nodeId`;
- human-readable `name`;
- optional role from node config;
- harness id;
- derived status;
- current Task id/title when relevant;
- current Mission id/goal when relevant;
- current Session id/status when present;
- whether the agent currently needs human attention;
- latest relevant runtime activity;
- projection timestamp.

The projection is **not persisted**. Durable state remains canvas/task/session/mission/event records.

## HTTP API

Add:

`GET /api/agents/presence`

Response:

```json
{
  "ok": true,
  "data": [
    {
      "nodeId": "agent-alpha",
      "name": "Claude Code",
      "status": "working",
      "harnessId": "claude-code",
      "currentTaskId": "task-123",
      "currentObjective": "Fix checkout race",
      "currentMissionId": "mission-456",
      "missionGoal": "Fix flaky checkout",
      "currentSessionId": "session-789",
      "sessionStatus": "running",
      "needsAttention": false
    }
  ]
}
```

## Canvas UI

Agent nodes get a dedicated React Flow renderer rather than sharing the generic blueprint card.

Simple Mode shows:

- agent name;
- friendly presence state;
- current objective or `Available`;
- Mission indicator when active;
- attention state when blocked/approval/failure requires the human.

Power Mode additionally shows:

- raw presence state;
- harness id;
- abbreviated Task / Mission / Session ids.

The agent remains visible after its Session ends; the card returns to `Idle` instead of disappearing.

## Non-goals for V1

- editing agent profile/name/role/avatar;
- persistent agent memory policy;
- separate agent inbox UI;
- multiple concurrent Sessions per one agent identity;
- model/provider preference editor;
- agent cloning/templates;
- replacing task-backed agent creation semantics;
- changing Orchestrator worker-selection policy.

Those belong to later Agent Home / reusable-team work.

## Acceptance criteria

1. A standalone persisted agent node produces a presence record with no Mission or Session required.
2. A running Session makes the linked agent `working`.
3. A spawning Session makes the linked agent `starting`.
4. A pending approval takes precedence and surfaces `waiting_for_approval`.
5. A blocked or failed Task surfaces an attention state.
6. A completed Task returns the agent to `idle`; the agent identity remains present.
7. Presence exposes current Mission and objective when the Task belongs to a Mission.
8. `GET /api/agents/presence` returns the runtime-derived projection.
9. The React Flow canvas uses a dedicated agent card with Simple/Power progressive disclosure.
10. Runtime tests and the web TypeScript build remain green.

## Follow-up after V1

The next logical slice is **Mission Surface**: make a Mission itself visually inspectable as the goal container around these present agents, tasks, blockers, approvals, artifacts, and verification state.
