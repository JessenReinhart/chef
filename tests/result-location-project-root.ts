import { strict as assert } from "node:assert";
import { canRevealArtifact } from "../web/src/artifactHandoff.ts";
import { missionResultHandoffProjection, type LivingArtifact } from "../web/src/artifactProjection.ts";

const revealable = (resultLocation: string) => canRevealArtifact({
  uri: "sideband://result",
  metadata: { resultLocation },
});

for (const location of [".", "./", "dist/..", "dist/../."] as const) {
  assert.equal(revealable(location), false, `project-root placeholder ${JSON.stringify(location)} must not advertise Show location`);
}
for (const location of ["dist/todo-app", "dist/../todo-app", "./todo-app"] as const) {
  assert.equal(revealable(location), true, `concrete project child ${JSON.stringify(location)} must remain revealable`);
}

const result: LivingArtifact = {
  id: "todo-result",
  workspaceId: "workspace-current",
  type: "result",
  name: "todo-app",
  uri: "sideband://result",
  version: 1,
  createdBy: "todo-builder",
  taskId: "task-current",
  metadata: { missionId: "mission-current", resultLocation: "." },
};
const projection = missionResultHandoffProjection(
  [result],
  { missionId: "mission-current", taskIds: ["task-current"], threadId: "thread-current" },
  "thread-current",
  "completed",
);
assert.equal(
  projection.notice,
  "Work is marked complete, but Chef did not publish a durable result location for this Mission.",
  "a completed Mission pointing only at the project root must keep its result handoff visibly incomplete",
);

console.log("project-root result location behavior passed");
