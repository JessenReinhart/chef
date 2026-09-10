import { strict as assert } from "node:assert";
import { dismissVisibleAppError, visibleAppError } from "../web/src/appErrorProjection.ts";
import { chefReportPresentation } from "../web/src/chefReportPresentation.ts";
import { runRecoverableWorkspaceRefresh } from "../web/src/livingWorkspaceRefresh.ts";

let authoritativeSnapshot = "old";
let actionError: string | null = null;
let refreshError: string | null = null;
let shouldFail = true;

const refresh = () => runRecoverableWorkspaceRefresh(
  async () => {
    if (shouldFail) throw new Error("Workspace state is temporarily unavailable");
    return "current";
  },
  (state) => {
    authoritativeSnapshot = state;
  },
  (message) => {
    refreshError = message;
  },
);

await refresh();
assert.equal(authoritativeSnapshot, "old", "a failed refresh must preserve the last authoritative workspace snapshot");
assert.equal(
  visibleAppError(actionError, refreshError),
  "Workspace state is temporarily unavailable",
  "Simple Mode should surface the background refresh problem while it is real",
);

shouldFail = false;
await refresh();
assert.equal(authoritativeSnapshot, "current", "a recovered refresh should apply the new authoritative workspace snapshot");
assert.equal(
  visibleAppError(actionError, refreshError),
  null,
  "a successful authoritative refresh should retire its own stale warning",
);

actionError = "Could not retry this worker";
shouldFail = true;
await refresh();
assert.equal(
  visibleAppError(actionError, refreshError),
  actionError,
  "an explicit user-action failure should outrank a simultaneous background refresh warning",
);

shouldFail = false;
await refresh();
assert.equal(refreshError, null, "background recovery should clear only the refresh-owned warning");
assert.equal(
  visibleAppError(actionError, refreshError),
  actionError,
  "background recovery must not hide an unrelated user-action failure",
);

const dismissed = dismissVisibleAppError(actionError, refreshError);
actionError = dismissed.actionError;
refreshError = dismissed.stateRefreshError;
assert.equal(visibleAppError(actionError, refreshError), null, "the visible action error should remain dismissible after recovery");

for (const missionStatus of ["paused", "waiting_for_approval", "blocked", "completed", "failed", "cancelled"] as const) {
  assert.equal(
    chefReportPresentation({ missionStatus, starting: false }),
    "expanded",
    `${missionStatus} work must keep Chef's full recovery/outcome report visible in Simple Mode`,
  );
}

for (const missionStatus of ["planning", "active", "verifying"] as const) {
  assert.equal(
    chefReportPresentation({ missionStatus, starting: false }),
    "compact",
    `${missionStatus} work may keep the routine latest report compact while durable progress remains visible`,
  );
}

assert.equal(
  chefReportPresentation({ missionStatus: "waiting_for_approval", starting: true }),
  "compact",
  "the provisional Starting state must outrank stale attention status until the newly accepted Mission becomes authoritative",
);
assert.equal(
  chefReportPresentation({ missionStatus: "active", directReport: true, starting: false }),
  "expanded",
  "an explicit direct Chef report must remain fully readable even while ordinary work is active",
);

console.log("living workspace error recovery behavior passed — attention states expose full Chef guidance without weakening active-work compaction");
