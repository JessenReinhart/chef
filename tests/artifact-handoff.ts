import { strict as assert } from "node:assert";
import { artifactHandoff } from "../web/src/artifactHandoff.ts";

const canonical = artifactHandoff({
  uri: "file:///tmp/chef-project/todo-app.mjs",
  metadata: {
    content: "Created runnable todo app at /tmp/chef-project/todo-app.mjs",
    run: "node /tmp/chef-project/todo-app.mjs",
    verifiedBy: "golden-path",
  },
});
assert.equal(canonical.summary, "Created runnable todo app at /tmp/chef-project/todo-app.mjs", "Simple Mode should explain what changed when the worker already supplied that durable result summary");
assert.equal(canonical.location, "/tmp/chef-project/todo-app.mjs");
assert.equal(canonical.runCommand, "node /tmp/chef-project/todo-app.mjs");
assert.equal(canonical.verification, "Verified by golden-path");

const windows = artifactHandoff({
  uri: "file:///C:/Work/chef/todo-app.mjs",
  metadata: {},
});
assert.deepEqual(windows, {
  summary: null,
  location: "C:/Work/chef/todo-app.mjs",
  runCommand: null,
  verification: null,
}, "Windows file URIs should not show a browser-style leading slash");

const explicit = artifactHandoff({
  uri: "file:///tmp/internal-name.bin",
  metadata: {
    summary: "Built the production bundle",
    resultLocation: "dist/todo-app",
    runCommand: "npm start",
    verification: "Smoke test passed",
  },
});
assert.deepEqual(explicit, {
  summary: "Built the production bundle",
  location: "dist/todo-app",
  runCommand: "npm start",
  verification: "Smoke test passed",
});

const noisy = artifactHandoff({
  uri: "sideband://result",
  metadata: { content: "Created   the todo app\nwith the requested form and list." },
});
assert.equal(noisy.summary, "Created the todo app with the requested form and list.", "worker summaries should be compact and readable in the result card");

const remote = artifactHandoff({ uri: "https://example.com/result", metadata: {} });
assert.deepEqual(remote, { summary: null, location: null, runCommand: null, verification: null });

console.log("artifact handoff behavior passed");
