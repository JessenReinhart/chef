import { strict as assert } from "node:assert";
import { shouldUseSingleWorkerFastPath } from "../src/orchestrator/fast-path-decision-provider.ts";
import { summarizeMissionProgressEvent } from "../web/src/missionProgress.ts";
import type { UiRuntimeEvent } from "../web/src/types.ts";

const simpleExplanations = [
  "What is React?",
  "How does React reconciliation work?",
  "Tell me about Vite",
];

for (const goal of simpleExplanations) {
  assert.equal(
    shouldUseSingleWorkerFastPath(goal),
    true,
    `${goal} should stay on the bounded single-worker route`,
  );
}

const comparisonQuestions = [
  "What is the difference between React and Vue?",
  "What are the pros and cons of React Server Components?",
  "Tell me about Vite versus Webpack",
  "How does React compare to Vue?",
  "What is React vs. Vue?",
];

for (const goal of comparisonQuestions) {
  assert.equal(
    shouldUseSingleWorkerFastPath(goal),
    false,
    `${goal} should retain planner routing because it asks for comparison/evaluation`,
  );
}

function proposedPlanEvent(routingMode: "single-worker" | "planner", taskIds: string[]): UiRuntimeEvent {
  return {
    id: `routing-${routingMode}-${taskIds.length}`,
    seq: 1,
    timestamp: 1_000,
    source: { type: "orchestrator", id: "orchestrator" },
    type: "orchestrator.plan.proposed",
    payload: { routingMode, taskIds },
    correlationId: "mission-routing",
  };
}

assert.equal(
  summarizeMissionProgressEvent(proposedPlanEvent("single-worker", ["task-1"]))?.text,
  "Chef chose one worker because this Mission fits one straightforward step.",
  "Simple Mode should explain why a bounded request avoided planner coordination",
);
assert.equal(
  summarizeMissionProgressEvent(proposedPlanEvent("planner", ["task-1", "task-2"]))?.text,
  "Chef used a coordinated plan because this Mission has 2 steps.",
  "Simple Mode should explain multi-step planner escalation from accepted-plan evidence",
);
assert.equal(
  summarizeMissionProgressEvent(proposedPlanEvent("planner", ["task-1"]))?.text,
  "Chef used planning because this Mission did not fit the bounded one-worker shortcut.",
  "a one-step planner result should explain that the request was outside the deterministic shortcut without inventing a more specific reason",
);

console.log("fast-path-routing-policy: ok — routing policy stays bounded and Simple Mode explains the chosen path from runtime evidence");
