import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { completionHandoffReport } from "../src/core/completion-handoff.ts";
import type { Artifact } from "../src/core/types.ts";
import { createChatRepository } from "../src/persistence/chat.ts";
import { Repository } from "../src/persistence/database.ts";
import { createThreadRepository } from "../src/persistence/threads.ts";
import { createThreadServer } from "../src/server/thread-http.ts";

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

const zeroFailureVerification = completionHandoffReport("Plan completed.", [artifact({
  metadata: { verification: "12 passed, 0 failed" },
})]);
assert.match(
  zeroFailureVerification,
  /Verification: 12 passed, 0 failed/,
  "zero-failure verification evidence must remain visible just as it does in the Simple Mode result card",
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

const locatedSideband = completionHandoffReport("Plan completed.", [
  artifact({
    id: "sparse-result",
    name: "build-summary",
    uri: "sideband://result",
    metadata: {},
  }),
  artifact({
    id: "located-note",
    type: "note",
    name: "generated-app-location",
    uri: "sideband://location",
    metadata: { resultLocation: "/projects/demo/generated-todo" },
  }),
]);
assert.match(
  locatedSideband,
  /Location: \/projects\/demo\/generated-todo/,
  "the only usable result location must outrank a sparse result artifact",
);
assert.doesNotMatch(
  locatedSideband,
  /Result: build-summary/,
  "a nominal result must not hide a more actionable handoff artifact",
);

for (const resultLocation of [
  "../outside/todo-app",
  "dist/../../outside/todo-app",
  "dist\\..\\..\\outside\\todo-app",
  "file:///tmp/bad%ZZ/result",
  "file://server/share/todo-app",
  "https://example.com/todo-app",
  "//example.com/todo-app",
  "\\\\fileserver\\share\\todo-app",
] as const) {
  const unusableLocation = completionHandoffReport("Plan completed.", [artifact({
    uri: "sideband://result",
    metadata: { resultLocation },
  })]);
  assert.doesNotMatch(
    unusableLocation,
    /Location:/,
    `terminal completion must not advertise resultLocation=${JSON.stringify(resultLocation)} when Simple Mode cannot reveal it`,
  );
}

const explicitLocationRemainsAuthoritative = completionHandoffReport("Plan completed.", [artifact({
  uri: "file:///projects/demo/todo-app.mjs",
  metadata: { resultLocation: "../outside/todo-app" },
})]);
assert.doesNotMatch(
  explicitLocationRemainsAuthoritative,
  /Location:/,
  "terminal completion must not advertise an artifact URI fallback that Simple Mode will not reveal while explicit result metadata is present",
);
assert.doesNotMatch(explicitLocationRemainsAuthoritative, /\.\.\/outside\/todo-app/);

for (const resultLocation of ["C:\\Work\\chef\\todo-app", "file:///C:/Work/chef/todo-app", "dist/../todo-app"] as const) {
  const revealableLocation = completionHandoffReport("Plan completed.", [artifact({
    uri: "sideband://result",
    metadata: { resultLocation },
  })]);
  assert.match(
    revealableLocation,
    /Location:/,
    `terminal completion must preserve revealable Windows/project-local resultLocation=${JSON.stringify(resultLocation)}`,
  );
}

const dir = await mkdtemp(join(tmpdir(), "chef-completion-handoff-"));
const repository = new Repository(join(dir, "chef.sqlite"));
repository.createWorkspace({ id: "workspace-a", name: "Workspace A" });
const threads = createThreadRepository(repository);
const chat = createChatRepository(repository);
const thread = threads.create({ workspaceId: "workspace-a", title: "Todo app" });
const taskId = "task-build";
const runtime = {
  workspaceId: "workspace-a",
  repository,
  sendUserMessage(message: string) {
    repository.insertMission({ workspaceId: "workspace-a", goal: message, status: "planning", createdBy: "user" });
    repository.insertArtifact({
      workspaceId: "workspace-a",
      type: "result",
      name: "todo-app",
      uri: "file:///projects/demo/todo-app.mjs",
      createdBy: "todo-builder",
      taskId,
      metadata: {
        content: "Created runnable todo app at /projects/demo/todo-app.mjs",
        run: "node /projects/demo/todo-app.mjs",
        verifiedBy: "golden-path",
      },
    });
    return Promise.resolve({ workspaceId: "workspace-a", taskIds: [taskId], report: "Plan completed.", ok: true });
  },
} as never;
const baseServer = createServer((_req, res) => { res.writeHead(404); res.end(); });
const server = createThreadServer(runtime, baseServer);

try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/threads/${thread.id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Create a simple todo app" }),
  });
  assert.equal(response.status, 202, "canonical Thread submission must acknowledge before completion");

  const deadline = Date.now() + 1_000;
  let completion = chat.list("workspace-a", thread.id).find((message) => message.role === "assistant");
  while (!completion && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    completion = chat.list("workspace-a", thread.id).find((message) => message.role === "assistant");
  }
  assert.ok(completion, "successful Thread work must persist a terminal assistant handoff");
  assert.match(completion.content, /Result: Created runnable todo app/);
  assert.match(completion.content, /Location: \/projects\/demo\/todo-app\.mjs/);
  assert.match(completion.content, /Run: node \/projects\/demo\/todo-app\.mjs/);
  assert.match(completion.content, /Verification: verified by golden-path/);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  baseServer.close();
  repository.close();
  await rm(dir, { recursive: true, force: true });
}

console.log("completion-handoff-report: ok — terminal completion notes expose truthful bounded result handoffs");
