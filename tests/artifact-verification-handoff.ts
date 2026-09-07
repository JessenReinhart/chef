import { strict as assert } from "node:assert";
import { artifactHandoff } from "../web/src/artifactHandoff.ts";

const nonSuccessStates = [
  "false",
  "fail",
  "failed",
  "failure",
  "error",
  "errored",
  "no",
  "not checked",
  "not run",
  "not verified",
  "pending",
  "skipped",
  "unchecked",
  "unknown",
  "unverified",
];

for (const verification of nonSuccessStates) {
  const explicit = artifactHandoff({
    uri: "file:///tmp/chef-project/todo-app.mjs",
    metadata: { verification, verifiedBy: "golden-path" },
  });
  assert.equal(
    explicit.verification,
    null,
    `explicit ${JSON.stringify(verification)} must not appear beneath the positive Verified heading or fall through to verifiedBy`,
  );

  const legacy = artifactHandoff({
    uri: "file:///tmp/chef-project/todo-app.mjs",
    metadata: { verified: verification, verifiedBy: "golden-path" },
  });
  assert.equal(
    legacy.verification,
    null,
    `legacy verified=${JSON.stringify(verification)} must not become a positive verification claim`,
  );
}

const positive = artifactHandoff({
  uri: "file:///tmp/chef-project/todo-app.mjs",
  metadata: { verification: "Smoke test passed", verifiedBy: "golden-path" },
});
assert.equal(positive.verification, "Smoke test passed", "positive worker-supplied verification evidence must remain visible unchanged");

console.log("artifact verification handoff behavior passed");
