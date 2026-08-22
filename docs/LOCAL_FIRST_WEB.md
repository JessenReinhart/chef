# Local-first Web Architecture

Chef uses a browser-based client over a machine-local authoritative runtime.

```text
Browser UI
  http://127.0.0.1:4321
          |
          | HTTP + SSE
          v
Chef local runtime
  Orchestrator
  Workflow engine
  Event stream
  Harness manager
          |
          +-- PTY / terminal agents
          +-- filesystem / Git
          +-- browser tools
          +-- project artifacts
          +-- <project>/.chef/chef.sqlite
```

## Product boundary

The web client is a projection and control surface. It does not own runtime state and it does not attempt to execute local capabilities from the browser sandbox.

The local runtime owns:

- project selection and filesystem scope
- PTY processes and terminal-native harnesses
- task, Mission, workflow, approval, and agent lifecycle
- durable events, artifacts, decisions, and project memory
- SQLite persistence
- local tool execution and Git operations

This preserves the core Chef rule: the UI can change without changing the authoritative execution model.

## Local bundled mode

A production web build lives in `web/dist`. The runtime serves that directory on the same loopback origin as the API.

```text
GET  /                  -> web/dist/index.html
GET  /assets/*          -> built web assets
GET  /client-route      -> web/dist/index.html
/api/*                  -> Chef runtime API
```

This removes the requirement for a desktop shell or a second web-development process during normal use. It also gives Chef a browser-native UI while project execution stays local.

The runtime remains bound to `127.0.0.1` by default. Serving the UI does not expose the runtime to the LAN.

## Development mode

Vite remains the development server for the web package. It proxies `/api` to the loopback runtime so the browser client uses the same relative API paths in development and bundled local mode.

## Offline behavior

The built UI, local runtime, SQLite state, PTY sessions, local Git operations, and local tools do not require a network connection by themselves.

Network-backed capabilities remain network-backed. For example, a remote LLM provider or web research tool can be unavailable while the local workspace and runtime continue to function.

## Hosted web client

A separately hosted Chef web shell that connects back to a local runtime is intentionally not part of the first slice.

That mode requires an explicit transport and security contract for cross-origin requests, browser local-network permissions, origin allowlisting, authentication/session binding, and event streaming. It must not be implemented by exposing a raw local shell endpoint or by weakening the runtime's loopback boundary.

The intended future shape is:

```text
Hosted Chef UI or PWA
          |
          | explicit authenticated runtime transport
          v
Chef local runtime
          |
          +-- local project / PTY / Git / SQLite
```

The local bundled web mode is the baseline and offline fallback even after a hosted shell exists.
