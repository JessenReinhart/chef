import { strict as assert } from "node:assert";
import { sendThreadMessage } from "../web/src/threadApi.ts";
import { createThreadHistoryLoader } from "../web/src/threadSelection.ts";
import type { ChatMessage } from "../web/src/types.ts";

type PendingHistory = {
  resolve: (messages: ChatMessage[]) => void;
  reject: (error: Error) => void;
};

type PendingChat = {
  resolve: () => void;
};

const pendingHistory: PendingHistory[] = [];
const pendingChats: PendingChat[] = [];
const history = createThreadHistoryLoader(() => new Promise<ChatMessage[]>((resolve, reject) => {
  pendingHistory.push({ resolve, reject });
}));

const originalFetch = globalThis.fetch;
let chatRequests = 0;
globalThis.fetch = async (input, init) => {
  assert.equal(String(input), "/api/threads/thread-a/chat");
  assert.equal(init?.method, "POST");
  chatRequests += 1;
  const requestNumber = chatRequests;
  return await new Promise<Response>((resolve) => {
    pendingChats.push({
      resolve: () => resolve({
        ok: true,
        async json() {
          return {
            ok: true,
            data: {
              threadId: "thread-a",
              missionId: `mission-${requestNumber}`,
              report: "Chef accepted the work",
              ok: true,
            },
          };
        },
      } as Response),
    });
  });
};

try {
  const preSubmitHistory = history.load("thread-a");
  assert.equal(pendingHistory.length, 1, "the pre-submit history read should be in flight");

  const submission = sendThreadMessage("thread-a", "Create a simple todo app");
  assert.equal(pendingChats.length, 1, "submission should remain in flight until the chat mutation settles");

  const duringSubmitHistory = history.load("thread-a");
  pendingHistory[0].resolve([
    { role: "assistant", content: "Conversation before submission", timestamp: 1 },
  ] as ChatMessage[]);
  pendingHistory[1].resolve([
    { role: "assistant", content: "Still the pre-submit conversation", timestamp: 1 },
  ] as ChatMessage[]);

  assert.deepEqual(
    await preSubmitHistory,
    { current: false },
    "a history response that began before task submission must not repaint the conversation after mutation starts",
  );
  assert.deepEqual(
    await duringSubmitHistory,
    { current: false },
    "history loaded for the mutated Thread while its chat POST is still committing must stay non-authoritative",
  );

  const unrelatedHistory = history.load("thread-b");
  pendingHistory[2].resolve([
    { role: "assistant", content: "Thread B remains readable", timestamp: 2 },
  ] as ChatMessage[]);
  assert.deepEqual(
    await unrelatedHistory,
    {
      current: true,
      messages: [
        { role: "assistant", content: "Thread B remains readable", timestamp: 2 },
      ],
    },
    "switching Threads during a slow submission must not suppress the newly selected Thread's history",
  );

  pendingChats[0].resolve();
  await submission;

  const freshHistory = history.load("thread-a");
  pendingHistory[3].resolve([
    { role: "user", content: "Create a simple todo app", timestamp: 3 },
    { role: "assistant", content: "Chef accepted the work", timestamp: 4 },
  ] as ChatMessage[]);
  assert.deepEqual(
    await freshHistory,
    {
      current: true,
      messages: [
        { role: "user", content: "Create a simple todo app", timestamp: 3 },
        { role: "assistant", content: "Chef accepted the work", timestamp: 4 },
      ],
    },
    "the first post-submission history read should become authoritative normally",
  );

  const staleFailure = history.load("thread-a");
  const secondSubmission = sendThreadMessage("thread-a", "Add persistence");
  pendingHistory[4].reject(new Error("old history request failed"));
  assert.deepEqual(
    await staleFailure,
    { current: false },
    "a pre-mutation history failure must also retire silently instead of surfacing over the new submission",
  );
  pendingChats[1].resolve();
  await secondSubmission;

  assert.equal(chatRequests, 2, "both conversation mutations should still reach the chat API exactly once");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("thread-history-mutation: ok — mutation ownership stays scoped to the submitted Thread");
