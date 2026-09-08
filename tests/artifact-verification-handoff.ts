import { strict as assert } from "node:assert";
import { artifactHandoff } from "../web/src/artifactHandoff.ts";

const nonSuccessStates = [
  "aborted",
  "blocked",
  "canceled",
  "cancelled",
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
  "timed out",
  "timed-out",
  "timeout",
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

const detailedNonSuccessStates = [
  "Blocked: browser unavailable",
  "Canceled - user stopped the run",
  "cancelled — operator stopped the run",
  "aborted; worker exited before verification",
  "failed: npm test exited 1",
  "error - browser smoke test crashed",
  "pending: Windows acceptance",
  "not verified (provider unavailable)",
  "skipped; configured CLI unavailable",
  "Timed out. preview never became ready",
  "timed-out, provider stopped responding",
  "unverified — manual follow-up required",
];

for (const verification of detailedNonSuccessStates) {
  const explicit = artifactHandoff({
    uri: "file:///tmp/chef-project/todo-app.mjs",
    metadata: { verification, verifiedBy: "golden-path" },
  });
  assert.equal(
    explicit.verification,
    null,
    `detailed explicit ${JSON.stringify(verification)} must remain non-success evidence and must not fall through to verifiedBy`,
  );

  const legacy = artifactHandoff({
    uri: "file:///tmp/chef-project/todo-app.mjs",
    metadata: { verified: verification, verifiedBy: "golden-path" },
  });
  assert.equal(
    legacy.verification,
    null,
    `detailed legacy verified=${JSON.stringify(verification)} must not become a positive verification claim`,
  );
}

const positiveVerificationValues = [
  "Smoke test passed",
  "Error handling tests passed",
  "Cancellation recovery test passed",
  "Timeout handling tests passed",
  "Blocked-request recovery passed",
];

for (const verification of positiveVerificationValues) {
  const handoff = artifactHandoff({
    uri: "file:///tmp/chef-project/todo-app.mjs",
    metadata: { verification, verifiedBy: "golden-path" },
  });
  assert.equal(
    handoff.verification,
    verification,
    `positive worker-supplied verification evidence ${JSON.stringify(verification)} must remain visible unchanged`,
  );
}

console.log("artifact-verification-handoff: ok — terminal non-success verification stays out of Verified while positive recovery evidence remains visible");
