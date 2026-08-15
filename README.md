# Chef

**An AI engineering workspace where one goal can become a whole team of agents working on it.**

Chef is built around a simple idea: instead of manually driving one AI coding assistant at a time, give a goal to an **Orchestrator** and let it coordinate the work.

The Orchestrator can break a problem into tasks, delegate those tasks to different AI agents, keep their work connected, and bring the results back together. The agents can run through real terminal-based tools, so Chef is not tied to a single AI model or coding agent.

> **Human intent → Orchestrator → Agents → Shared context → Results → Verification**

Chef is local-first and designed to make complex, multi-agent engineering work feel like one coherent workspace.

## Why Chef?

Today's AI coding tools are great at helping one agent work on one problem. Real engineering work is usually messier:

- one person investigates the problem
- another implements a fix
- another runs tests or verifies the result
- agents need to share context and artifacts
- work needs to survive restarts
- someone still needs to coordinate the whole thing

Chef is being built to handle that coordination.

You talk primarily to Chef's **Orchestrator**. It acts more like a technical lead than a chatbot: it plans the work, delegates it, watches what happens, and decides what needs to happen next.

## What it looks like

```text
                         You
                          │
                          ▼
                  ┌──────────────┐
                  │ Orchestrator │
                  │  / Squad Lead│
                  └──────┬───────┘
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
          Research     Coding    Verification
            Agent       Agent        Agent
              │          │          │
              └──────────┼──────────┘
                         ▼
                    Your project
                         │
                         ▼
                    Verified result
```

 - **Runtime is the product** — the UI/canvas is disposable.
 - **Terminal I/O and structured messaging are never mixed.** PTY bytes remain a separate harness channel; structured envelopes arrive via sideband outbox. Runtime lifecycle/events remain durable in SQLite.
 - **Restart survival** — state, artifacts, tasks, sessions, plans, and messages persist across process restarts.
 - **Atomic dispatch** — scheduler concurrency is enforced in the dispatch transaction, so concurrent callers cannot oversubscribe live sessions.
 - **Human approvals, live observability, workflow nodes, tools, and chat** land on top of the same runtime.

## What Chef can do today

Chef is still early, but the core runtime is already real.

- Run multi-agent plans through terminal-based agent harnesses
- Dispatch and track tasks and sessions
- Persist tasks, sessions, messages, artifacts, and events locally
- Survive process restarts without losing the workflow state
- Stream live runtime events
- Intervene in running terminal sessions
- Expose runtime state through a small HTTP/SSE API
- Visualize the current runtime through a minimal dashboard

## Where it's going

The goal is a general-purpose **AI Engineering OS** rather than another chat interface or another coding-agent wrapper.

Planned areas include:

- **Visual workflows** — see and control agents, tasks, and dependencies on a canvas
- **More harnesses** — use Claude Code, Pi, OMP, Codex CLI, Aider, and other terminal-based agents
- **Shared context** — let agents exchange the right information without copying entire conversations around
- **Artifacts** — make files, findings, reports, and other outputs first-class parts of a workflow
- **Approvals & permissions** — keep humans in control of sensitive actions
- **Tools & integrations** — connect agents to browsers, MCP capabilities, and other engineering tools
- **Resume & replay** — recover and continue interrupted work from durable runtime state

The long-term experience should be simple:

> **Tell Chef what you want. Chef figures out who should do what, coordinates the work, and brings you the result.**

## Getting started

Chef currently requires **Node.js 24+**.

```bash
npm install

# Run the end-to-end golden path
node --experimental-strip-types tests/golden-path.ts
<<<<<<< HEAD
```

To run the local inspector dashboard:
 # Full regression suite
 npm test
 # Handle-leak diagnostic
 node --experimental-strip-types diag-handles.mjs
 ```

 ## Web UI

 ```bash
 npm run server          # runtime + projection API on http://127.0.0.1:4321
 cd web && npm install && npm run dev   # workbench proxying /api to the server
 ```

 The workbench provides:

 - **Simple Mode** — template gallery (Monthly Financial Report, Cash Flow Analysis, Budget vs Actual, Developer Fix/Verify), guided setup wizard, friendly inspector fields, plain-language statuses. No runtime/model terminology.
 - **Power Mode** — full node graph, live logs with filters, interactive terminal panes, context bus inspector, wide node inspector (model/temperature/tokens), session controls.
 - **Canvas** — pan/zoom/select/minimap projection of the workflow graph; approval accept/reject on human nodes.
 - **Chat with Chef** — streaming assistant over SSE; can propose validated workflow plans via the LLM decision provider.
 - **Execution console** — node status timeline, artifacts with preview/download, approval queue, metrics strip.

 ## Runtime API

 `ChefRuntime` (from `src/main.ts`) exposes:

 - `sendUserMessage(message)` → `OrchestratorResult` (plan → tasks → report)
 - `sendChatMessage(message)` → streaming chat via SSE
 - `retryTask(taskId)` — bounded retry through the scheduler
 - `inspectState()` → `WorkspaceSnapshot`
 - `toolRunner`, `browserTool`, `mcpRegistry` — Phase 8 capabilities
 - `subscribeEvents(cb)` → unsubscribe

 HTTP/SSE projection (`src/server/http-server.ts`):

 | Method | Path | Purpose |
 |---|---|---|
 | GET | `/api/state` | workspace snapshot |
 | GET | `/api/graph` | workflow graph projection |
 | GET | `/api/events?afterSeq&types=` | live SSE stream with replay |
 | POST | `/api/sessions/send\|interrupt\|resize` | direct worker controls |
 | GET/POST/PATCH/DELETE | `/api/workflows`, `/api/templates` | workflow + template CRUD |
 | POST | `/api/nodes/run\|cancel\|retry` | node execution seam |
 | GET | `/api/tools`, `/api/inspector/*` | capability catalog + inspector |
 | POST | `/api/approvals/:id/accept\|reject` | human approval gates |
 | GET/POST | `/api/chat`, `/api/chat/messages` | chat with Chef |

 ## LLM Provider Configuration

 By default Chef uses the deterministic `ScriptedDecisionProvider` (investigate + verify). To enable intent-driven planning, set:

 ```bash
 export ANTHROPIC_API_KEY=...            # or OPENAI_API_KEY for OpenAI-compatible endpoints
 export CHEF_MODEL=claude-sonnet-5     # optional; provider-specific default
 export CHEF_PROVIDER=anthropic        # optional: anthropic | openai | openai-compatible
 ```

 `LLMDecisionProvider` (`src/orchestrator/llm-decision-provider.ts`) validates structured decisions against the node contract before the runtime applies them. Provider failure falls back to the scripted provider with an honest error decision.

 MCP servers (capability layer only — never orchestration):

 ```bash
 export CHEF_MCP_SERVERS='[{"id":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/path"],"capabilities":["filesystem"]}]'
 ```

 ## Capabilities & Permissions

 `src/runtime/capabilities.ts` implements spec §11.2 defaults:

 | Capability | Engineer | Orchestrator | Human |
 |---|---|---|---|
 | Filesystem/Terminal/Git | allow | allow | allow |
 | Network/Browser/GitHub | deny | allow | allow |
 | Spawn agents / Assign tasks | deny | allow | allow |
 | Deploy / destructive ops | approval | approval | allow |

 Unknown capabilities fail closed (`deny`). Approval-gated tools (`git push`, out-of-root writes, deploy) emit `approval.requested` events and block until a human decision via `/api/approvals/:id/accept|reject`.

 ## Project Layout

 ```
 src/
   main.ts                  createChef() wiring, ChefRuntime interface
   core/types.ts            domain types
   core/nodes.ts            UI-independent node contracts (spec §12)
   core/graph.ts            workflow graph projection
   context/                 context reference system
   persistence/             Repository (SQLite) + schema
   runtime/                 Scheduler (dispatch, events, retry)
   runtime/node-registry.ts         9+ node definitions
   runtime/node-execution-engine.ts deterministic graph executor
   runtime/capabilities.ts          permission policy (spec §11.2)
   runtime/tool-runner.ts           terminal/filesystem/git tools + approval gates
   runtime/browser-tool.ts          Playwright browser sessions (optional dep)
   runtime/mcp-client.ts            MCP capability clients
   runtime/harness-registry.ts      specialized harness adapters
   harness/generic.ts               PTY harness (mandatory)
   harness/claude-code.ts|pi.ts|omp.ts|freebuff.ts   adapters
   orchestrator/                    Orchestrator + decision providers
   server/http-server.ts            read-only HTTP/SSE projection API
   server/index.ts                  server entrypoint
 tests/
   golden-path.ts           P0 golden path test
   timeout-cancellation.ts  plan timeout teardown
   seq-concurrency.ts       atomic event sequences
   cancel-facade.ts         terminal-task cancellation guard
   dispatch-concurrency.ts  maxConcurrency under concurrent dispatch
   plan-persistence.ts      plan close/reopen durability
   pty-replay.ts            PTY output replay
   live-events.ts           live event subscription
   direct-worker-interaction.ts  send/interrupt/resize regression
   approvals.ts             human approval gates
   canvas-graph.ts          graph projection
   node-registry.ts         node registry + execution engine
   api-backend.ts           workflow/template/inspector API
   simple-mode.ts           template wizard + mode switching
   power-mode.ts            logs/terminals/context/inspector API
   chat-streaming.ts        LLM decision provider + SSE chat
   capabilities.ts          permission policy
   tool-runner.ts           deterministic tool execution
   acceptance.ts            spec §22 acceptance scenarios
   http-server.ts           projection API smoke test
 web/
   src/App.tsx              workbench (Simple/Power modes, template flow)
   src/CanvasPanel.tsx      graph projection canvas
   src/NavigationPanel.tsx  node library + nav
   src/InspectorPanel.tsx   simple inspector
   src/WideInspector.tsx    power inspector
   src/LogsPanel.tsx        live logs
   src/TerminalPanes.tsx    interactive terminals
   src/ContextBusPanel.tsx  context refs/artifacts/decisions
   src/ConsolePanel.tsx     events/chat + execution console
   src/TemplateGallery.tsx  template selection
   src/SetupWizard.tsx      guided wizard
   src/simpleNodeConfig.tsx simple↔runtime config mapping
 docs/
   AUDIT.md                 spec-to-implementation audit

## Status

 **Working:**

 - Golden path end-to-end: user message → plan → PTY dispatch → structured sideband delivery → artifact persistence → task completion.
 - Close/reopen cycle: full task, session, artifact, message, event, and plan state survives restart.
 - Concurrent dispatch respects `maxConcurrency`; timeout cancellation and terminal-task cancellation are regression-tested.
 - PTY terminal output is persisted as ordered `session.data` events and survives restart.
 - Live event subscription (`ChefRuntime.subscribeEvents`) delivers the persisted event stream with unsubscribe support.
 - Direct worker controls (`sendInput`, `interruptSession`, `resizeSession`) persist `user.*` intervention events.
 - Human approval gates: pending → blocked, accepted → assigned, rejected → cancelled; HTTP + canvas controls.
 - Node registry + execution engine: 9 node types, deterministic graph validation, approval blocking, failure propagation, cancellation.
 - Workflow/template/inspector API with restart-safe SSE replay.
 - Simple Mode: 4 seeded templates, guided wizard, friendly fields, mode toggle preserving workflow identity.
 - Power Mode: live logs, interactive terminals, context bus, wide inspector, dark theme.
 - Chat with Chef: LLM decision provider (env-configured), streaming SSE, chat persistence, graph patch validation.
 - Tool runner: terminal/filesystem/git with permission policy and approval gates; browser + MCP clients; specialized harness adapters (claude/pi/omp/freebuff) with generic fallback.
 - Execution console: node timeline, artifact cards, approval queue, metrics (with honest "unknown" for unavailable cost data).

 **Honest gaps (see `docs/AUDIT.md` for full audit):**

 - React Flow canvas is the spec target; the current canvas is an SVG projection (works, not yet migrated).
 - LLM provider requires API keys at runtime; without them the deterministic scripted provider runs.
 - Playwright is optional; browser tool degrades with an honest error when absent.
 - Hierarchical squads (P4) and full IRC channel UI are future capabilities.
 - Wide inspector config persistence endpoint not yet wired.

 ## Notes

 - Windows: winpty backend (`useConpty: false`) — treat as a temporary compatibility layer.
 - TypeScript native stripping: no enums, namespaces, or parameter properties.
 - SQLite via `node:sqlite` `DatabaseSync` (sync, no migrations; idempotent `CREATE TABLE IF NOT EXISTS`).
 - See `docs/AUDIT.md` for the spec-to-implementation checklist.
