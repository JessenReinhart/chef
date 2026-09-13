import { strict as assert } from "node:assert";
import { interruptedMissionRecovery } from "../web/src/missionRecovery.ts";

const paused = interruptedMissionRecovery({
  missionStatus: "paused",
  goal: "Create a simple todo app",
  readOnly: false,
});
assert.deepEqual(paused, {
  description: "This Mission is paused. Keep its history intact and continue as fresh work in this Thread when you are ready.",
  prompt: "Continue this work: Create a simple todo app",
}, "paused Mission work must expose an editable fresh-follow-up path in an active Thread");

const cancelled = interruptedMissionRecovery({
  missionStatus: "cancelled",
  goal: "Create a simple todo app",
  readOnly: false,
});
assert.equal(cancelled?.prompt, "Continue this work: Create a simple todo app", "cancelled Mission recovery must keep its existing continuation contract");

assert.equal(interruptedMissionRecovery({
  missionStatus: "paused",
  goal: "Create a simple todo app",
  readOnly: true,
}), null, "archived Thread history must remain read-only");

assert.equal(interruptedMissionRecovery({
  missionStatus: "failed",
  goal: "Create a simple todo app",
  readOnly: false,
}), null, "failed Missions must remain in their failure-specific recovery path");

assert.equal(interruptedMissionRecovery({
  missionStatus: "waiting_for_approval",
  goal: "Create a simple todo app",
  readOnly: false,
}), null, "approval-waiting Missions must remain in the approval flow");

console.log("paused-mission-recovery: ok — paused work gets an editable Simple Mode continuation without bypassing read-only or approval gates");
