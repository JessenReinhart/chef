import { strict as assert } from "node:assert";
import { artifactHandoff } from "../web/src/artifactHandoff.ts";
import {
  copyRunCommand,
  createSingleFlightArtifactDownloader,
  downloadArtifact,
} from "../web/src/resultActions.ts";

const canonical = artifactHandoff({
  name: "todo-app",
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

const downloadBody = new Blob(["todo app"]);
const downloadSuccess = await downloadArtifact("todo-file", async (input, init) => {
  assert.equal(String(input), "/api/artifacts/todo-file/download");
  assert.equal(new Headers(init?.headers).get("x-chef-action"), "download-artifact");
  return {
    ok: true,
    async json() { return {}; },
    async blob() { return downloadBody; },
    headers: new Headers({ "content-disposition": "attachment; filename*=UTF-8''todo%20app.mjs" }),
  };
});
assert.equal(downloadSuccess.ok, true);
if (downloadSuccess.ok) {
  assert.equal(downloadSuccess.blob, downloadBody);
  assert.equal(downloadSuccess.fileName, "todo app.mjs", "Save copy should preserve the server-provided result name");
}

const directoryDownload = await downloadArtifact("todo-directory", async () => ({
  ok: false,
  async json() { return { error: "artifact URI does not point to a file" }; },
  async blob() { return new Blob(); },
  headers: new Headers(),
}));
assert.deepEqual(
  directoryDownload,
  { ok: false, error: "This result is a folder. Use Show result to open it." },
  "directory-backed apps should remain recoverable from the Simple Mode result shelf instead of navigating to a raw 409 response",
);

let downloadCalls = 0;
let releaseDownload!: () => void;
const pendingDownload = new Promise<void>((resolve) => { releaseDownload = resolve; });
const singleFlightDownload = createSingleFlightArtifactDownloader(async () => {
  downloadCalls += 1;
  await pendingDownload;
  return { ok: false, error: "still a folder" };
});
const firstDownload = singleFlightDownload("todo-directory");
const secondDownload = singleFlightDownload("todo-directory");
await Promise.resolve();
assert.equal(downloadCalls, 1, "repeated Save copy clicks must share the in-flight request");
assert.equal(firstDownload, secondDownload, "the same artifact should share one in-flight download promise");
releaseDownload();
await firstDownload;
await secondDownload;
await singleFlightDownload("todo-directory");
assert.equal(downloadCalls, 2, "a settled Save copy attempt should allow a later retry");

const windows = artifactHandoff({
  name: "todo-app.mjs",
  uri: "file:///C:/Work/chef/todo-app.mjs",
  metadata: {},
});
assert.deepEqual(windows, {
  summary: "Chef produced todo-app.mjs.",
  location: "C:/Work/chef/todo-app.mjs",
  runCommand: null,
  verification: null,
}, "a named Windows result should remain self-describing even when optional summary metadata is absent");

const linuxWithoutSummary = artifactHandoff({
  name: "todo-app.mjs",
  uri: "file:///tmp/chef-project/todo-app.mjs",
  metadata: {
    run: "node /tmp/chef-project/todo-app.mjs",
    verifiedBy: "golden-path",
  },
});
assert.deepEqual(linuxWithoutSummary, {
  summary: "Chef produced todo-app.mjs.",
  location: "/tmp/chef-project/todo-app.mjs",
  runCommand: "node /tmp/chef-project/todo-app.mjs",
  verification: "Verified by golden-path",
}, "a named canonical result must still say what Chef produced when the worker only publishes run and verification metadata");

const unnamedLinuxFile = artifactHandoff({
  uri: "file:///tmp/chef-project/todo-app.mjs",
  metadata: {
    run: "node /tmp/chef-project/todo-app.mjs",
    verifiedBy: "golden-path",
  },
});
assert.deepEqual(unnamedLinuxFile, {
  summary: "Chef produced todo-app.mjs.",
  location: "/tmp/chef-project/todo-app.mjs",
  runCommand: "node /tmp/chef-project/todo-app.mjs",
  verification: "Verified by golden-path",
}, "a canonical file result should use its durable filename when an explicit artifact name is absent");

const unnamedWindowsFile = artifactHandoff({
  uri: "file:///C:/Work/chef/todo-app.mjs",
  metadata: {},
});
assert.deepEqual(unnamedWindowsFile, {
  summary: "Chef produced todo-app.mjs.",
  location: "C:/Work/chef/todo-app.mjs",
  runCommand: null,
  verification: null,
}, "Windows file results should derive the same self-describing fallback from their durable URI");

const explicit = artifactHandoff({
  name: "todo-app",
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
}, "worker-supplied handoff prose must remain more specific than the named-result fallback");

const explicitLocationWithoutSummary = artifactHandoff({
  uri: "sideband://result",
  metadata: {
    resultLocation: "dist/todo-app",
    runCommand: "npm start",
    verification: "Smoke test passed",
  },
});
assert.deepEqual(explicitLocationWithoutSummary, {
  summary: "Chef produced todo-app.",
  location: "dist/todo-app",
  runCommand: "npm start",
  verification: "Smoke test passed",
}, "an opaque artifact with an explicit durable result location should still explain what Chef produced");

const windowsExplicitLocationWithoutSummary = artifactHandoff({
  uri: "sideband://result",
  metadata: { path: "C:\\Work\\chef\\todo-app" },
});
assert.deepEqual(windowsExplicitLocationWithoutSummary, {
  summary: "Chef produced todo-app.",
  location: "C:\\Work\\chef\\todo-app",
  runCommand: null,
  verification: null,
}, "Windows explicit durable locations should produce the same self-describing fallback");

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
  name: "todo-app",
  uri: "sideband://result",
  metadata: { content: "Created   the todo app\nwith the requested form and list." },
});
assert.equal(noisy.summary, "Created the todo app with the requested form and list.", "worker summaries should be compact and readable in the result card");

const remote = artifactHandoff({ uri: "https://example.com/result", metadata: {} });
assert.deepEqual(remote, { summary: null, location: null, runCommand: null, verification: null }, "unnamed remote results should not invent a description when there is no durable result location");

console.log("artifact handoff behavior passed");
