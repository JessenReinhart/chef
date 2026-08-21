# Chef Setup Guide

This guide describes the setup behavior that exists in the current Chef runtime.

## Requirements

- Node.js 24 or later
- npm
- Windows is the primary supported desktop environment for local development

Install dependencies:

```bash
npm install
cd web
npm install
```

Start the runtime from the repository root:

```bash
npm run server
```

Start the web workbench in another terminal:

```bash
cd web
npm run dev
```

The runtime listens on `http://127.0.0.1:4321`. The Vite development server proxies `/api` requests to the runtime.

## Open a project

Chef treats the selected project directory as runtime state, not only UI state.

Use the project control in the workbench header to select a directory. On Windows, Chef can open the native folder picker. You can also enter a path manually.

When you change the project, Chef restarts the runtime for that project. This makes the new project directory apply to terminals, agent processes, filesystem tools, and harnesses.

The project database is stored at:

```text
<project>/.chef/chef.sqlite
```

Chef also keeps a machine-level list of recent project paths so that you can reopen a project quickly.

## Configure the Orchestrator

Chef has two separate AI execution paths:

1. The Chef Orchestrator can call an LLM provider directly.
2. CLI-backed workers such as Claude Code, OMP, Pi, and Freebuff run through their installed terminal applications.

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
```

Provider-specific API key variables can also satisfy the startup credential check:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
```

If `CHEF_PROVIDER` and a supported API key variable are already present, Chef does not replace that configuration with the saved machine-level provider settings.

## CLI-backed agents

Chef does not require its Orchestrator API key for terminal-native agents.

Current specialized harness candidates are:

- Claude Code
- OMP
- Pi
- Freebuff

Chef also keeps a generic terminal fallback.

A specialized CLI is considered available when Chef can detect its configured executable. This is an executable-readiness check only. Chef does not automatically run login commands or authentication probes.

The CLI owns its own login, API keys, provider, model, and other configuration. For example, if Claude Code already works in a normal terminal, Chef can host that CLI without copying its credentials into the Orchestrator settings.

The workbench **Agents** surface shows executable readiness. A `Ready` state does not mean that the third-party CLI authentication is valid.

## Recommended first run

For a CLI-first setup:

1. Install and authenticate the CLI that you want to use, such as Claude Code or OMP.
2. Start Chef.
3. Open the target project.
4. Check **Agents** and confirm that Chef detects the CLI executable.
5. Use the generic terminal if a specialized harness is not available.
6. Configure **AI** only if you also want the Chef Orchestrator to use a direct provider.

For a direct-provider setup:

1. Start Chef.
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
cd web
npm run build
```

## Security notes

- Do not commit provider credentials to the project repository.
- The project SQLite database is project-scoped. Orchestrator credentials are machine-scoped.
- Windows provider secrets use DPAPI with `CurrentUser` scope.
- CLI harness credentials remain owned by each CLI.
- Chef does not automatically execute third-party authentication commands during harness discovery.
