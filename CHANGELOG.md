# Changelog

## 2026-08-26

- **Simple tasks start more reliably (#224):** Short requests such as creating a todo app can go straight to a worker instead of getting stuck in planning. More complex work can still use the planner, but planning now times out instead of leaving Simple Mode stuck on “Preparing” forever.
- **Clearer interruption and cancellation feedback (#220):** Simple Mode now tells you when a Mission or work step was interrupted or cancelled, instead of continuing to show a misleading “still working” message. If the work is genuinely retried, normal progress feedback resumes.
