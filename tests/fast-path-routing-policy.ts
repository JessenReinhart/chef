import { strict as assert } from "node:assert";
import { shouldUseSingleWorkerFastPath } from "../src/orchestrator/fast-path-decision-provider.ts";

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

console.log("fast-path-routing-policy: ok — ordinary explanations stay direct while comparison wording stays planner-routed");
