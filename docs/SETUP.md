# Chef Setup Guide

This guide describes the setup behavior that exists in the current Chef runtime.

For the shortest end-user walkthrough, see [`INSTALL.md`](INSTALL.md).

## Requirements

- Node.js 24 or later
- npm
- Windows is the primary supported desktop environment for local development

You do not need to install Chef's npm dependencies manually for normal use. The friendly launcher installs missing runtime and web dependencies on first launch.

## Local web mode

Chef is a local-first runtime with a browser-based UI. The browser is a control surface; the authoritative runtime, project files, PTY sessions, Git operations, artifacts, and SQLite database remain on the local machine.

Start Chef from the repository root:

```bash
npm run chef
```

On Windows, you can also double-click:

```text
Chef.cmd
```

The launcher:

1. validates Node.js 24+;
2. installs missing root dependencies;
3. installs missing web dependencies;
4. rebuilds the web UI when it is missing or stale;
5. checks whether a Chef runtime is already running;
6. starts the local runtime when necessary;
7. opens the workbench in the default browser.

Chef opens at:

```text
http://127.0.0.1:4321
```

The Chef runtime serves the built web client from `web/dist` and exposes its runtime API on the same origin under `/api`. A separate Vite process is not required for normal use.

This mode remains usable without internet access for local capabilities. Any configured remote LLM provider, web research, or other network-backed integration still requires its own network connection.

Set `CHEF_WEB_DIST` only when you need to serve a web build from a different directory. Set `CHEF_NO_OPEN=1` when you want the launcher to start Chef without opening a browser automatically.

## Web development mode

For UI development, run the runtime and Vite separately so hot reload stays available.

Start the runtime from the repository root:

```bash
npm run server
```

Start the web workbench in another terminal:

```bash
cd web
npm install
npm run dev
```

The runtime listens on `http://127.0.0.1:4321`. The Vite development server listens on port `5173` and proxies `/api` requests to the local runtime.

## Open a project

Chef treats the selected project directory as runtime state, not only UI state.

Use the project control in the workbench header to select a directory. On Windows, Chef can open the native folder picker. You can also enter a path manually.

When you change the project, Chef restarts the runtime for that project. This makes the new project directory apply to terminals, agent processes, filesystem tools, and harnesses.

The project database is stored at:

```text
<project>/.chef/chef.sqlite
```

Chef also keeps up to 10 recent project paths in:

```text
~/.chef/recent-projects.json
```

## Configure the Orchestrator

Chef has two separate AI execution paths:

1. The Chef Orchestrator can call an LLM provider directly.
2. CLI-backed workers such as Claude Code, Codex, OMP, Pi, and Freebuff run through their installed terminal applications.

These paths do not share credentials by default.

### Direct Orchestrator provider

Open **AI** in the workbench header. Configure:

- Provider: `anthropic`, `openai`, or `custom`
- Model
- Base URL, when the provider requires one
- API key

Chef saves the provider configuration at:

```text
~/.chef/orchestrator-provider.json
```

On Windows, Chef protects the API key with Windows DPAPI for the current user before it writes the value to disk. The project directory does not contain the Orchestrator API key.

On non-Windows systems, the current implementation stores the key in the machine-level provider file and makes a best-effort attempt to set file mode `0600`.

After you save the provider settings, Chef restarts the runtime. The new Orchestrator configuration becomes active after the restart.

### Environment variables

Environment variables still have priority when they are already configured before startup. This is useful for CI and advanced local development.

The runtime recognizes these Chef variables:

```text
CHEF_PROVIDER
CHEF_MODEL
CHEF_API_KEY
CHEF_BASE_URL
CHEF_TIMEOUT_MS
CHEF_WEB_DIST
CHEF_NO_OPEN
```

The provider adapter also reads these provider-specific API key variables:

```text
ANTHROPIC_API_KEY
OPENAI_API_KEY
```

If `CHEF_PROVIDER` and any recognized API key variable are already present before startup, Chef does not replace that configuration with the saved machine-level provider settings.

If no direct provider is configured, the runtime uses its deterministic scripted decision provider.

## CLI-backed agents

Chef does not require its Orchestrator API key for terminal-native agents.

Current specialized harness candidates are:

- Claude Code
- Codex
- OMP
- Pi
- Freebuff

Chef also keeps a generic terminal fallback.

A specialized CLI is considered available when Chef can detect its configured executable. This is an executable-readiness check only. Chef does not automatically run login commands or authentication probes.

The CLI owns its own login, API keys, provider, model, and other configuration. For example, if Claude Code or Codex already works in a normal terminal, Chef can host that CLI without copying its credentials into the Orchestrator settings.

The runtime exposes readiness data at:

```text
GET /api/harnesses/readiness
```

A reported `available: true` value means that Chef found the executable. It does not mean that the third-party CLI authentication is valid.

## Recommended first run

For a CLI-first setup:

1. Install Node.js 24+.
2. Clone or download Chef.
3. Launch with `npm run chef` or double-click `Chef.cmd` on Windows.
4. Open the target project in Chef.
5. Install and authenticate the CLI that you want to use, such as Claude Code, Codex, or OMP.
6. Confirm that the CLI works in a normal terminal.
7. Run `npm run doctor` when you need to inspect Chef's environment and harness readiness.
8. Use the generic terminal if a specialized harness is not available.
9. Configure **AI** only if you also want the Chef Orchestrator to use a direct provider.

For a direct-provider setup:

1. Launch Chef.
2. Open the target project.
3. Open **AI**.
4. Select the provider and model.
5. Add the API key and base URL when required.
6. Save the settings and let Chef restart the runtime.

## Validation commands

From the repository root:

```bash
npm test
npm run typecheck
```

For the web application:

```bash
npm run web:build
```

## Security notes

- The local web server binds to `127.0.0.1`, not all network interfaces.
- Do not commit provider credentials to the project repository.
- The project SQLite database is project-scoped. Orchestrator credentials are machine-scoped.
- Windows provider secrets use DPAPI with `CurrentUser` scope.
- CLI harness credentials remain owned by each CLI.
- Chef does not automatically execute third-party authentication commands during harness discovery.
