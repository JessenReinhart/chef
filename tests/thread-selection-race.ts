import { strict as assert } from "node:assert";
import {
  createThreadHistoryLoader,
  foregroundThreadId,
  isThreadSubmissionPending,
  latestAssistantThreadNote,
  missionsForSelectedThread,
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

// A fresh project has no selected Thread when the first request starts. Chef can
// create/select the initial Thread before that request settles. The temporary
// new-Thread key must therefore continue to disable the newly selected Thread
// until the original request clears it, without changing normal A -> B ownership.
const newThreadKey = threadSubmissionKey(null);
let freshProjectSubmissions = setThreadSubmissionPending(new Set<string>(), newThreadKey, true);
assert.equal(isThreadSubmissionPending(freshProjectSubmissions, null), true, "the first fresh-project request should be pending before a Thread exists");
assert.equal(isThreadSubmissionPending(freshProjectSubmissions, "thread-created"), true, "the Thread Chef creates for the first request must stay pending while that request is unresolved");
freshProjectSubmissions = setThreadSubmissionPending(freshProjectSubmissions, newThreadKey, false);
assert.equal(isThreadSubmissionPending(freshProjectSubmissions, "thread-created"), false, "settling the original first request should release the created Thread composer");

pendingSubmissions = setThreadSubmissionPending(new Set(), newThreadKey, true);
pendingSubmissions = moveThreadSubmissionPending(pendingSubmissions, newThreadKey, threadSubmissionKey("thread-created"));
assert.equal(pendingSubmissions.has(newThreadKey), false, "new-Thread submission state should leave the temporary key after explicit ownership transfer");
assert.equal(pendingSubmissions.has(threadSubmissionKey("thread-created")), true, "the created Thread should inherit its own in-flight state after explicit ownership transfer");

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
  { id: "mission-selected-new", goal: "Selected todo app", status: "active", taskIds: [], metadata: { threadId: "thread-selected" }, createdAt: 12, updatedAt: 12 },
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

console.log("thread-selection-race: ok — Thread switching, first-Thread startup, concurrent submissions, Mission activity, and terminal summaries stay isolated");
