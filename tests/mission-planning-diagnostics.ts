import { strict as assert } from "node:assert";
import { missionDiagnosticDetail, missionDiagnosticLabel } from "../web/src/missionDiagnostics.ts";
import type { UiRuntimeEvent } from "../web/src/types.ts";

function event(type: string, payload: unknown): UiRuntimeEvent {
  return {
    id: crypto.randomUUID(),
    seq: 1,
    timestamp: Date.now(),
    source: { type: "orchestrator", id: "orchestrator" },
    type,
    payload,
  };
}

const started = event("orchestrator.plan.started", { missionId: "mission-1" });
assert.equal(missionDiagnosticLabel(started), "Planning started");
assert.equal(
  missionDiagnosticDetail(started),
  "Decision provider call started; no worker has been selected yet.",
  "Power diagnostics must explain the pre-worker planning boundary before a Task exists",
);

const singleWorker = event("orchestrator.plan.proposed", {
  missionId: "mission-1",
  routingMode: "single-worker",
  taskIds: ["task-1"],
});
assert.equal(missionDiagnosticLabel(singleWorker), "Execution route selected");
assert.equal(
  missionDiagnosticDetail(singleWorker),
  "Route: single worker.",
  "Power diagnostics must expose the selected single-worker route",
);

const planner = event("orchestrator.plan.proposed", {
  missionId: "mission-2",
  routingMode: "planner",
  taskIds: ["task-a", "task-b", "task-c"],
});
assert.equal(missionDiagnosticDetail(planner), "Route: coordinated planner (3 steps).");

const failed = event("orchestrator.plan.error", {
  missionId: "mission-3",
  error: "Planner timed out after 20000ms before any worker could start",
});
assert.equal(missionDiagnosticLabel(failed), "Planning failed");
assert.equal(
  missionDiagnosticDetail(failed),
  "Planner timed out after 20000ms before any worker could start",
  "Power diagnostics must retain the concrete pre-worker failure reason",
);

console.log("mission planning diagnostics behavior passed");
