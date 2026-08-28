import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Repository } from "../src/persistence/database.ts";
import { createThreadRepository } from "../src/persistence/threads.ts";
import { createThreadServer } from "../src/server/thread-http.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-thread-missions-"));
const repository = new Repository(join(dir, "chef.sqlite"));
repository.createWorkspace({ id: "workspace-a", name: "Workspace A" });
const threads = createThreadRepository(repository);
const thread = threads.create({ workspaceId: "workspace-a", title: "Authentication" });

const runtime = {
  workspaceId: "workspace-a",
  repository,
  sendUserMessage(message: string) {
    repository.insertMission({ workspaceId: "workspace-a", goal: message, status: "planning", createdBy: "user" });
    return Promise.resolve({ workspaceId: "workspace-a", taskIds: [] as string[], report: `Completed: ${message}`, ok: true });
  },
} as never;

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
  const send = async (message: string) => {
    const response = await fetch(`${origin}/api/threads/${thread.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
    assert.equal(response.status, 202);
    const body = await response.json() as { data: { accepted?: boolean; missionId?: string; threadId: string } };
    assert.equal(body.data.accepted, true);
    return body;
  };

  const first = await send("Implement sign-in");
  const second = await send("Add forgot-password flow");

  assert.ok(first.data.missionId);
  assert.ok(second.data.missionId);
  assert.notEqual(first.data.missionId, second.data.missionId, "follow-up work in one Thread must create a distinct Mission");
  assert.equal(first.data.threadId, thread.id);
  assert.equal(second.data.threadId, thread.id);

  const missions = repository.listMissions("workspace-a");
  assert.equal(missions.length, 2, "one Thread must be able to retain multiple Missions");
  assert.deepEqual(new Set(missions.map((mission) => mission.goal)), new Set(["Implement sign-in", "Add forgot-password flow"]));
  for (const mission of missions) {
    assert.equal(mission.metadata.threadId, thread.id, "each chat-created Mission must keep the originating Thread lineage");
  }

  await new Promise((resolve) => setTimeout(resolve, 2));
  const history = await fetch(`${origin}/api/threads/${thread.id}/messages`);
  assert.equal(history.status, 200);
  const historyBody = await history.json() as { data: Array<{ role: string; content: string }> };
  assert.deepEqual(
    historyBody.data.map((message) => [message.role, message.content]),
    [
      ["user", "Implement sign-in"],
      ["assistant", "Completed: Implement sign-in"],
      ["user", "Add forgot-password flow"],
      ["assistant", "Completed: Add forgot-password flow"],
    ],
    "follow-up Missions must remain in the same Thread conversation history after background results settle",
  );

  console.log("thread-multiple-missions: ok — one Thread retains multiple acknowledged Mission lineages and background results");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  repository.close();
  await rm(dir, { recursive: true, force: true });
}
