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

const mixedNonSuccessStates = [
  "5 tests passed, 1 failed",
  "Linux passed; Windows failed: smoke test exited 1",
  "Build passed — browser verification timed out",
  "Unit tests passed, integration tests pending: provider unavailable",
  "No regressions observed; Windows failed: smoke test exited 1",
  "No regressions and Windows failed: smoke test exited 1",
];

for (const verification of mixedNonSuccessStates) {
  const explicit = artifactHandoff({
    uri: "file:///tmp/chef-project/todo-app.mjs",
    metadata: { verification, verifiedBy: "golden-path" },
  });
  assert.equal(
    explicit.verification,
    null,
    `mixed explicit ${JSON.stringify(verification)} must not appear beneath the positive Verified heading`,
  );

  const legacy = artifactHandoff({
    uri: "file:///tmp/chef-project/todo-app.mjs",
    metadata: { verified: verification, verifiedBy: "golden-path" },
  });
  assert.equal(
    legacy.verification,
    null,
    `mixed legacy verified=${JSON.stringify(verification)} must not become a positive verification claim`,
  );
}

const positiveVerificationValues = [
  "Smoke test passed",
  "Error handling tests passed",
  "Cancellation recovery test passed",
  "Timeout handling tests passed",
  "Blocked-request recovery passed",
  "5 tests passed, 0 failed",
  "5 tests passed, no failed tests",
  "No tests failed",
  "0 integration tests failed",
  "Zero checks failed",
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

const safeRunCommand = artifactHandoff({
  uri: "file:///tmp/chef-project/todo-app.mjs",
  metadata: {
    content: "Created runnable todo app",
    path: "/tmp/chef-project/todo-app.mjs",
    run: 'node "/tmp/chef-project/todo-app.mjs"',
    verifiedBy: "golden-path",
  },
});
assert.equal(safeRunCommand.runCommand, 'node "/tmp/chef-project/todo-app.mjs"', "normal single-line run commands must remain copyable");
assert.equal(safeRunCommand.summary, "Created runnable todo app", "run-command filtering must not disturb result summary");
assert.equal(safeRunCommand.location, "/tmp/chef-project/todo-app.mjs", "run-command filtering must not disturb result location");
assert.equal(safeRunCommand.verification, "Verified by golden-path", "run-command filtering must not disturb verification evidence");

for (const unsafeRunCommand of [
  "node todo-app.mjs\necho unexpected",
  "node todo-app.mjs\r\necho unexpected",
  "node\ttodo-app.mjs",
  "node todo-app.mjs\u0000ignored",
  "node todo-app.mjs\u007f",
  "node todo-app.mjs\u0085echo unexpected",
  "node todo-app.mjs\u2028echo unexpected",
  "node todo-app.mjs\u2029echo unexpected",
]) {
  const handoff = artifactHandoff({
    uri: "file:///tmp/chef-project/todo-app.mjs",
    metadata: { run: unsafeRunCommand },
  });
  assert.equal(
    handoff.runCommand,
    null,
    `control/multiline run metadata ${JSON.stringify(unsafeRunCommand)} must not be presented as a copyable command`,
  );
}

console.log("artifact-verification-handoff: ok — terminal and mixed non-success verification stays out of Verified, positive recovery evidence remains visible, and run instructions stay single-line/copy-safe");
