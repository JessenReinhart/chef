import { strict as assert } from "node:assert";
import {
  createThreadHistoryLoader,
  foregroundThreadId,
  isThreadSubmissionPending,
  latestAssistantThreadNote,
  latestMissionForSelectedThread,
  loadForSelectedThread,
  messagesForThreadSelection,
  missionsForSelectedThread,
  missionStatusForSelectedThread,
  moveThreadSubmissionPending,
  resolveHomeThreadSelection,
  setThreadSubmissionPending,
  threadSubmissionKey,
  threadSubmissionOwnsForeground,
} from "../web/src/threadSelection.ts";
import type { UiThread } from "../web/src/threadApi.ts";
import type { ChatMessage, UiMission } from "../web/src/types.ts";

type PendingLoad = {
  resolve: (messages: ChatMessage[]) => void;
  reject: (error: Error) => void;
};

const pending = new Map<string, PendingLoad>();
const history = createThreadHistoryLoader((threadId) => new Promise<ChatMessage[]>((resolve, reject) => {
  pending.set(threadId, { resolve, reject });
}));

const first = history.load("thread-a");
const second = history.load("thread-b");

const aMessages = [{ role: "user", content: "Thread A", timestamp: 1 }] as ChatMessage[];
const bMessages = [{ role: "user", content: "Thread B", timestamp: 2 }] as ChatMessage[];

pending.get("thread-b")?.resolve(bMessages);
pending.get("thread-a")?.resolve(aMessages);

assert.deepEqual(await second, { current: true, messages: bMessages }, "the latest Thread selection should own its history response");
assert.deepEqual(await first, { current: false }, "a slower earlier Thread response must be ignored");

const staleFailure = history.load("thread-c");
const latestSuccess = history.load("thread-d");
const dMessages = [{ role: "assistant", content: "Thread D", timestamp: 4 }] as ChatMessage[];

pending.get("thread-d")?.resolve(dMessages);
pending.get("thread-c")?.reject(new Error("stale Thread request failed"));

assert.deepEqual(await latestSuccess, { current: true, messages: dMessages }, "the newest Thread history should remain authoritative");
assert.deepEqual(await staleFailure, { current: false }, "a stale Thread failure must not surface over the latest selection");

// The foreground Thread identity changes before its history request can settle.
// Fail closed during that window: the previous Thread's conversation must not
// remain visible under the newly selected Thread, including when loading fails.
const selectionPending = new Map<string, PendingLoad>();
const selectionHistory = createThreadHistoryLoader((threadId) => new Promise<ChatMessage[]>((resolve, reject) => {
  selectionPending.set(threadId, { resolve, reject });
}));
let visibleSelectionMessages = messagesForThreadSelection("thread-a", "thread-b", aMessages);
assert.deepEqual(
  visibleSelectionMessages,
  [],
  "switching Threads must immediately remove the previous Thread conversation while the new history is pending",
);

const failedThreadBLoad = selectionHistory.load("thread-b");
selectionPending.get("thread-b")?.reject(new Error("Thread B history unavailable"));
await assert.rejects(failedThreadBLoad, /Thread B history unavailable/);
assert.deepEqual(
  visibleSelectionMessages,
  [],
  "a failed selected-Thread history request must not restore or retain the previous Thread conversation",
);

const successfulThreadBLoad = selectionHistory.load("thread-b");
selectionPending.get("thread-b")?.resolve(bMessages);
const loadedThreadB = await successfulThreadBLoad;
assert.equal(loadedThreadB.current, true, "the selected Thread should still accept its own successful history response");
if (loadedThreadB.current) visibleSelectionMessages = loadedThreadB.messages;
assert.deepEqual(
  visibleSelectionMessages,
  bMessages,
  "successful selected-Thread history should become the visible conversation normally",
);
assert.deepEqual(
  messagesForThreadSelection("thread-b", "thread-b", bMessages),
  bMessages,
  "reselecting the already visible Thread may keep its owned conversation",
);
assert.deepEqual(
  messagesForThreadSelection("thread-b", null, bMessages),
  [],
  "archiving the last active Thread must clear its conversation when no foreground Thread remains",
);
assert.deepEqual(
  messagesForThreadSelection("thread-b", "thread-c", bMessages),
  [],
  "archive-driven selection of another active Thread must clear the archived Thread conversation before loading the replacement",
);

// Submission-in-progress UI is owned by the Thread that submitted the work.
// Switching to another Thread must leave that Thread usable, switching back
// must still block a duplicate in the original Thread, and overlapping
// submissions must not clear one another when they finish out of order.
let pendingSubmissions = new Set<string>();
pendingSubmissions = setThreadSubmissionPending(pendingSubmissions, threadSubmissionKey("thread-a"), true);
assert.equal(isThreadSubmissionPending(pendingSubmissions, "thread-a"), true, "Thread A should show its own starting state");
assert.equal(isThreadSubmissionPending(pendingSubmissions, "thread-b"), false, "switching to Thread B must not inherit Thread A's starting state");
assert.equal(!pendingSubmissions.has(threadSubmissionKey("thread-b")), true, "Thread B should remain eligible for an independent submission while A starts");
assert.equal(isThreadSubmissionPending(pendingSubmissions, "thread-a"), true, "switching back to Thread A before completion must restore its pending state");
assert.equal(!pendingSubmissions.has(threadSubmissionKey("thread-a")), false, "returning to Thread A must not make a duplicate submission eligible while its first request is pending");

pendingSubmissions = setThreadSubmissionPending(pendingSubmissions, threadSubmissionKey("thread-b"), true);
assert.equal(isThreadSubmissionPending(pendingSubmissions, "thread-a"), true, "Thread A can keep working in the background");
assert.equal(isThreadSubmissionPending(pendingSubmissions, "thread-b"), true, "Thread B can start independent work while Thread A is still running");

pendingSubmissions = setThreadSubmissionPending(pendingSubmissions, threadSubmissionKey("thread-a"), false);
assert.equal(isThreadSubmissionPending(pendingSubmissions, "thread-a"), false, "Thread A completion should clear only Thread A's transient state");
assert.equal(isThreadSubmissionPending(pendingSubmissions, "thread-b"), true, "Thread A completion must not clear Thread B's in-flight state");

// A fresh project has no selected Thread when the first request starts. Once
// Chef creates/selects the initial Thread, ownership must move to that exact
// Thread instead of making the temporary key behave like a wildcard.
const newThreadKey = threadSubmissionKey(null);
let freshProjectSubmissions = setThreadSubmissionPending(new Set<string>(), newThreadKey, true);
assert.equal(isThreadSubmissionPending(freshProjectSubmissions, null), true, "the first fresh-project request should be pending before a Thread exists");
assert.equal(
  threadSubmissionOwnsForeground(null, null),
  true,
  "a very fast fresh-project request should still own feedback before the first Thread selection event arrives",
);
assert.equal(isThreadSubmissionPending(freshProjectSubmissions, "thread-created"), false, "the temporary new-Thread key must not disable arbitrary concrete Threads");
freshProjectSubmissions = moveThreadSubmissionPending(freshProjectSubmissions, newThreadKey, threadSubmissionKey("thread-created"));
assert.equal(isThreadSubmissionPending(freshProjectSubmissions, null), false, "new-Thread ownership should leave the temporary key after creation");
assert.equal(isThreadSubmissionPending(freshProjectSubmissions, "thread-created"), true, "the Thread Chef creates for the first request must inherit the pending state");
assert.equal(isThreadSubmissionPending(freshProjectSubmissions, "thread-unrelated"), false, "an unrelated Thread must remain usable while the created Thread is still starting");
assert.equal(
  threadSubmissionOwnsForeground(null, "thread-created", "thread-created"),
  true,
  "the first fresh-project request should still own completion feedback after Chef creates/selects its Thread",
);
assert.equal(
  threadSubmissionOwnsForeground(null, "thread-unrelated", "thread-created"),
  false,
  "fresh-project completion feedback must not overwrite an unrelated Thread selected before settlement",
);
assert.equal(
  threadSubmissionOwnsForeground("thread-a", "thread-a", "thread-created"),
  true,
  "concrete Thread submissions must keep their original owner even when a transferred id is supplied",
);
freshProjectSubmissions = setThreadSubmissionPending(freshProjectSubmissions, threadSubmissionKey("thread-created"), false);
assert.equal(isThreadSubmissionPending(freshProjectSubmissions, "thread-created"), false, "settling the original first request should release only the created Thread composer");

// A task submission may finish after the user has moved to another Thread.
// The background work still belongs to its original Thread, but its late UI
// feedback must not mutate the foreground Thread's draft/report/error state.
let selectedSubmissionThread: string | null = "thread-a";
let foregroundDraft = "";
let foregroundReport: string | null = null;
let foregroundError: string | null = null;
let resolveSubmission: ((report: string) => void) | null = null;
const submission = new Promise<string>((resolve) => {
  resolveSubmission = resolve;
});
const applySubmission = submission.then((report) => {
  if (!threadSubmissionOwnsForeground("thread-a", selectedSubmissionThread)) return;
  foregroundDraft = "";
  foregroundReport = report;
});

selectedSubmissionThread = "thread-b";
foregroundDraft = "Draft for Thread B";
resolveSubmission?.("Thread A todo app created");
await applySubmission;
assert.equal(selectedSubmissionThread, "thread-b", "background completion must not steal the foreground Thread");
assert.equal(foregroundDraft, "Draft for Thread B", "background completion must not clear the new Thread draft");
assert.equal(foregroundReport, null, "background completion must not surface its report in the new Thread");

let rejectSubmission: ((error: Error) => void) | null = null;
const failingSubmission = new Promise<never>((_resolve, reject) => {
  rejectSubmission = reject;
});
const applyFailure = failingSubmission.catch((error: Error) => {
  if (threadSubmissionOwnsForeground("thread-a", selectedSubmissionThread)) {
    foregroundError = error.message;
  }
});
rejectSubmission?.(new Error("Thread A worker failed"));
await applyFailure;
assert.equal(foregroundError, null, "background failure must not leak an error into the selected Thread");
assert.equal(threadSubmissionOwnsForeground("thread-b", selectedSubmissionThread), true, "the selected Thread still owns its own eventual feedback");

// Simple Mode uses the same loader for the conversational Chef note. A slow
// response from the previously selected Thread must never overwrite the note
// for the Thread the user switched to.
const notePending = new Map<string, PendingLoad>();
const noteHistory = createThreadHistoryLoader((threadId) => new Promise<ChatMessage[]>((resolve, reject) => {
  notePending.set(threadId, { resolve, reject });
}));
const oldThreadNote = noteHistory.load("thread-old");
const selectedThreadNote = noteHistory.load("thread-selected");
const oldAssistant = [{ role: "assistant", content: "Old Thread result", timestamp: 5 }] as ChatMessage[];
const selectedAssistant = [{ role: "assistant", content: "Selected Thread result", timestamp: 6 }] as ChatMessage[];
notePending.get("thread-selected")?.resolve(selectedAssistant);
notePending.get("thread-old")?.resolve(oldAssistant);
assert.deepEqual(await selectedThreadNote, { current: true, messages: selectedAssistant }, "the selected Thread assistant note should stay authoritative");
assert.deepEqual(await oldThreadNote, { current: false }, "a late assistant note from the previous Thread must be ignored");

// The live activity rail has its own authoritative workspace state read. A slow
// read begun for the previous Thread must obey the same foreground ownership
// boundary as history and submission feedback.
let selectedActivityThread: string | null = "thread-a";
let resolveActivityState: ((value: { marker: string }) => void) | null = null;
const delayedActivityState = new Promise<{ marker: string }>((resolve) => {
  resolveActivityState = resolve;
});
const staleActivityRefresh = loadForSelectedThread(
  "thread-a",
  () => selectedActivityThread,
  () => delayedActivityState,
);
selectedActivityThread = "thread-b";
resolveActivityState?.({ marker: "thread-a-state" });
assert.deepEqual(
  await staleActivityRefresh,
  { current: false },
  "a slow Simple Mode activity read must be discarded after the foreground Thread changes",
);

let currentActivityLoads = 0;
assert.deepEqual(
  await loadForSelectedThread(
    "thread-b",
    () => selectedActivityThread,
    async () => {
      currentActivityLoads += 1;
      return { marker: "thread-b-state" };
    },
  ),
  { current: true, value: { marker: "thread-b-state" } },
  "the selected Thread should still receive its own authoritative activity snapshot",
);
assert.equal(currentActivityLoads, 1, "a current activity refresh should perform exactly one authoritative read");

selectedActivityThread = null;
assert.deepEqual(
  await loadForSelectedThread(null, () => selectedActivityThread, async () => ({ marker: "workspace-state" })),
  { current: true, value: { marker: "workspace-state" } },
  "workspace-level activity should remain valid when no Thread is selected",
);

const missionResults = [
  { role: "user", content: "Create a todo app", timestamp: 7 },
  { role: "assistant", content: "Older Mission finished", timestamp: 8, metadata: { missionId: "mission-old", ok: true } },
  { role: "assistant", content: "Todo app created. Run npm start. Smoke test passed.", timestamp: 9, metadata: { missionId: "mission-todo", ok: true } },
  { role: "assistant", content: "Unrelated newer reply", timestamp: 10, metadata: { missionId: "mission-newer", ok: true } },
] as ChatMessage[];
assert.equal(
  latestAssistantThreadNote(missionResults, "mission-todo")?.content,
  "Todo app created. Run npm start. Smoke test passed.",
  "terminal Simple Mode handoff must select the persisted assistant result for the exact Mission instead of a newer unrelated reply",
);
assert.equal(
  latestAssistantThreadNote(missionResults)?.content,
  "Unrelated newer reply",
  "normal Thread note loading should still use the newest assistant reply when no Mission is requested",
);
assert.equal(
  latestAssistantThreadNote(missionResults, "mission-missing"),
  null,
  "a terminal Mission without a persisted assistant turn yet must not borrow another Mission's summary",
);

const workspaceMissions = [
  { id: "mission-selected-old", goal: "Older selected work", status: "completed", taskIds: [], metadata: { threadId: "thread-selected" }, createdAt: 11, updatedAt: 11 },
  { id: "mission-other-new", goal: "Other Thread work", status: "active", taskIds: [], metadata: { threadId: "thread-other" }, createdAt: 13, updatedAt: 13 },
  { id: "mission-selected-new", goal: "Selected todo app", status: "completed", taskIds: [], metadata: { threadId: "thread-selected" }, createdAt: 12, updatedAt: 12 },
] as UiMission[];
assert.deepEqual(
  missionsForSelectedThread(workspaceMissions, "thread-selected").map((mission) => mission.id),
  ["mission-selected-old", "mission-selected-new"],
  "Simple Mode activity must exclude a newer Mission that belongs to another Thread",
);
assert.deepEqual(
  missionsForSelectedThread(workspaceMissions, "thread-missing"),
  [],
  "a selected Thread with no Mission must not fall back to workspace-global activity",
);
assert.deepEqual(
  missionsForSelectedThread(workspaceMissions, null).map((mission) => mission.id),
  workspaceMissions.map((mission) => mission.id),
  "workspace-level activity remains available when no Thread is selected",
);
const selectedLatestMission = latestMissionForSelectedThread(workspaceMissions, "thread-selected");
assert.equal(
  selectedLatestMission?.id,
  "mission-selected-new",
  "the selected Thread must keep its own latest Mission even when another Thread has a newer workspace Mission",
);
assert.equal(
  missionStatusForSelectedThread(selectedLatestMission, "thread-selected", "active"),
  "completed",
  "selected-Thread status must come from that Thread's Mission instead of the workspace-global active state",
);
const missingThreadMission = latestMissionForSelectedThread(workspaceMissions, "thread-missing");
assert.equal(missingThreadMission, undefined, "a Thread with no Mission must not borrow another Thread's Mission focus");
assert.equal(
  missionStatusForSelectedThread(missingThreadMission, "thread-missing", "active"),
  "idle",
  "a selected Thread with no Mission must stay idle instead of inheriting another Thread's workspace activity",
);
assert.equal(
  latestMissionForSelectedThread(workspaceMissions, null)?.id,
  "mission-other-new",
  "without a selected Thread the workspace may still expose its globally latest Mission",
);
assert.equal(
  missionStatusForSelectedThread(undefined, null, "active"),
  "active",
  "without a selected Thread the existing workspace-level status fallback remains valid",
);

const snapshot = history.snapshot();
history.invalidate();
assert.equal(history.isCurrent(snapshot), false, "selection changes outside history loading should invalidate older requests");

const threads = [
  { id: "active-a", workspaceId: "ws", title: "Current work", status: "active", createdAt: 1, updatedAt: 4 },
  { id: "archived-a", workspaceId: "ws", title: "Old investigation", status: "archived", createdAt: 2, updatedAt: 3 },
] as UiThread[];

const rememberedArchive = resolveHomeThreadSelection(threads, "archived-a");
assert.deepEqual(rememberedArchive.activeThreads.map((thread) => thread.id), ["active-a"]);
assert.deepEqual(rememberedArchive.archivedThreads.map((thread) => thread.id), ["archived-a"]);
assert.equal(rememberedArchive.selectedThread?.id, "archived-a", "refresh should preserve a remembered archived Thread so its history stays discoverable");
assert.equal(foregroundThreadId(rememberedArchive), "archived-a", "the persisted archived selection remains the resolved foreground continuity boundary");
assert.equal(rememberedArchive.readOnly, true, "archived Thread selection must be read-only for new work");

const defaultSelection = resolveHomeThreadSelection(threads, null);
assert.equal(defaultSelection.selectedThread?.id, "active-a", "Home should still prefer an active Thread when there is no remembered selection");
assert.equal(foregroundThreadId(defaultSelection), "active-a", "fresh Simple Mode should persist and submit against the active Thread it visibly selected before new work starts");
assert.equal(defaultSelection.readOnly, false);

const missingSelection = resolveHomeThreadSelection(threads, "missing");
assert.equal(missingSelection.selectedThread?.id, "active-a", "a stale remembered id should recover to an active Thread");
assert.equal(foregroundThreadId(missingSelection), "active-a", "a stale persisted id must resolve to the same Thread the user sees before new work starts");

console.log("thread-selection-race: ok — Thread switching, message ownership, submission feedback, live activity, Mission state, and terminal summaries stay isolated");
