import { strict as assert } from "node:assert";

import { completionHandoffReport } from "../src/core/completion-handoff.ts";
import type { Artifact } from "../src/core/types.ts";

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "artifact-result",
    workspaceId: "workspace-a",
    type: "result",
    name: "todo-app",
    uri: "file:///projects/demo/todo-app.mjs",
    version: 1,
    createdBy: "todo-builder",
    taskId: "task-build",
    metadata: {},
    ...overrides,
  };
}

const canonical = completionHandoffReport("Plan completed.", [artifact({
  metadata: {
    content: "Created runnable todo app at /projects/demo/todo-app.mjs",
    run: "node /projects/demo/todo-app.mjs",
    verifiedBy: "golden-path",
  },
})]);
assert.equal(
  canonical,
  [
    "Plan completed.",
    "",
    "Handoff:",
    "- Result: Created runnable todo app at /projects/demo/todo-app.mjs",
    "- Location: /projects/demo/todo-app.mjs",
    "- Run: node /projects/demo/todo-app.mjs",
    "- Verification: verified by golden-path",
  ].join("\n"),
  "a completed canonical result must carry its actionable handoff into the terminal Chef note",
);

const unsafeRun = completionHandoffReport("Plan completed.", [artifact({
  metadata: {
    summary: "Built the app",
    run: "npm install\nnpm run dev",
    verification: "Tests passed",
  },
})]);
assert.match(unsafeRun, /Result: Built the app/);
assert.match(unsafeRun, /Location: \/projects\/demo\/todo-app\.mjs/);
assert.doesNotMatch(unsafeRun, /Run:/, "multiline run metadata must never be presented as a runnable instruction");
assert.match(unsafeRun, /Verification: Tests passed/);

const failedVerification = completionHandoffReport("Plan completed.", [artifact({
  metadata: { verification: "Tests failed: 2 failures" },
})]);
assert.doesNotMatch(
  failedVerification,
  /Verification:/,
  "negative verification metadata must not be promoted into a successful terminal handoff",
);

const sparse = completionHandoffReport("Plan completed.", [artifact({
  uri: "sideband://session/result",
  metadata: {},
})]);
assert.match(sparse, /Result: todo-app/);
assert.doesNotMatch(sparse, /Location:/, "Chef must not invent a local result location");
assert.doesNotMatch(sparse, /Run:/, "Chef must not invent a run command");
assert.doesNotMatch(sparse, /Verification:/, "Chef must not invent verification evidence");

const preferred = completionHandoffReport("Plan completed.", [
  artifact({ id: "newer-note", type: "note", name: "newer-note", uri: "sideband://note", taskId: "task-build" }),
  artifact({
    id: "older-runnable-result",
    metadata: { run: "npm run dev", verified: true },
  }),
]);
assert.match(preferred, /Run: npm run dev/, "the actionable result should win over a newer non-result artifact");
assert.match(preferred, /Verification: verified/);

console.log("completion-handoff-report: ok — terminal completion notes expose truthful bounded result handoffs");
