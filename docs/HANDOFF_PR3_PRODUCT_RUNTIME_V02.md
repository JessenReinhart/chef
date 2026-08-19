# PR #3 handoff — Product Runtime v0.2

Last updated: 2026-08-19 (Asia/Jakarta)

## Repository state

- PR: https://github.com/JessenReinhart/chef/pull/3
- Branch: `agent/living-workspace-spec-v0.2`
- Base: `master` (the branch already contains current `origin/master`)
- Spec: `docs/PRODUCT_RUNTIME_SPEC_V0.2.md`
- Status: **draft / work in progress**. Most v0.2 implementation is present, but the final lifecycle follow-up was interrupted and the branch is not fully green yet.

## What is implemented

- Durable first-class Missions with plan/task linkage, events, pause/resume/cancel/redirect APIs, controller cancellation, and stale-attempt ownership guards.
- Durable first-class Automations and Automation Runs with run-scoped dispatch, history, stop/cancellation, restart recovery, and approval-edge work in progress.
- Typed canvas relationships (`communication`, `context`, `delegation`, `dependency`, `control`, `error`, `approval`) with non-sequential communication/context semantics and exact typed deletion.
- Persisted Context Zones with explicit authoritative membership, policy/context refs, workspace validation, provenance, cleanup, and restart recovery.
- Durable live canvas-node identity/config/status, direct activation/intervention APIs, and standalone PTY event consumption.
- Production server DB is durable by default at `.chef/chef.sqlite`, configurable via `CHEF_DB_PATH`; shutdown no longer deletes workspace state.
- Specialized Claude/Pi/OMP/Freebuff adapters share a persistent generic PTY owner, preserve Scheduler session IDs, and no longer leak into generic ToolRunner execution.
- Living-workspace UI: no dominant global Run, Automation-scoped Run/Stop, Mission controls, typed edge selector, Simple/Power disclosure, Power runtime inspector, explicit Context Zone membership, authoritative capability policy projection, Terminal generic-harness assignment, and a Mission-independent Browser surface.
- SQLite migration for typed edges and new v0.2 tables is transactional/recoverable; partial canvas-node updates preserve runtime fields.

## New/expanded verification

- `tests/product-runtime-v02.ts` — durable Mission/graph/zone/Automation/live-node/artifact/decision restart contracts.
- `tests/product-runtime-v02-http.ts` — HTTP typed-edge semantics, Context Zone ref cleanup/member validation, capabilities projection, node/Automation APIs, legacy migration.
- `tests/product-runtime-v02-lifecycle.ts` — real Mission/Automation/session lifecycle scenarios (currently interrupted; see blocker below).
- `tests/product-runtime-v02-persistence.ts` — partial node upserts, zone provenance cleanup, typed deletion, migration recovery.
- `tests/server-runtime-surfaces.ts` — real palette-style Terminal PTY output/artifact/exit plus actual `src/server/index.ts` shutdown/restart DB survival.
- `tests/specialized-harness.ts` — specialized adapter lifecycle, sideband, and full orchestration routing.
- Windows PTY fixtures were made deterministic in `direct-worker-interaction.ts` and `inbox-context-delivery.ts`.

## Last known verification results

Passed after the current feature work:

```text
npm run typecheck
cd web && npm run build
node --experimental-strip-types tests/product-runtime-v02-http.ts
node --experimental-strip-types tests/server-runtime-surfaces.ts
node --experimental-strip-types tests/capabilities.ts
node --experimental-strip-types tests/tool-runner.ts
git diff --check
```

The complete `npm test` chain passed before the final Bugbot follow-up edits. It has **not** passed after those interrupted edits.

Current failing reproduction:

```powershell
node --experimental-strip-types tests/product-runtime-v02-lifecycle.ts
```

It exits with an unsettled top-level await at `tests/product-runtime-v02-lifecycle.ts:326` (`await scopedMissionExecution`). The latest capacity-starvation test/implementation was interrupted mid-fix.

## Remaining P1 blockers from the final Bugbot pass

1. Mission capacity starvation: when an unrelated live session occupies Scheduler capacity (or a Mission batch exceeds `maxConcurrency`), Mission execution must wait/retry instead of treating zero immediate dispatches as failure. Inspect `src/orchestrator/orchestrator.ts` around the scoped dispatch/consume loop and the hanging lifecycle case around line 326.
2. Automation capacity starvation: `AutomationRunner` must distinguish temporary capacity pressure from a graph that can never progress. Do not fail a valid runnable Automation after the short stalled-poll window merely because unrelated work temporarily occupies capacity.
3. Automation stop at an approval gate must resolve/cancel the run-owned pending Approval row so the UI does not keep a stale actionable approval.

Earlier Bugbot findings already addressed in the worktree: durable production DB, palette Terminal harness assignment, standalone session event ownership, Mission dispatch scoping, task-authoritative canvas status, Mission plan/epoch ownership, run-owned Automation session checks, and real Automation approval records/gates.

## Recommended continuation order

1. Finish the three P1 lifecycle blockers above and make `tests/product-runtime-v02-lifecycle.ts` terminate cleanly.
2. Run the focused v0.2/runtime gates:

   ```powershell
   npm run typecheck
   node --experimental-strip-types tests/product-runtime-v02.ts
   node --experimental-strip-types tests/product-runtime-v02-http.ts
   node --experimental-strip-types tests/product-runtime-v02-lifecycle.ts
   node --experimental-strip-types tests/product-runtime-v02-persistence.ts
   node --experimental-strip-types tests/server-runtime-surfaces.ts
   node --experimental-strip-types tests/specialized-harness.ts
   cd web
   npm run build
   ```

3. Run full `npm test` on Windows and fix only real assertions/handle leaks; do not weaken lifecycle semantics.
4. Re-run a fresh read-only full-diff reviewer against `master` and `docs/PRODUCT_RUNTIME_SPEC_V0.2.md`.
5. Audit all ten spec acceptance tests one by one. Treat UI source regexes as supplemental only; retain rendered/browser evidence for Simple/Power and live surfaces.

## Important implementation notes

- `Scheduler.dispatchPending(workspaceId, allowedTaskIds, owner?)` is the scoped primitive. Mission and Automation callers must pass owned task IDs; standalone callers must also provide the single session-event owner.
- Do not use workspace-wide live-session checks for Automation progress.
- Context Zone geometry may propose membership on creation/drag, but persisted `memberNodeIds` remains authoritative.
- Canvas edge field is canonically `type` end-to-end; do not reintroduce the old frontend `relationship` payload.
- Browser nodes are not routed through the generic PTY. `web/src/BrowserSurface.tsx` is the honest Mission-independent browser surface; Terminal uses the `generic` harness.
- `npm run typecheck` was changed from a command that swallowed errors to a real strict source check.
- PR #3 should stay draft until the lifecycle blocker and full suite are green.
