# Chef

**A living AI workspace where people, agents, tools, and context collaborate in real time.**

Chef is a local-first Node/TypeScript runtime and visual workbench for coordinating AI agents, terminal tools, durable context, Missions, and repeatable Automations.

The core mental model is:

> **Human intent → Mission → Orchestrator → live agents/tools → artifacts → verified outcome**

The canvas is not a batch workflow builder with a global Run gate. It is a persistent projection of runtime-owned workspace state. Agents and interactive tool surfaces can become live as soon as they are added; explicit Run/Stop semantics belong to Automations.

## What Chef can do today

The v0.2 baseline already includes a working runtime and web workbench:

- durable Missions, Tasks, Sessions, Artifacts, Decisions, Messages, Approvals, Automations, canvas nodes/edges, and Context Zones
- restart-safe SQLite persistence
- Orchestrator-driven planning and task dispatch
- terminal-based harness execution with a generic PTY fallback plus specialized harness adapters
- live runtime events over SSE with replay
- direct session input, interrupt, resize, and peer messaging
- human approval gates and capability policy
- a React/XYFlow canvas with persisted node positions and typed relationships
- live terminal surfaces embedded in canvas nodes
- browser/tool surfaces and MCP capability integration
- Simple and Power modes
- Chat with Chef over the same runtime
- repeatable Automations with explicit Run/Stop lifecycle
- Context Zones for bounded shared context

Chef remains early, but the product is no longer a headless-runtime prototype or an SVG-only dashboard.

## Product invariants

These rules are more important than any one UI implementation:

- **Runtime is authoritative.** The UI is a projection over durable runtime state.
- **The workspace is live.** Adding or configuring an interactive node should not require a canvas-wide Run button.
- **Automations are explicit.** Repeatable jobs are the surface where Run/Stop, retries, dependencies, and history are primary controls.
- **Terminal I/O and structured messaging stay separate.** PTY bytes use the harness channel; structured envelopes use the sideband channel.
- **Restart survival matters.** Durable workspace relationships and execution history must survive process restarts.
- **Human control stays explicit.** Sensitive capabilities can be denied or approval-gated.
- **Context should be bounded.** Connections and Context Zones scope what agents receive instead of copying whole conversations everywhere.

## Architecture

```text
                         You
                          │
                          ▼
                  ┌──────────────┐
                  │ Orchestrator │
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

Chef's runtime owns durable entities and execution state. The web app reads that state, subscribes to runtime events, and sends explicit mutations back through the API.

## Getting started

Chef currently requires **Node.js 24+**.

```bash
npm install
npm test
```

Run the server:

```bash
npm run server
```

Run the web workbench in another terminal:

```bash
cd web
npm install
npm run dev
```

The runtime API listens on `http://127.0.0.1:4321`; the Vite dev server proxies `/api` requests to it.

Useful validation commands:

```bash
# full runtime regression suite
npm test

# root TypeScript check
npm run typecheck

# web TypeScript + production build
cd web && npm run build

# handle-leak diagnostic
node --experimental-strip-types diag-handles.mjs
```

## Web workbench

### Simple Mode

Simple Mode hides most runtime jargon and focuses on goals, friendly node configuration, templates, and obvious human actions.

Seeded templates include:

- Monthly Financial Report
- Cash Flow Analysis
- Budget vs Actual
- Developer Fix/Verify

### Power Mode

Power Mode exposes the lower-level machinery for advanced users:

- live canvas state
- typed relationships
- logs and event history
- terminal panes
- context inspection
- runtime/session controls
- wider node configuration surfaces

### Living canvas

The current canvas uses XYFlow/React Flow and persists runtime-owned canvas state. It supports durable nodes, typed edges, node positions, Context Zones, and live surfaces such as terminals.

A canvas relationship is not merely decorative. Depending on its type it can represent communication, context sharing, delegation, dependency/control flow, error routing, or approval semantics.

### Automations

Automations are durable repeatable jobs. Unlike the living canvas, they intentionally expose an execution lifecycle with explicit Run/Stop behavior and run history.

## Runtime API

`ChefRuntime` is exposed from `src/main.ts`. Important capabilities include:

- `sendUserMessage(message)` — goal → plan → coordinated execution
- `sendChatMessage(message)` — Chat with Chef
- `dispatchPending()` — dispatch runnable pending tasks
- `patchCanvas(workspaceId, patch)` — durable canvas mutation
- `listCanvas(workspaceId)` — current durable canvas projection
- `activateNode(nodeId)` — activate a live canvas node
- `interveneNode(nodeId, message)` — send human intervention to a live node
- `runAutomation(id)` / `stopAutomation(id)` — Automation lifecycle
- `pauseMission(id)` / `resumeMission(id)` / `cancelMission(id)` / `redirectMission(id, goal)`
- `sendInput`, `interruptSession`, `resizeSession`, `sendPeerMessage`
- `inspectState()` — consistent workspace snapshot
- `subscribeEvents(cb)` — persisted event stream subscription

The HTTP/SSE server exposes corresponding endpoints for workspace state, canvas mutation, Missions, Automations, sessions, approvals, chat, tools, templates, Context Zones, and runtime events.

## LLM provider configuration

Without provider credentials Chef falls back to the deterministic scripted decision provider.

Example:

```bash
export ANTHROPIC_API_KEY=...
export CHEF_PROVIDER=anthropic
export CHEF_MODEL=claude-sonnet-5
```

OpenAI-compatible providers can be configured through the corresponding Chef environment variables used by `src/orchestrator/llm-decision-provider.ts`.

Chef surfaces provider configuration status through the runtime instead of pretending an LLM is active when it is not.

## Harnesses

Chef is designed around terminal-compatible harnesses rather than one model vendor.

Current runtime wiring includes:

- generic PTY harness
- Claude Code adapter
- Pi adapter
- OMP adapter
- Freebuff adapter

The generic harness remains the fallback when a specialized harness is unavailable.

## Capabilities and approvals

Chef applies role-based capability policy to tool execution. Filesystem/terminal/git access, network/browser/GitHub capabilities, agent spawning, and destructive/deployment actions can be allowed, denied, or routed through approval depending on role and operation.

Unknown capabilities fail closed.

## Project layout

```text
src/
  main.ts                  runtime wiring and ChefRuntime facade
  core/                    durable domain contracts and graph types
  context/                 bounded context/reference logic
  persistence/             SQLite repository and schema
  runtime/                 scheduler, automation runner, tools, capabilities
  harness/                 generic PTY + specialized harness adapters
  orchestrator/            planning/decision providers
  server/                  HTTP/SSE runtime projection and mutation API

web/
  src/App.tsx              main living-workspace shell
  src/BlueprintCanvas.tsx  XYFlow canvas
  src/TerminalView.tsx     embedded terminal surface
  src/BrowserSurface.tsx   browser surface
  src/api.ts               runtime API client

tests/                     runtime, server, canvas, context, approval, and acceptance coverage

docs/
  AUDIT.md                 implementation audit
```

## Honest gaps

Current known limitations include:

- provider-backed planning requires external API credentials; otherwise the scripted decision provider is used
- Playwright-backed browser execution is optional and degrades with an explicit error when unavailable
- some advanced inspector/configuration persistence paths are still incomplete
- hierarchical squads, richer long-lived agent identity/presence, and broader collaboration UX remain later-stage work
- resume/replay and richer artifact UX can still be expanded beyond the current durable execution history
- Windows currently uses the winpty compatibility path (`useConpty: false`)

For implementation-level detail and remaining divergences, see `docs/AUDIT.md` and the repository's active product/spec documents.

## Direction

Chef is aiming to become a general-purpose **AI Engineering OS / living agent workspace**, not another single-agent coding wrapper and not a traditional workflow builder.

The intended experience stays simple:

> **Tell Chef what you want. Chef figures out who should do what, coordinates the work, keeps the workspace alive, and brings you the result.**
