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

const started = event("orchestrator.plan.started", {
  missionId: "mission-1",
  provider: "anthropic-single-worker-fast-path",
});
assert.equal(missionDiagnosticLabel(started), "Planning started");
assert.equal(
  missionDiagnosticDetail(started),
  "Decision provider anthropic-single-worker-fast-path started; no worker has been selected yet.",
  "Power diagnostics must identify the active provider at the pre-worker planning boundary",
);

const startedWithoutProvider = event("orchestrator.plan.started", { missionId: "mission-legacy" });
assert.equal(
  missionDiagnosticDetail(startedWithoutProvider),
  "Decision provider call started; no worker has been selected yet.",
  "Older durable planning events without provider metadata must remain readable",
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

const noPlan = event("orchestrator.plan.none", { missionId: "mission-3" });
assert.equal(missionDiagnosticLabel(noPlan), "Planning ended without a plan");
assert.equal(
  missionDiagnosticDetail(noPlan),
  "Planning finished without selecting work, so no worker was started.",
  "Power diagnostics must explain an empty planner result even when the runtime has no extra reason text",
);

const interrupted = event("orchestrator.plan.interrupted", { missionId: "mission-4" });
assert.equal(missionDiagnosticLabel(interrupted), "Execution interrupted");
assert.equal(
  missionDiagnosticDetail(interrupted),
  "Execution stopped before the planned work could continue.",
  "Power diagnostics must not leave an interruption with an empty detail",
);

const interruptedWithReason = event("orchestrator.plan.interrupted", {
  missionId: "mission-4",
  reason: "User changed direction before worker startup",
});
assert.equal(
  missionDiagnosticDetail(interruptedWithReason),
  "User changed direction before worker startup",
  "Concrete runtime reasons must outrank generic fallback copy",
);

const failed = event("orchestrator.plan.error", {
  missionId: "mission-5",
  error: "Planner timed out after 20000ms before any worker could start",
});
assert.equal(missionDiagnosticLabel(failed), "Planning failed");
assert.equal(
  missionDiagnosticDetail(failed),
  "Planner timed out after 20000ms before any worker could start",
  "Power diagnostics must retain the concrete pre-worker failure reason",
);

console.log("mission planning diagnostics behavior passed");
