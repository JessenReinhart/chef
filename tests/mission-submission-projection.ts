import { strict as assert } from "node:assert";

import {
  ACCEPTED_MISSION_PROJECTION_GRACE_MS,
  acceptedMissionSubmissionIsPending,
  clearAcceptedMissionSubmission,
  missionSubmissionAccepted,
} from "../web/src/missionSubmissionFeedback.ts";

const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: {
    getItem(key: string) { return storage.get(key) ?? null; },
    setItem(key: string, value: string) { storage.set(key, value); },
    removeItem(key: string) { storage.delete(key); },
  },
});

try {
  const acceptedAt = 1_000;
  const accepted = missionSubmissionAccepted(
    "thread-slow-start",
    "mission-slow-start",
    "Create a simple todo app",
    acceptedAt,
  );

  assert.equal(
    acceptedMissionSubmissionIsPending(accepted, "thread-slow-start", [], acceptedAt + 45_000),
    true,
    "Simple Mode must stay single-flight beyond the old 30 second projection window while accepted work is still starting",
  );

  assert.equal(
    acceptedMissionSubmissionIsPending(null, "thread-slow-start", [], acceptedAt + 45_000),
    true,
    "a Simple Mode remount must recover accepted Mission ownership instead of unlocking duplicate submission",
  );

  assert.equal(
    acceptedMissionSubmissionIsPending(
      null,
      "thread-slow-start",
      [{ id: "mission-slow-start" }],
      acceptedAt + 45_001,
    ),
    false,
    "the recovered guard must retire immediately when the exact accepted Mission becomes authoritative",
  );

  const bounded = missionSubmissionAccepted(
    "thread-bounded",
    "mission-never-projects",
    "Create a simple todo app",
    acceptedAt,
  );
  assert.equal(
    acceptedMissionSubmissionIsPending(null, "thread-bounded", [], acceptedAt + ACCEPTED_MISSION_PROJECTION_GRACE_MS),
    false,
    "a never-projected acknowledgement must still fail open at the bounded grace limit",
  );
  clearAcceptedMissionSubmission("thread-bounded");
} finally {
  clearAcceptedMissionSubmission("thread-slow-start");
  clearAcceptedMissionSubmission("thread-bounded");
  if (originalSessionStorage) Object.defineProperty(globalThis, "sessionStorage", originalSessionStorage);
  else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
}

console.log("mission submission projection acceptance passed");
