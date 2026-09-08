import { strict as assert } from "node:assert";

import {
  approvalMissionContextLabel,
  approvalsForMissionTasks,
} from "../web/src/missionApprovalOwnership.ts";

const approvals = [
  { id: "approval-current", taskId: "task-current", reason: "current needs access" },
  { id: "approval-earlier", taskId: "task-earlier", reason: "earlier needs access" },
];

assert.deepEqual(
  approvalsForMissionTasks(approvals, ["task-current"]),
  [approvals[0]],
  "current Mission state must only see approvals owned by its Tasks",
);

assert.deepEqual(
  approvalsForMissionTasks(approvals, ["task-newer"]),
  [],
  "an older pending approval must not make unrelated current work look blocked",
);

assert.deepEqual(
  approvalsForMissionTasks(approvals, ["task-current", "task-earlier"]),
  approvals,
  "Thread-level callers can still retain every approval when their owned Task set includes both Missions",
);

assert.equal(
  approvalMissionContextLabel(approvals[0], ["task-current"]),
  "For this Mission",
  "an approval owned by the current Mission should keep the concise current-work label",
);

assert.equal(
  approvalMissionContextLabel(approvals[1], ["task-current"]),
  "For earlier Mission",
  "an approval owned by earlier work must not be presented as current-Mission approval",
);

console.log("mission approval ownership tests passed");
