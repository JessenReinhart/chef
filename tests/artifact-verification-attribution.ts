import { strict as assert } from "node:assert";
import { artifactHandoff } from "../web/src/artifactHandoff.ts";

const positiveVerifier = artifactHandoff({
  uri: "file:///tmp/chef-project/todo-app.mjs",
  metadata: { verifiedBy: "golden-path" },
});
assert.equal(
  positiveVerifier.verification,
  "Verified by golden-path",
  "a genuine verifier/source attribution must remain visible in the completed result handoff",
);

for (const verifiedBy of [
  "failed tests",
  "failed verification: npm test exited 1",
  "error during smoke test",
  "not verified by worker",
  "pending verification",
]) {
  const handoff = artifactHandoff({
    uri: "file:///tmp/chef-project/todo-app.mjs",
    metadata: { verifiedBy },
  });
  assert.equal(
    handoff.verification,
    null,
    `negative verifiedBy=${JSON.stringify(verifiedBy)} must not be presented as successful verification`,
  );
}

const statusLikeVerifierName = artifactHandoff({
  uri: "file:///tmp/chef-project/todo-app.mjs",
  metadata: { verifiedBy: "failure-analysis-agent" },
});
assert.equal(
  statusLikeVerifierName.verification,
  "Verified by failure-analysis-agent",
  "a legitimate verifier name that merely starts with a status-like token must not be suppressed",
);

const explicitPositiveStillWins = artifactHandoff({
  uri: "file:///tmp/chef-project/todo-app.mjs",
  metadata: {
    verification: "Smoke test passed",
    verifiedBy: "failed tests",
  },
});
assert.equal(
  explicitPositiveStillWins.verification,
  "Smoke test passed",
  "explicit positive verification evidence remains authoritative over malformed legacy attribution",
);

console.log("artifact-verification-attribution: ok — verifier attribution cannot turn negative result metadata into false success");
