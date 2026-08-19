# Context Scopes and Peer Connections

Chef's canvas has two different collaboration primitives. They should not be represented as the same kind of edge.

## Peer connection

A direct connection between two nodes means **intentional peer communication**.

Connected nodes may ask each other questions, exchange findings, coordinate work, and contribute toward the same goal. The runtime owns this communication channel.

## Context scope

A rectangle drawn around nodes means **shared context**, not communication. Every node whose canvas position falls inside the rectangle becomes a member. Members resolve the scope's context references while remaining independent unless a peer connection also exists.

The rectangle is a visual representation of a durable context scope, not an executable node.

## Three independent graph semantics

1. **Communication** — `A ─ B`: these nodes intentionally collaborate.
2. **Context** — `[ A B C ]`: these nodes have access to shared knowledge.
3. **Dependency** — `A ──▶ B`: B depends on an output from A.

Keeping these meanings separate prevents canvas edges from becoming ambiguous as Chef grows.

## Runtime contract

A context scope persists its workspace, stable id, name, rectangle bounds, and shared context references. Membership is derived from the authoritative canvas rather than persisted as a second source of truth.

`ContextScopeManager` provides create/get/list/update/delete, deterministic membership, shared-reference resolution, overlapping-scope reference union, workspace isolation, persistence/reload, and dimension validation.

Moving a node across a rectangle boundary changes its membership on the next resolution without rewriting the scope record.

The runtime primitive lives in `src/core/context-scopes.ts` and `src/context/context-scope-manager.ts`. Tests cover the complete lifecycle and persistence behavior.

## Canvas interaction

Power Mode exposes **＋ Shared Context** on the canvas. Drag a rectangle around agents, terminals, or tools to create a durable context scope. The rectangle follows the canvas viewport, and membership is recalculated from node positions. Deleting the scope removes the shared-context boundary without deleting its member nodes.

The scope does not imply peer communication: draw a direct connection when agents should actively communicate.
