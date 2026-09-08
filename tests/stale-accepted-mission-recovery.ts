import { strict as assert } from "node:assert";

import {
  ACCEPTED_MISSION_PROJECTION_GRACE_MS,
  acceptedMissionSubmissionForThread,
  acceptedMissionSubmissionIsPending,
  clearAcceptedMissionSubmission,
  missionSubmissionAccepted,
  missionSubmissionComposerState,
  rememberAcceptedMissionSubmission,
} from "../web/src/missionSubmissionFeedback.ts";

const acceptedAt = 10_000;
const accepted = missionSubmissionAccepted(
  "thread-a",
  "mission-never-projected",
  "Create a simple todo app",
  acceptedAt,
);

assert.equal(
  acceptedMissionSubmissionIsPending(
    accepted,
    "thread-a",
    [],
    acceptedAt + ACCEPTED_MISSION_PROJECTION_GRACE_MS - 1,
  ),
  true,
  "normal projection lag must keep the exact accepted Mission protected from duplicate submission",
);
assert.deepEqual(
  missionSubmissionComposerState({ submitting: false, acceptedPending: true }),
  { locked: true, label: "Starting…" },
  "Simple Mode should keep its truthful starting state inside the bounded projection grace window",
);
assert.equal(
  acceptedMissionSubmissionIsPending(
    accepted,
    "thread-b",
    [],
    acceptedAt + ACCEPTED_MISSION_PROJECTION_GRACE_MS - 1,
  ),
  false,
  "an accepted Mission must never lock another Thread while it is waiting for projection convergence",
);
assert.equal(
  acceptedMissionSubmissionIsPending(
    accepted,
    "thread-a",
    [{ id: "mission-never-projected" }],
    acceptedAt + ACCEPTED_MISSION_PROJECTION_GRACE_MS - 1,
  ),
  false,
  "authoritative Mission visibility must still retire the provisional starting state immediately",
);

rememberAcceptedMissionSubmission(accepted);
assert.equal(
  acceptedMissionSubmissionForThread(
    "thread-a",
    acceptedAt + ACCEPTED_MISSION_PROJECTION_GRACE_MS - 1,
  )?.missionId,
  "mission-never-projected",
  "the Thread-level duplicate guard must stay active throughout normal projection lag",
);
assert.equal(
  acceptedMissionSubmissionIsPending(
    accepted,
    "thread-a",
    [{ id: "mission-some-other-work" }],
    acceptedAt + 1,
  ),
  true,
  "an unrelated Mission projection must not retire the accepted submission guard",
);
assert.equal(
  acceptedMissionSubmissionForThread("thread-a", acceptedAt + 1)?.missionId,
  "mission-never-projected",
  "mismatched Mission evidence must leave the durable duplicate guard intact",
);
assert.equal(
  acceptedMissionSubmissionIsPending(
    accepted,
    "thread-a",
    [{ id: "mission-never-projected" }],
    acceptedAt + 2,
  ),
  false,
  "the exact authoritative Mission must unlock the visible starting state",
);
assert.equal(
  acceptedMissionSubmissionForThread("thread-a", acceptedAt + 2),
  null,
  "the exact authoritative Mission must also retire the durable Thread submission guard immediately",
);

const staleAccepted = missionSubmissionAccepted(
  "thread-stale",
  "mission-still-never-projected",
  "Create a notes app",
  acceptedAt,
);
rememberAcceptedMissionSubmission(staleAccepted);
assert.equal(
  acceptedMissionSubmissionForThread(
    "thread-stale",
    acceptedAt + ACCEPTED_MISSION_PROJECTION_GRACE_MS,
  ),
  null,
  "an acknowledged Mission that never becomes authoritative must stop blocking its Thread after the bounded grace window",
);
assert.deepEqual(
  missionSubmissionComposerState({ submitting: false, acceptedPending: false }),
  { locked: false, label: "Give to Chef" },
  "once the stale accepted handoff expires, Simple Mode must expose a usable recovery submission path",
);

const localOnlyAccepted = missionSubmissionAccepted(
  "thread-local",
  "mission-local",
  "Create a notes app",
  acceptedAt,
);
assert.equal(
  acceptedMissionSubmissionIsPending(
    localOnlyAccepted,
    "thread-local",
    [],
    acceptedAt + ACCEPTED_MISSION_PROJECTION_GRACE_MS,
  ),
  false,
  "component-local accepted state must obey the same bounded recovery window as the remembered Thread guard",
);

clearAcceptedMissionSubmission("thread-a");
clearAcceptedMissionSubmission("thread-stale");
clearAcceptedMissionSubmission("thread-local");

console.log("Stale accepted Mission recovery behavior passed.");
