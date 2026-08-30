import { strict as assert } from "node:assert";
import { shouldUseSingleWorkerFastPath } from "../src/orchestrator/fast-path-decision-provider.ts";
import { summarizeMissionProgressEvent } from "../web/src/missionProgress.ts";
import type { UiRuntimeEvent } from "../web/src/types.ts";

const simpleExplanations = [
  "What is React?",
  "How does React reconciliation work?",
  "Tell me about Vite",
  "Is this normal?",
  "Does this code leak memory?",
  "Should I use Vite?",
  "Can React handle this?",
  "Please, is this normal?",
  "Please should I use Vite?",
  "How does React share state across components?",
  "Can React render multiple roots?",
  "What is parallel rendering?",
  "Should I update auth across multiple packages?",
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
  "Create a simple todo app, React is fine.",
  "Create a simple todo app with React and TypeScript.",
  "Can you create a simple todo app?",
  "Can you please create a simple todo app?",
  "Could you fix this button?",
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
  "Should I migrate from React to Vue?",
  "Can you compare React and Vue?",
  "Please, should I migrate from React to Vue?",
];

for (const goal of comparisonQuestions) {
  assert.equal(
    shouldUseSingleWorkerFastPath(goal),
    false,
    `${goal} should retain planner routing because it asks for comparison/evaluation`,
  );
}

const scopedComplexRequests = [
  "Update auth across multiple packages.",
  "Research multiple providers for deployment.",
  "Create tests in parallel.",
  "Can you update auth across multiple packages?",
  "Could you create tests in parallel?",
  "Please, would you update auth across multiple packages?",
];

for (const goal of scopedComplexRequests) {
  assert.equal(
    shouldUseSingleWorkerFastPath(goal),
    false,
    `${goal} should retain planner routing because scope words describe real work rather than an informational question`,
  );
}

const unrecognizedExecutableQuestions = [
  "Can you refactor the authentication flow?",
  "Could you deploy this app to production?",
  "Would you redesign the settings experience?",
  "Please, will you reorganize this repository?",
  "Can you refactor auth and explain it?",
  "Could you deploy this app and summarize the result?",
  "Would you redesign settings and create a short note?",
];

for (const goal of unrecognizedExecutableQuestions) {
  assert.equal(
    shouldUseSingleWorkerFastPath(goal),
    false,
    `${goal} should retain planner routing because request-question grammar or a later bounded verb must not widen the bounded fast path`,
  );
}

const separatedMultiStageRequests = [
  "Create a todo app\nThen test it.",
  "Create a todo app\nand test it.",
  "Create a todo app; add end-to-end tests.",
  "Create a todo app; and verify it runs.",
  "Create a todo app, test it.",
  "Can you fix this, verify it?",
  "Research the options\nPrepare a migration plan.",
  "Should I use Vite and test it?",
  "Can React handle this and verify it?",
  "Create a todo app and add end-to-end tests.",
  "Fix this bug then generate a regression report.",
  "Rename the API and document the migration.",
  "Can you create a todo app and deploy it?",
  "Create the settings page, then redesign the navigation.",
  "Fix the auth bug; refactor the session flow.",
  "Update this component and reorganize the module.",
];

for (const goal of separatedMultiStageRequests) {
  assert.equal(
    shouldUseSingleWorkerFastPath(goal),
    false,
    `${goal} should retain planner routing because the request introduces another executable stage`,
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
