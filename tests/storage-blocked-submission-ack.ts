import { strict as assert } from "node:assert";

import {
  clearMissionSubmissionFailure,
  missionSubmissionAcknowledgement,
  missionSubmissionFailureRecovery,
  rememberMissionSubmissionFailure,
  takeMissionSubmissionFailure,
} from "../web/src/missionSubmissionFeedback.ts";

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const threadARecovery = missionSubmissionFailureRecovery("Create a simple todo app", "Provider unavailable");
const threadBRecovery = missionSubmissionFailureRecovery("Create a notes app", "Provider unavailable");

try {
  rememberMissionSubmissionFailure("thread-a", threadARecovery);
  rememberMissionSubmissionFailure("thread-b", threadBRecovery);

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("Storage access denied", "SecurityError");
    },
  });

  assert.equal(
    missionSubmissionAcknowledgement(),
    "Got it. I’m starting this now.",
    "blocked browser storage must not prevent Simple Mode from acknowledging accepted work",
  );
  assert.deepEqual(
    takeMissionSubmissionFailure("thread-a"),
    threadARecovery,
    "when Thread ownership cannot be read, acknowledgement must not guess and clear another recovery owner",
  );
  assert.deepEqual(
    takeMissionSubmissionFailure("thread-b"),
    threadBRecovery,
    "storage failure must leave unrelated Thread recovery state untouched",
  );

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        return key === "chef:selected-thread" ? "thread-a" : null;
      },
    },
  });

  assert.equal(
    missionSubmissionAcknowledgement(),
    "Got it. I’m starting this now.",
    "the normal acknowledgement contract must remain unchanged when storage is available",
  );
  assert.equal(
    takeMissionSubmissionFailure("thread-a"),
    null,
    "an available selected-Thread owner must still clear its stale retry state",
  );
  assert.deepEqual(
    takeMissionSubmissionFailure("thread-b"),
    threadBRecovery,
    "clearing the selected Thread's stale retry state must not affect another Thread",
  );
} finally {
  clearMissionSubmissionFailure("thread-a");
  clearMissionSubmissionFailure("thread-b");
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}

console.log("storage-blocked-submission-ack: ok — immediate acknowledgement survives denied browser storage without guessing recovery ownership");
