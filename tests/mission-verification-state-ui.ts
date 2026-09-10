import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { artifactHandoff } from "../web/src/artifactHandoff.ts";

const panel = await readFile(new URL("../web/src/MissionPanel.tsx", import.meta.url), "utf8");

assert.match(panel, /aria-label="Mission verification state"/, "Mission overview should expose an explicit verification state");
assert.match(panel, /function buildVerificationSummary\(/, "verification copy should be derived from durable Mission and task state");
assert.match(panel, /mission\.status === "verifying"/, "active runtime verification should be surfaced distinctly");
assert.match(panel, /label: "Outcome verified"/, "completed Missions should expose a verified outcome state");
assert.match(panel, /label: "Verification failed"/, "failed Missions should expose unsuccessful verification");
assert.match(panel, /label: "Not verified"/, "cancelled Missions should not be presented as verified");
assert.match(panel, /label: "Blocked before verification"/, "blocked work should prevent premature verification messaging");
assert.match(panel, /successCriteria\.length > 0/, "verification state should explain explicit success criteria when available");
assert.doesNotMatch(panel, /dangerouslySetInnerHTML/, "verification copy must render as plain text");

const failureDetailPhrases = [
  "failed verification: npm test exited 1",
  "failed tests after build",
  "failed to run tests",
  "error during browser acceptance",
  "not verified because Windows acceptance was unavailable",
];
for (const verification of failureDetailPhrases) {
  const explicit = artifactHandoff({
    uri: "file:///tmp/chef-project/todo-app.mjs",
    metadata: { verification },
  });
  assert.equal(
    explicit.verification,
    null,
    `explicit failure detail ${JSON.stringify(verification)} must not be presented as successful verification`,
  );

  const legacy = artifactHandoff({
    uri: "file:///tmp/chef-project/todo-app.mjs",
    metadata: { verified: verification },
  });
  assert.equal(
    legacy.verification,
    null,
    `legacy failure detail ${JSON.stringify(verification)} must not be presented as successful verification`,
  );
}

const positiveStatusLikeProse = artifactHandoff({
  uri: "file:///tmp/chef-project/todo-app.mjs",
  metadata: { verification: "Error handling tests passed" },
});
assert.equal(
  positiveStatusLikeProse.verification,
  "Error handling tests passed",
  "status-like words in genuine positive evidence must remain visible",
);

console.log("mission-verification-state-ui: ok — Mission verification is lifecycle-derived and failed handoff prose cannot become positive evidence");
