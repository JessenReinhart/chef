# Task 6: Chat with Chef Streaming

## Context
Phase 1 complete: node contract frozen. Phase 2 complete: backend SSE `/api/events` with replay, `/api/state`, `/api/graph`. Phase 3 complete: workbench shell with Chat tab in `ConsolePanel.tsx`.
Phase 8 will add tool runner; Chat should work with current tool seam (501 honest error if no runner).

## Deliverables
1. **Provider-Neutral Decision Adapter** (`src/orchestrator/llm-decision-provider.ts`) — uses configured OpenAI-compatible/Anthropic client, structured JSON schema validation, timeout/error handling
2. **Chat Message Persistence** — durable chat history in SQLite via existing Repository
3. **SSE Streaming** — `GET /api/chat/stream` or reuse `/api/events` with `types=chat.*`
4. **Cancellation + Reconnect/Replay** — abort in-flight, resume from persisted state
5. **Graph Patch Operations** — Chat proposes validated graph patches; runtime applies only approved operations

## Existing Contracts
- `src/core/types.ts` — `DecisionProvider`, `PlanProposalContext`, `PlanTask`, `Decision`, `DecisionStatus`
- `src/orchestrator/orchestrator.ts` — `OrchestratorDecisionProvider`, `ScriptedDecisionProvider`, `Orchestrator`
- `src/main.ts` — `createChef`, `ChefRuntime.handleUserMessage`, `subscribeEvents`
- `src/server/http-server.ts` — `/api/events` SSE with `afterSeq`, `types=`
- `src/persistence/database.ts` — `Repository`, transactions

## Decision Provider Design
- Interface: extends `DecisionProvider` + optional `ScriptedHarnessProvider`
- Config via environment: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (or custom provider), `CHEF_MODEL`, `CHEF_PROVIDER`
- Uses Anthropic `jsonSchemaOutputFormat` for structured output validation
- Falls back to `ScriptedDecisionProvider` when no provider configured
- Timeout: 60s per proposal (configurable)
- Errors: provider failure → structured error decision with `status: "rejected"`

## Chat Flow
1. User sends "Build a monthly report"
2. `POST /api/chat` (or reuse `handleUserMessage`) → Orchestrator with LLM provider
3. LLM returns structured `Plan` + `PlanTask[]` matching `GraphNodeSpec` from node registry
4. Runtime validates graph via `NodeExecutionEngine.validateGraph()`
5. On valid: persist plan, return `OrchestratorResult` with `planId`
6. On invalid: return errors, ask user to clarify
7. Streaming: SSE events `chat.plan.proposed`, `chat.plan.validated`, `chat.plan.applied`

## Graph Patch Operations (from Chat)
- "Add an approval before email" → propose `INSERT_NODE` + `REWIRE_EDGES`
- "Change the model to GPT-5" → propose `UPDATE_NODE_CONFIG`
- Runtime validates patch → persists if valid → SSE `chat.patch.applied`

## Files to Create/Modify
- Create: `src/orchestrator/llm-decision-provider.ts`
- Create: `src/persistence/chat.ts` (chat message schema + repo methods)
- Modify: `src/main.ts` (wire LLM provider when configured)
- Modify: `src/server/http-server.ts` (chat SSE endpoint)
- Modify: `web/src/ConsolePanel.tsx` (Chat tab streaming UI)
- Tests: `tests/chat-streaming.ts` (valid/invalid model decisions, provider failure, streaming reconnect, patch validation)

## Acceptance Criteria
- No provider configured → `ScriptedDecisionProvider` used (existing behavior preserved)
- Provider configured → LLM interprets intent, produces valid plan
- Chat streams assistant events via SSE
- Cancellation aborts in-flight; reconnect replays from `afterSeq`
- "Add approval before email" produces validated graph patch
- All focused tests pass

## Constraints
- Runtime authoritative; UI is projection
- No fake providers, placeholders, silent fallbacks
- Structured output required — no raw text parsing
- Provider config via env only; no secrets in code
- Do not modify NodeForge/RuntimePilot/CanvasSmith core files

## Report
Write to `.superpowers/reports/chatstream.md`