import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createChatRepository } from "../src/persistence/chat.ts";
import { Repository } from "../src/persistence/database.ts";
import { createThreadRepository } from "../src/persistence/threads.ts";
import { createThreadServer } from "../src/server/thread-http.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-thread-http-"));
const dbPath = join(dir, "chef.sqlite");
const repository = new Repository(dbPath);
repository.createWorkspace({ id: "workspace-a", name: "Workspace A" });
repository.createWorkspace({ id: "workspace-b", name: "Workspace B" });
const threads = createThreadRepository(repository);
const chat = createChatRepository(repository);
const foreignThread = threads.create({ workspaceId: "workspace-b", title: "Private work" });

const runtime = { workspaceId: "workspace-a", repository } as never;
const baseServer = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ fallback: req.url }));
});
const server = createThreadServer(runtime, baseServer);

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;

try {
  const createdResponse = await fetch(`${origin}/api/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "  Authentication  " }),
  });
  assert.equal(createdResponse.status, 201);
  const createdBody = await createdResponse.json() as { data: { id: string; workspaceId: string; title: string; status: string } };
  assert.equal(createdBody.data.workspaceId, "workspace-a");
  assert.equal(createdBody.data.title, "Authentication");
  assert.equal(createdBody.data.status, "active");

  const secondThread = threads.create({ workspaceId: "workspace-a", title: "Dashboard" });
  chat.insert({ workspaceId: "workspace-a", threadId: createdBody.data.id, role: "user", content: "Keep email login" });
  chat.insert({ workspaceId: "workspace-a", threadId: createdBody.data.id, role: "assistant", content: "I will keep it." });
  chat.insert({ workspaceId: "workspace-a", threadId: secondThread.id, role: "user", content: "Redesign dashboard" });
  chat.insert({ workspaceId: "workspace-b", threadId: foreignThread.id, role: "user", content: "Private sibling workspace message" });

  const historyResponse = await fetch(`${origin}/api/threads/${createdBody.data.id}/messages`);
  assert.equal(historyResponse.status, 200);
  const historyBody = await historyResponse.json() as { data: Array<{ threadId?: string; content: string }> };
  assert.deepEqual(
    historyBody.data.map((message) => ({ threadId: message.threadId, content: message.content })),
    [
      { threadId: createdBody.data.id, content: "Keep email login" },
      { threadId: createdBody.data.id, content: "I will keep it." },
    ],
    "Thread history must contain only messages from the selected Thread",
  );

  const secondHistoryResponse = await fetch(`${origin}/api/threads/${secondThread.id}/messages`);
  assert.equal(secondHistoryResponse.status, 200);
  const secondHistoryBody = await secondHistoryResponse.json() as { data: Array<{ content: string }> };
  assert.deepEqual(secondHistoryBody.data.map((message) => message.content), ["Redesign dashboard"]);

  const listResponse = await fetch(`${origin}/api/threads`);
  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json() as { data: Array<{ id: string }> };
  assert.deepEqual(
    new Set(listBody.data.map((thread) => thread.id)),
    new Set([createdBody.data.id, secondThread.id]),
    "thread list must not leak sibling workspace data",
  );

  const getResponse = await fetch(`${origin}/api/threads/${createdBody.data.id}`);
  assert.equal(getResponse.status, 200);

  const renameResponse = await fetch(`${origin}/api/threads/${createdBody.data.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Auth follow-ups", summary: "Sign-in is done." }),
  });
  assert.equal(renameResponse.status, 200);
  const renameBody = await renameResponse.json() as { data: { title: string; summary?: string } };
  assert.equal(renameBody.data.title, "Auth follow-ups");
  assert.equal(renameBody.data.summary, "Sign-in is done.");

  const archiveResponse = await fetch(`${origin}/api/threads/${createdBody.data.id}/archive`, { method: "POST" });
  assert.equal(archiveResponse.status, 200);
  const archiveBody = await archiveResponse.json() as { data: { status: string } };
  assert.equal(archiveBody.data.status, "archived");

  assert.equal((await fetch(`${origin}/api/threads/${foreignThread.id}`)).status, 404, "foreign workspace thread must be hidden");
  assert.equal((await fetch(`${origin}/api/threads/${foreignThread.id}/messages`)).status, 404, "foreign workspace Thread history must be hidden");
  assert.equal((await fetch(`${origin}/api/threads/${foreignThread.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "stolen" }),
  })).status, 404, "foreign workspace thread must not be mutable");
  assert.equal((await fetch(`${origin}/api/threads/${foreignThread.id}/archive`, { method: "POST" })).status, 404, "foreign workspace thread must not be archivable");

  assert.equal((await fetch(`${origin}/api/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "   " }),
  })).status, 400);
  assert.equal((await fetch(`${origin}/api/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
  })).status, 400, "non-object JSON bodies must fail closed");
  assert.equal((await fetch(`${origin}/api/threads/%E0%A4%A`)).status, 400, "malformed encoded Thread ids must not escape the request boundary");
  assert.equal((await fetch(`${origin}/api/threads/%E0%A4%A/messages`)).status, 400, "malformed encoded Thread ids must fail at the message-history boundary");

  const fallback = await fetch(`${origin}/api/state`);
  assert.equal(fallback.status, 200);
  assert.deepEqual(await fallback.json(), { fallback: "/api/state" });
  console.log("thread-http: ok — CRUD and message history are durable and workspace scoped");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  repository.close();
  await rm(dir, { recursive: true, force: true });
}
