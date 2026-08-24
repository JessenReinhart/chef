import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ThreadMessageContext } from "../src/core/types.ts";
import { Repository } from "../src/persistence/database.ts";
import { createThreadRepository } from "../src/persistence/threads.ts";
import { createThreadServer } from "../src/server/thread-http.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-thread-continuity-"));
const repository = new Repository(join(dir, "chef.sqlite"));
repository.createWorkspace({ id: "workspace-a", name: "Workspace A" });
const threads = createThreadRepository(repository);
const mainThread = threads.create({
  workspaceId: "workspace-a",
  title: "Dashboard continuity",
  summary: "Keep the compact filter layout and red status treatment.",
});
const siblingThread = threads.create({ workspaceId: "workspace-a", title: "Unrelated work" });

const planningCalls: Array<{
  message: string;
  context?: { threadId?: string; recentMessages?: ThreadMessageContext[] };
}> = [];

const runtime = {
  workspaceId: "workspace-a",
  repository,
  sendUserMessage(message: string, context?: { threadId?: string; recentMessages?: ThreadMessageContext[] }) {
    planningCalls.push({ message, context });
    repository.insertMission({ workspaceId: "workspace-a", goal: message, status: "planning", createdBy: "user" });
    return Promise.resolve({ workspaceId: "workspace-a", taskIds: [] as string[], report: `Completed: ${message}`, ok: true });
  },
} as never;

const baseServer = createServer((_req, res) => {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});
const server = createThreadServer(runtime, baseServer);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;

async function send(threadId: string, message: string): Promise<void> {
  const response = await fetch(`${origin}/api/threads/${threadId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  assert.equal(response.status, 200, `expected Thread send to succeed: ${message}`);
  await response.json();
  await new Promise((resolve) => setTimeout(resolve, 2));
}

try {
  await send(mainThread.id, "mission-1");
  await send(mainThread.id, "mission-2");
  await send(siblingThread.id, "sibling-secret");
  await send(mainThread.id, "mission-3");
  await send(mainThread.id, "mission-4");
  await send(mainThread.id, "mission-5");
  await send(mainThread.id, "mission-6");

  const finalCall = planningCalls.at(-1);
  assert.equal(finalCall?.message, "mission-6");
  assert.equal(finalCall?.context?.threadId, mainThread.id);

  const context = finalCall?.context?.recentMessages ?? [];
  const systemHints = context.filter((message) => message.role === "system");
  const transcript = context.filter((message) => message.role !== "system");

  assert.deepEqual(
    systemHints.map((message) => message.content),
    [
      "Thread summary (advisory context only): Keep the compact filter layout and red status treatment.",
      "Prior Mission (planning; context only): mission-3",
      "Prior Mission (planning; context only): mission-4",
      "Prior Mission (planning; context only): mission-5",
    ],
    "planning should receive one durable summary plus only the latest three same-Thread Missions in chronological order",
  );
  assert.equal(transcript.length, 8, "continuity hints must not consume the existing eight-message transcript budget");
  assert.ok(
    !context.some((message) => message.content.includes("sibling-secret")),
    "planning context must not leak sibling Thread Mission or message history",
  );
  assert.ok(
    !context.some((message) => message.content.includes("mission-6")),
    "the current goal must not be duplicated into prior Thread context",
  );

  console.log("thread-planning-continuity: ok — summary and prior Missions are bounded, advisory, and Thread-isolated");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  repository.close();
  await rm(dir, { recursive: true, force: true });
}
