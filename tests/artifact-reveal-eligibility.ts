import { strict as assert } from "node:assert";
import { artifactHandoff, canRevealArtifact } from "../web/src/artifactHandoff.ts";

const revealable = (uri: string, metadata: Record<string, unknown> = {}) => canRevealArtifact({ uri, metadata });

assert.equal(revealable("file:///tmp/chef-project/todo-app.mjs"), true, "valid Linux file results remain revealable");
assert.equal(revealable("file:///C:/Work/chef/todo-app.mjs"), true, "valid Windows file results remain revealable");
assert.equal(revealable("file://server/share/todo-app.mjs"), true, "valid file-host/UNC results remain revealable");
assert.equal(revealable("sideband://result", { resultLocation: "dist/todo-app" }), true, "relative project-local result locations remain revealable");
assert.equal(revealable("sideband://result", { path: "C:\\Work\\chef\\todo-app" }), true, "explicit Windows result paths remain revealable");

assert.equal(revealable("file:///tmp/bad%ZZ/result"), false, "malformed artifact file URIs must not advertise a dead-end Show result action");
assert.equal(revealable("sideband://result", { resultLocation: "file:///tmp/bad%ZZ/result" }), false, "malformed explicit file-URI locations must not advertise Show result");
assert.equal(revealable("file://server"), false, "a file host without a usable path is not a revealable result");
assert.equal(revealable("https://example.com/result"), false, "remote artifacts remain non-revealable through the local result action");
assert.equal(revealable("sideband://result", { resultLocation: "https://example.com/result" }), false, "explicit remote locations remain non-revealable");

assert.equal(
  artifactHandoff({ uri: "sideband://result", metadata: { resultLocation: "file:///tmp/chef-project/todo-app.mjs" } }).location,
  "/tmp/chef-project/todo-app.mjs",
  "explicit Linux file URI locations should use the same readable filesystem path as artifact URI fallbacks",
);
assert.equal(
  artifactHandoff({ uri: "sideband://result", metadata: { resultLocation: "file:///C:/Work/chef/todo-app.mjs" } }).location,
  "C:/Work/chef/todo-app.mjs",
  "explicit Windows file URI locations should use the same readable drive path as artifact URI fallbacks",
);
assert.equal(
  artifactHandoff({ uri: "sideband://result", metadata: { resultLocation: "dist/todo-app" } }).location,
  "dist/todo-app",
  "plain relative project-local result locations must remain unchanged",
);
assert.equal(
  artifactHandoff({ uri: "sideband://result", metadata: { resultLocation: "https://example.com/result" } }).location,
  "https://example.com/result",
  "non-file explicit locations must remain unchanged instead of being reinterpreted as local paths",
);

console.log("artifact reveal eligibility behavior passed");
