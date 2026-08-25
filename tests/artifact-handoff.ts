import { strict as assert } from "node:assert";
import { artifactHandoff } from "../web/src/artifactHandoff.ts";

const canonical = artifactHandoff({
  uri: "file:///tmp/chef-project/todo-app.mjs",
  metadata: {
    run: "node /tmp/chef-project/todo-app.mjs",
    verifiedBy: "golden-path",
  },
});
assert.equal(canonical.location, "/tmp/chef-project/todo-app.mjs");
assert.equal(canonical.runCommand, "node /tmp/chef-project/todo-app.mjs");
assert.equal(canonical.verification, "Verified by golden-path");

const windows = artifactHandoff({
  uri: "file:///C:/Work/chef/todo-app.mjs",
  metadata: {},
});
assert.equal(windows.location, "C:/Work/chef/todo-app.mjs", "Windows file URIs should not show a browser-style leading slash");

const explicit = artifactHandoff({
  uri: "file:///tmp/internal-name.bin",
  metadata: {
    resultLocation: "dist/todo-app",
    runCommand: "npm start",
    verification: "Smoke test passed",
  },
});
assert.deepEqual(explicit, {
  location: "dist/todo-app",
  runCommand: "npm start",
  verification: "Smoke test passed",
});

const remote = artifactHandoff({ uri: "https://example.com/result", metadata: {} });
assert.deepEqual(remote, { location: null, runCommand: null, verification: null });

console.log("artifact handoff behavior passed");
