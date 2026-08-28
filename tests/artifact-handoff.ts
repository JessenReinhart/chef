import { strict as assert } from "node:assert";
import { artifactHandoff } from "../web/src/artifactHandoff.ts";
import { copyRunCommand } from "../web/src/resultActions.ts";

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

let copiedText = "";
const copySuccess = await copyRunCommand(canonical.runCommand, {
  async writeText(text) {
    copiedText = text;
  },
});
assert.deepEqual(copySuccess, { ok: true });
assert.equal(copiedText, canonical.runCommand, "the action must copy the exact durable run instruction without rewriting it");

const copyUnavailable = await copyRunCommand(canonical.runCommand, null);
assert.deepEqual(copyUnavailable, { ok: false, error: "Clipboard access is unavailable" }, "Simple Mode must not claim a successful copy when clipboard access is unavailable");

const copyFailure = await copyRunCommand(canonical.runCommand, {
  async writeText() {
    throw new Error("clipboard denied");
  },
});
assert.deepEqual(copyFailure, { ok: false, error: "clipboard denied" }, "clipboard failures remain observable instead of becoming false success");

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

const booleanVerified = artifactHandoff({
  uri: "file:///tmp/chef-project/todo-app.mjs",
  metadata: { verified: true },
});
assert.equal(booleanVerified.verification, "Verified", "boolean success evidence should remain visible in the Simple Mode handoff");

const booleanUnverified = artifactHandoff({
  uri: "file:///tmp/chef-project/todo-app.mjs",
  metadata: { verified: false },
});
assert.equal(booleanUnverified.verification, null, "verified=false must never be rendered as successful verification");

const attributedBooleanVerification = artifactHandoff({
  uri: "file:///tmp/chef-project/todo-app.mjs",
  metadata: { verified: true, verifiedBy: "golden-path" },
});
assert.equal(attributedBooleanVerification.verification, "Verified by golden-path", "specific verifier evidence should remain more informative than a boolean success flag");

const noisy = artifactHandoff({
  uri: "sideband://result",
  metadata: { content: "Created   the todo app\nwith the requested form and list." },
});
assert.equal(noisy.summary, "Created the todo app with the requested form and list.", "worker summaries should be compact and readable in the result card");

const remote = artifactHandoff({ uri: "https://example.com/result", metadata: {} });
assert.deepEqual(remote, { summary: null, location: null, runCommand: null, verification: null });

console.log("artifact handoff behavior passed");
