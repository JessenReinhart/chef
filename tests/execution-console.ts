import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const consoleSource = readFileSync(resolve("web/src/ConsolePanel.tsx"), "utf8");
const appSource = readFileSync(resolve("web/src/App.tsx"), "utf8");

describe("execution console acceptance", () => {
  it("keeps the required runtime projection tabs", () => {
    for (const tab of ["timeline", "artifacts", "blockers", "events", "chat", "terminal"]) {
      assert.match(consoleSource, new RegExp(`id: \\"${tab}\\"`));
    }
  });

  it("projects live task state and progress without client-owned execution state", () => {
    assert.match(consoleSource, /statusFromEvents\(/);
    assert.match(consoleSource, /eventTiming\(/);
    assert.match(consoleSource, /role="progressbar"/);
    assert.match(consoleSource, /wb-console__progress-indeterminate/);
  });

  it("keeps retry and approval actions on runtime APIs", () => {
    assert.match(consoleSource, /api\.retryNode\(/);
    assert.match(consoleSource, /api\.approve\(/);
    assert.match(consoleSource, /Retry/);
    assert.match(consoleSource, /Accept/);
    assert.match(consoleSource, /Reject/);
  });

  it("shows durable artifact result actions", () => {
    assert.match(consoleSource, /Preview/);
    assert.match(consoleSource, /Download/);
    assert.match(consoleSource, /Share/);
    assert.match(consoleSource, /artifact\.version/);
    assert.match(consoleSource, /artifact\.createdBy/);
  });

  it("shows real counts and explicit unknown usage values", () => {
    assert.match(consoleSource, /label: "Live sessions"/);
    assert.match(consoleSource, /label: "Artifacts"/);
    assert.match(consoleSource, /metrics\.cost === null \? "unknown"/);
    assert.match(consoleSource, /metrics\.tokens === null \? "unknown"/);
    assert.match(consoleSource, /metrics\.elapsedMs === null \? "unknown"/);
    assert.match(appSource, /payload\.tokens \?\? payload\.totalTokens \?\? payload\.tokenCount/);
    assert.match(appSource, /payload\.cost \?\? payload\.costUsd/);
  });
});
