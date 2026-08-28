import { strict as assert } from "node:assert";
import { createThreadHistoryLoader, latestAssistantThreadNote, resolveHomeThreadSelection } from "../web/src/threadSelection.ts";
import type { UiThread } from "../web/src/threadApi.ts";
import type { ChatMessage } from "../web/src/types.ts";

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
assert.equal(rememberedArchive.readOnly, true, "archived Thread selection must be read-only for new work");

const defaultSelection = resolveHomeThreadSelection(threads, null);
assert.equal(defaultSelection.selectedThread?.id, "active-a", "Home should still prefer an active Thread when there is no remembered selection");
assert.equal(defaultSelection.readOnly, false);

const missingSelection = resolveHomeThreadSelection(threads, "missing");
assert.equal(missingSelection.selectedThread?.id, "active-a", "a stale remembered id should recover to an active Thread");

console.log("thread-selection-race: ok — Thread switching and Mission-specific terminal summaries stay isolated");
