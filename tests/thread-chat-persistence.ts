import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Repository } from "../src/persistence/database.ts";
import { createChatRepository } from "../src/persistence/chat.ts";
import { createThreadRepository } from "../src/persistence/threads.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-thread-chat-"));
const dbPath = join(dir, "chef.sqlite");

try {
  const repo = new Repository(dbPath);
  repo.createWorkspace({ id: "workspace-a", name: "Workspace A" });
  repo.createWorkspace({ id: "workspace-b", name: "Workspace B" });

  const threads = createThreadRepository(repo);
  threads.create({ id: "thread-auth", workspaceId: "workspace-a", title: "Authentication" });
  threads.create({ id: "thread-dashboard", workspaceId: "workspace-a", title: "Dashboard" });
  threads.create({ id: "thread-order", workspaceId: "workspace-a", title: "Stable ordering" });
  threads.create({ id: "thread-recency-a", workspaceId: "workspace-a", title: "Recency A", createdAt: 100, updatedAt: 100 });
  threads.create({ id: "thread-recency-b", workspaceId: "workspace-a", title: "Recency B", createdAt: 200, updatedAt: 200 });
  threads.create({ id: "thread-other", workspaceId: "workspace-b", title: "Other workspace" });

  const chat = createChatRepository(repo);
  chat.insert({ workspaceId: "workspace-a", threadId: "thread-auth", role: "user", content: "Add login" });
  chat.insert({ workspaceId: "workspace-a", threadId: "thread-auth", role: "assistant", content: "Planning login" });
  chat.insert({ workspaceId: "workspace-a", threadId: "thread-dashboard", role: "user", content: "Redesign dashboard" });
  chat.insert({ workspaceId: "workspace-a", role: "user", content: "Legacy global chat" });
  chat.insert({ id: "message-b", workspaceId: "workspace-a", threadId: "thread-order", role: "assistant", content: "Second stable message", timestamp: 123 });
  chat.insert({ id: "message-a", workspaceId: "workspace-a", threadId: "thread-order", role: "user", content: "First stable message", timestamp: 123 });

  assert.deepEqual(
    chat.list("workspace-a", "thread-auth").map((message) => message.content),
    ["Add login", "Planning login"],
    "Thread A must only read Thread A chat history",
  );
  assert.deepEqual(
    chat.list("workspace-a", "thread-dashboard").map((message) => message.content),
    ["Redesign dashboard"],
    "Thread B must not receive Thread A chat history",
  );
  assert.deepEqual(
    chat.list("workspace-a", "thread-order").map((message) => message.id),
    ["message-a", "message-b"],
    "equal-timestamp Thread messages must have deterministic ordering",
  );
  assert.deepEqual(
    chat.list("workspace-a").map((message) => message.content),
    ["Legacy global chat"],
    "legacy workspace chat must stay separate from Thread-scoped history",
  );
  assert.equal(chat.count("workspace-a", "thread-auth"), 2);

  const recencyABefore = threads.get("thread-recency-a")!;
  const recencyBBefore = threads.get("thread-recency-b")!;
  chat.insert({ workspaceId: "workspace-a", threadId: "thread-recency-a", role: "user", content: "Continue this Thread" });
  const recencyAAfter = threads.get("thread-recency-a")!;
  const recencyBAfter = threads.get("thread-recency-b")!;
  assert.ok(recencyAAfter.updatedAt > recencyABefore.updatedAt, "Thread chat activity must advance owning Thread recency");
  assert.equal(recencyBAfter.updatedAt, recencyBBefore.updatedAt, "Thread chat activity must not touch sibling Thread recency");
  assert.deepEqual(
    threads.list("workspace-a")
      .filter((thread) => thread.id === "thread-recency-a" || thread.id === "thread-recency-b")
      .map((thread) => thread.id),
    ["thread-recency-a", "thread-recency-b"],
    "recently active Thread must sort ahead of an inactive sibling",
  );

  const beforeLegacyInsert = threads.get("thread-recency-a")!.updatedAt;
  chat.insert({ workspaceId: "workspace-a", role: "assistant", content: "Legacy reply" });
  assert.equal(
    threads.get("thread-recency-a")!.updatedAt,
    beforeLegacyInsert,
    "legacy workspace-global chat must not mutate Thread recency",
  );
  assert.deepEqual(
    chat.list("workspace-a").map((message) => message.content),
    ["Legacy global chat", "Legacy reply"],
    "legacy workspace chat must remain durable and separate",
  );

  assert.throws(
    () => chat.insert({ workspaceId: "workspace-a", threadId: "thread-other", role: "user", content: "leak" }),
    /Thread not found in workspace/,
    "a Thread from another workspace must not accept chat writes",
  );
  assert.throws(
    () => chat.list("workspace-a", "thread-other"),
    /Thread not found in workspace/,
    "a Thread from another workspace must not expose chat history",
  );

  repo.close();

  const reopenedRepo = new Repository(dbPath);
  const reopenedChat = createChatRepository(reopenedRepo);
  assert.deepEqual(
    reopenedChat.list("workspace-a", "thread-auth").map((message) => message.content),
    ["Add login", "Planning login"],
    "Thread chat continuity must survive repository reopen",
  );
  assert.deepEqual(
    reopenedChat.list("workspace-a", "thread-order").map((message) => message.id),
    ["message-a", "message-b"],
    "equal-timestamp Thread ordering must remain stable after repository reopen",
  );
  reopenedRepo.close();

  console.log("thread-chat-persistence: ok — sibling Threads remain isolated, activity updates recency, and history ordering survives reopen");
} finally {
  await rm(dir, { recursive: true, force: true });
}
