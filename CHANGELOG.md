# Changelog

## 2026-08-28

- **Chef now keeps the normal workflow inside one Living Workspace (#237):** The selected project, task progress, worker activity, results, run instructions, and verification details now stay together in the main workspace instead of competing across separate home/workbench surfaces. Results are tied to the current Mission so old artifacts are not presented as the latest task output, and advanced runtime details remain available when needed.

## 2026-08-26

- **Power Mode now explains what Chef is doing before a worker starts (#230):** Planning diagnostics now show when the decision provider starts, whether Chef chose a single worker or a coordinated plan, and why planning ended or was interrupted. This makes the pre-worker “Preparing” phase much easier to inspect without guessing.
- **Worker startup is now checked on both Windows and Linux (#228):** Chef's required CI now runs the same real Thread-to-worker startup check on both supported desktop platforms. This makes it much harder for a platform-specific regression to leave a task stuck before a worker starts.
- **The live todo check now follows the same Thread flow as Simple Mode (#227):** Chef's opt-in real-environment diagnostic now opens a real Thread, requires a detected CLI worker to start promptly, waits for the Mission to finish, starts the generated app, and verifies that the todo UI is actually reachable. This makes the diagnostic a much stronger check of the real product journey.
- **Planning is visible before a worker starts (#226):** Simple Mode now shows when Chef is actively planning a Mission, keeps that progress tied to the correct Mission, and stops the planning heartbeat when planning fails. A new live todo diagnostic can also verify the real configured AI provider and an actual detected CLI worker when that environment is available.
- **Simple tasks start more reliably (#224):** Short requests such as creating a todo app can go straight to a worker instead of getting stuck in planning. More complex work can still use the planner, but planning now times out instead of leaving Simple Mode stuck on “Preparing” forever.
- **Clearer interruption and cancellation feedback (#220):** Simple Mode now tells you when a Mission or work step was interrupted or cancelled, instead of continuing to show a misleading “still working” message. If the work is genuinely retried, normal progress feedback resumes.
