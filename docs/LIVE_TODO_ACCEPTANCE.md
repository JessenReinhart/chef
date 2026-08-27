# Live todo acceptance diagnostic

Use this opt-in diagnostic when validating Chef's canonical product journey against a real configured planner and a real detected CLI worker.

It creates a temporary local project, opens a real Chef Thread, submits the permanent boring todo-app acceptance task through the same `/api/threads/:id/chat` boundary used by Simple Mode, requires a fresh detected CLI worker Session to start within a bounded interval, observes Mission/Task/Session progress while the request is still running, waits for the Mission to finish, then starts the generated app with `npm start` and verifies that `/` serves a todo UI.

## Run

Configure Chef's normal LLM provider first, then run:

```sh
npm run diagnostic:live-todo
```

The diagnostic loads Chef's normal persisted provider settings first, with the same environment-variable overrides supported by normal startup. A task-capable local CLI worker must also be detected.

Optional variables:

- `CHEF_LIVE_STARTUP_BUDGET_MS`: maximum time for a fresh detected CLI worker Session to appear. Default: 5 seconds.
- `CHEF_E2E_TIMEOUT_MS`: Mission timeout in milliseconds. Default: 10 minutes.
- `CHEF_E2E_KEEP_PROJECT=1`: keep the successful temporary project for inspection.

Failed runs always print and preserve the temporary project path so the generated files and `chef.sqlite` can be inspected directly. They also print a bounded recent Mission/Task/Session event trace so a silent or apparently frozen execution has concrete runtime evidence.

## What this proves

A passing run proves the selected-project boundary, Thread creation, Simple Mode's Thread chat submission path, bounded real worker startup, observable in-flight Mission progress, real planner, real task-capable worker routing, durable Task/Session completion, generated-file discoverability, documented `npm start` contract, and a reachable generated application in one executable scenario.

The progress and worker-startup assertions are intentionally made before terminal-state checks. A Mission that eventually finishes but emits no observable Mission/Task/Session progress or fails to start a real worker promptly is not considered product-green.

It intentionally stays out of normal CI because CI does not own a user's LLM credentials or installed CLI workers. Deterministic CI remains necessary but is not a substitute for this live acceptance signal.
