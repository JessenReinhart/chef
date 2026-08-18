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

As Chef grows, this same work can be explored and controlled through a visual workflow canvas. The canvas is a way to see and interact with the work — the underlying runtime remains the source of truth.

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
```

To run the local inspector dashboard:

```bash
npm run server

cd web
npm install
npm run dev
```

## Project structure

The repository is split between the runtime and its current dashboard projection:

```text
src/    Chef runtime, orchestration, persistence, harnesses, and server
web/    React/Vite dashboard
 tests/ End-to-end and runtime regression tests
```

If you're interested in the implementation details, start with the project documentation and architecture notes rather than treating this README as the technical specification.

## Design principles

A few ideas guide the project:

- **The runtime is the product.** The UI is a projection and control surface.
- **Agents are replaceable.** Chef should not depend on one model or one coding tool.
- **State is durable.** Important work should survive process restarts.
- **Communication is structured.** Terminal I/O and agent-to-agent messages are separate concerns.
- **Humans stay in control.** Sensitive actions can require approval.
- **Everything important is observable.** Runtime events are the backbone of the system.

## Status

🚧 **Early development**

The runtime foundation and first multi-agent workflow are working. The visual workflow editor, approvals, broader tool integrations, and several orchestration capabilities are still being built.

Chef is intentionally evolving from the runtime outward: **make the orchestration reliable first, then make it beautiful to operate.**
