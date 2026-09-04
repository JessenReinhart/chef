import { strict as assert } from "node:assert";
import { dismissVisibleAppError, visibleAppError } from "../web/src/appErrorProjection.ts";
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

console.log("living workspace error recovery behavior passed");
