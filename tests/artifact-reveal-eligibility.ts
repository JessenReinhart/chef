import { strict as assert } from "node:assert";
import { artifactHandoff, canRevealArtifact } from "../web/src/artifactHandoff.ts";

const revealable = (uri: string, metadata: Record<string, unknown> = {}) => canRevealArtifact({ uri, metadata });

assert.equal(revealable("file:///tmp/chef-project/todo-app.mjs"), true, "valid Linux file results remain revealable");
assert.equal(revealable("file:///C:/Work/chef/todo-app.mjs"), true, "valid Windows file results remain revealable");
assert.equal(revealable("file://localhost/tmp/chef-project/todo-app.mjs"), true, "localhost Linux file results remain revealable as local results");
assert.equal(revealable("file://localhost/C:/Work/chef/todo-app.mjs"), true, "localhost Windows file results remain revealable as local results");
assert.equal(revealable("file://server/share/todo-app.mjs"), false, "remote file authorities must not advertise a local Show result action");
assert.equal(revealable("file://server/C:/Work/chef/todo-app.mjs"), false, "hosted drive-like file URIs are still remote and must not advertise local reveal");
assert.equal(revealable("sideband://result", { resultLocation: "dist/todo-app" }), true, "relative project-local result locations remain revealable");
assert.equal(revealable("sideband://result", { resultLocation: "dist/../todo-app" }), true, "relative paths that normalize within the project remain revealable");
assert.equal(revealable("sideband://result", { path: "C:\\Work\\chef\\todo-app" }), true, "explicit Windows result paths remain revealable");

assert.equal(revealable("file:///tmp/bad%ZZ/result"), false, "malformed artifact file URIs must not advertise a dead-end Show result action");
assert.equal(revealable("sideband://result", { resultLocation: "file:///tmp/bad%ZZ/result" }), false, "malformed explicit file-URI locations must not advertise Show result");
assert.equal(revealable("file://server"), false, "a file host without a usable path is not a revealable result");
assert.equal(revealable("https://example.com/result"), false, "remote artifacts remain non-revealable through the local result action");
assert.equal(revealable("sideband://result", { resultLocation: "https://example.com/result" }), false, "explicit remote locations remain non-revealable");
assert.equal(revealable("sideband://result", { resultLocation: "//example.com/results/todo-app" }), false, "protocol-relative remote locations must not masquerade as project-local reveal paths");
assert.equal(revealable("sideband://result", { resultLocation: "\\\\fileserver\\share\\todo-app" }), false, "UNC/network-style metadata must not advertise a project-local Show result action");
assert.equal(revealable("sideband://result", { resultLocation: "../outside/todo-app" }), false, "leading relative traversal must not advertise a project-local Show result action");
assert.equal(revealable("sideband://result", { resultLocation: "dist/../../outside/todo-app" }), false, "normalized relative traversal escaping the project must not advertise Show result");
assert.equal(revealable("sideband://result", { resultLocation: "dist\\..\\..\\outside\\todo-app" }), false, "Windows-style relative traversal escaping the project must not advertise Show result");

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
  artifactHandoff({ uri: "sideband://result", metadata: { resultLocation: "file://localhost/tmp/chef-project/todo-app.mjs" } }).location,
  "/tmp/chef-project/todo-app.mjs",
  "localhost Linux file URI locations should be projected as local filesystem paths rather than UNC-style paths",
);
assert.equal(
  artifactHandoff({ uri: "sideband://result", metadata: { resultLocation: "file://localhost/C:/Work/chef/todo-app.mjs" } }).location,
  "C:/Work/chef/todo-app.mjs",
  "localhost Windows file URI locations should be projected as local drive paths rather than //localhost paths",
);
assert.equal(
  artifactHandoff({ uri: "sideband://result", metadata: { resultLocation: "file://fileserver/share/todo-app.mjs" } }).location,
  "//fileserver/share/todo-app.mjs",
  "a genuine remote file authority must remain a UNC/network result location",
);
assert.equal(
  artifactHandoff({ uri: "sideband://result", metadata: { resultLocation: "file://fileserver/C:/Work/chef/todo-app.mjs" } }).location,
  "//fileserver/C:/Work/chef/todo-app.mjs",
  "a hosted Windows drive-like pathname must retain the separator between authority and path",
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

for (const verification of ["Failed. npm test exited 1", "Pending, Windows acceptance"] as const) {
  assert.equal(
    artifactHandoff({ uri: "file:///tmp/chef-project/todo-app.mjs", metadata: { verification } }).verification,
    null,
    `punctuation-delimited explicit verification=${JSON.stringify(verification)} must not appear beneath the positive Verified heading`,
  );
  assert.equal(
    artifactHandoff({ uri: "file:///tmp/chef-project/todo-app.mjs", metadata: { verified: verification } }).verification,
    null,
    `punctuation-delimited legacy verified=${JSON.stringify(verification)} must not appear beneath the positive Verified heading`,
  );
}
assert.equal(
  artifactHandoff({ uri: "file:///tmp/chef-project/todo-app.mjs", metadata: { verification: "Error handling tests passed" } }).verification,
  "Error handling tests passed",
  "positive verification prose beginning with a status-like word must remain visible",
);

for (const verifiedBy of ["npm test (failed)", "npm test [failed]", "browser smoke (error)"] as const) {
  assert.equal(
    artifactHandoff({ uri: "file:///tmp/chef-project/todo-app.mjs", metadata: { verifiedBy } }).verification,
    null,
    `parenthesized or bracketed negative verifiedBy=${JSON.stringify(verifiedBy)} must not be presented as successful verification`,
  );
}
for (const verifiedBy of ["failure-analysis-agent", "failure analysis agent", "error-handling-checker"] as const) {
  assert.equal(
    artifactHandoff({ uri: "file:///tmp/chef-project/todo-app.mjs", metadata: { verifiedBy } }).verification,
    `Verified by ${verifiedBy}`,
    `legitimate verifier name ${JSON.stringify(verifiedBy)} must remain visible`,
  );
}

console.log("artifact reveal eligibility and handoff truthfulness behavior passed");
