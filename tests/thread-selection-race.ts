import { strict as assert } from "node:assert";
import { createThreadHistoryLoader } from "../web/src/threadSelection.ts";
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

const snapshot = history.snapshot();
history.invalidate();
assert.equal(history.isCurrent(snapshot), false, "selection changes outside history loading should invalidate older requests");

console.log("thread-selection-race: ok");
