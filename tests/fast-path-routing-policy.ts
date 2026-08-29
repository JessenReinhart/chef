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

const simpleDetailedRequests = [
  "Create a simple todo app\nUse React.",
  "Create a simple todo app; React is fine.",
  "Research the best way to create a system with AI\nKeep the answer concise.",
];

for (const goal of simpleDetailedRequests) {
  assert.equal(
    shouldUseSingleWorkerFastPath(goal),
    true,
    `${goal} should not pay planner latency only because the request contains formatting or a short detail`,
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

const separatedMultiStageRequests = [
  "Create a todo app\nThen test it.",
  "Create a todo app; add end-to-end tests.",
  "Research the options\nPrepare a migration plan.",
];

for (const goal of separatedMultiStageRequests) {
  assert.equal(
    shouldUseSingleWorkerFastPath(goal),
    false,
    `${goal} should retain planner routing because the separator introduces another executable stage`,
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
assert.equal(
  summarizeMissionProgressEvent(proposedPlanEvent("planner", []))?.text,
  "Chef is using planning for this Mission; accepted steps are not available yet.",
  "planner routing without accepted task evidence must stay explicit about the missing reason instead of inventing a need for coordination",
);

console.log("fast-path-routing-policy: ok — routing policy stays bounded and Simple Mode explains the chosen path from runtime evidence");
