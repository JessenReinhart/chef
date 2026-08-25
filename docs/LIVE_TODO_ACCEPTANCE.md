# Live todo acceptance diagnostic

Use this opt-in diagnostic when validating Chef's canonical product journey against a real configured planner and a real detected CLI worker.

It creates a temporary local project, submits the permanent boring acceptance task through Chef's HTTP chat surface, observes Mission/Task/Session progress while the request is still running, waits for the Mission to finish, then starts the generated app with `npm start` and verifies that `/` serves a todo UI.

## Run

Configure Chef's normal LLM environment first, then run:

```sh
node --experimental-strip-types tests/live-todo-acceptance.ts
```

The diagnostic requires `CHEF_PROVIDER` plus one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `CHEF_API_KEY`. Custom/OpenAI-compatible providers should also set the same model/base URL variables used by normal Chef startup.

Optional variables:

- `CHEF_E2E_TIMEOUT_MS`: Mission timeout in milliseconds. Default: 10 minutes.
- `CHEF_E2E_KEEP_PROJECT=1`: keep the successful temporary project for inspection.

Failed runs always print and preserve the temporary project path so the generated files and `chef.sqlite` can be inspected directly. They also print a bounded recent Mission/Task/Session event trace so a silent or apparently frozen execution has concrete runtime evidence.

## What this proves

A passing run proves the selected-project boundary, HTTP task submission, observable in-flight Mission progress, real planner, real task-capable worker routing, durable Task/Session completion, generated-file discoverability, documented `npm start` contract, and a reachable generated application in one executable scenario.

The progress assertion is intentionally made before terminal-state checks. A Mission that eventually finishes but emits no observable Mission/Task/Session progress while the request is in flight is not considered product-green.

It intentionally stays out of normal CI because CI does not own a user's LLM credentials or installed CLI workers. Deterministic CI remains necessary but is not a substitute for this live acceptance signal.
