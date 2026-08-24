import { strict as assert } from "node:assert";
import { threadMessages } from "../web/src/threadApi.ts";
import type { ChatMessage } from "../web/src/types.ts";

type PendingResponse = {
  resolve: (messages: ChatMessage[]) => void;
  reject: (error: Error) => void;
};

const pending = new Map<string, PendingResponse>();
const originalFetch = globalThis.fetch;

globalThis.fetch = ((input: string | URL | Request) => {
  const path = String(input);
  return new Promise<Response>((resolve, reject) => {
    pending.set(path, {
      resolve: (messages) => resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data: messages }),
      } as Response),
      reject,
    });
  });
}) as typeof fetch;

try {
  const threadA = threadMessages("thread-a");
  const threadB = threadMessages("thread-b");

  const bMessage = [{ role: "user", content: "Thread B", timestamp: 2 }] as ChatMessage[];
  const aMessage = [{ role: "user", content: "Thread A", timestamp: 1 }] as ChatMessage[];

  pending.get("/api/threads/thread-b/messages")?.resolve(bMessage);
  pending.get("/api/threads/thread-a/messages")?.resolve(aMessage);

  assert.deepEqual(await threadB, bMessage, "the newest Thread history request should return its own messages");
  assert.deepEqual(await threadA, bMessage, "an older overlapping request must resolve to the newest Thread history instead of stale messages");

  const staleFailure = threadMessages("thread-c");
  const latestSuccess = threadMessages("thread-d");
  const dMessage = [{ role: "assistant", content: "Thread D", timestamp: 4 }] as ChatMessage[];

  pending.get("/api/threads/thread-d/messages")?.resolve(dMessage);
  pending.get("/api/threads/thread-c/messages")?.reject(new Error("stale request failed"));

  assert.deepEqual(await latestSuccess, dMessage, "the latest request should remain authoritative");
  assert.deepEqual(await staleFailure, dMessage, "an obsolete request failure must not replace the latest Thread history with an error");

  console.log("thread-message-selection: ok");
} finally {
  globalThis.fetch = originalFetch;
}
