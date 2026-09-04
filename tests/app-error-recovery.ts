import { strict as assert } from "node:assert";
import {
  dismissVisibleAppError,
  stateRefreshErrorMessage,
  visibleAppError,
} from "../web/src/appErrorProjection.ts";

let stateRefreshError: string | null = null;
let actionError: string | null = null;

stateRefreshError = stateRefreshErrorMessage(new Error("Current workspace is temporarily unavailable"));
assert.equal(
  visibleAppError(actionError, stateRefreshError),
  "Current workspace is temporarily unavailable",
  "a failed authoritative state refresh should remain visible while the refresh is failing",
);

stateRefreshError = null;
assert.equal(
  visibleAppError(actionError, stateRefreshError),
  null,
  "a successful authoritative state refresh should retire the refresh-owned warning automatically",
);

actionError = "Could not retry node";
stateRefreshError = stateRefreshErrorMessage(new Error("Failed to load state"));
assert.equal(
  visibleAppError(actionError, stateRefreshError),
  actionError,
  "an explicit user-action failure should remain the visible error even if background polling also fails",
);

stateRefreshError = null;
assert.equal(
  visibleAppError(actionError, stateRefreshError),
  actionError,
  "successful background polling must not clear an unrelated user-action failure",
);

stateRefreshError = "Failed to load state";
let dismissed = dismissVisibleAppError(actionError, stateRefreshError);
assert.equal(dismissed.actionError, null, "dismissing the visible action failure should clear only that action error");
assert.equal(dismissed.stateRefreshError, stateRefreshError, "a hidden refresh warning should retain its own lifecycle");

dismissed = dismissVisibleAppError(dismissed.actionError, dismissed.stateRefreshError);
assert.equal(dismissed.stateRefreshError, null, "once visible, the refresh warning can be dismissed independently");

assert.equal(stateRefreshErrorMessage("unknown"), "Failed to load state");

console.log("app error recovery behavior passed");
