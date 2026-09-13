import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Repository } from "../src/persistence/database.ts";
import { createThreadRepository } from "../src/persistence/threads.ts";
import { createThreadServer } from "../src/server/thread-http.ts";
import { interruptedMissionRecovery } from "../web/src/missionRecovery.ts";

const paused = interruptedMissionRecovery({
  missionStatus: "paused",
  goal: "Create a simple todo app",
  readOnly: false,
});
assert.deepEqual(paused, {
  description: "This Mission is paused. Keep its history intact and continue as fresh work in this Thread when you are ready.",
  prompt: "Continue this work: Create a simple todo app",
}, "paused Mission work must expose an editable fresh-follow-up path in an active Thread");

const cancelled = interruptedMissionRecovery({
  missionStatus: "cancelled",
  goal: "Create a simple todo app",
  readOnly: false,
});
assert.equal(cancelled?.prompt, "Continue this work: Create a simple todo app", "cancelled Mission recovery must keep its existing continuation contract");

assert.equal(interruptedMissionRecovery({
  missionStatus: "paused",
  goal: "Create a simple todo app",
  readOnly: true,
}), null, "archived Thread history must remain read-only");

assert.equal(interruptedMissionRecovery({
  missionStatus: "failed",
  goal: "Create a simple todo app",
  readOnly: false,
}), null, "failed Missions must remain in their failure-specific recovery path");

assert.equal(interruptedMissionRecovery({
  missionStatus: "waiting_for_approval",
  goal: "Create a simple todo app",
  readOnly: false,
}), null, "approval-waiting Missions must remain in the approval flow");

const dir = await mkdtemp(join(tmpdir(), "chef-paused-mission-recovery-"));
const repository = new Repository(join(dir, "chef.sqlite"));
repository.createWorkspace({ id: "workspace-a", name: "Workspace A" });
const threads = createThreadRepository(repository);
const thread = threads.create({ workspaceId: "workspace-a", title: "Todo app" });
const originalMission = repository.insertMission({
  id: "mission-paused",
  workspaceId: "workspace-a",
  goal: "Create a simple todo app",
  status: "paused",
  createdBy: "user",
  metadata: { threadId: thread.id },
});

const runtime = {
  workspaceId: "workspace-a",
  repository,
  sendUserMessage(message: string) {
    repository.insertMission({ workspaceId: "workspace-a", goal: message, status: "planning", createdBy: "user" });
    return Promise.resolve({ workspaceId: "workspace-a", taskIds: [] as string[], report: `Started: ${message}`, ok: true });
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
  const response = await fetch(`${origin}/api/threads/${thread.id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: paused.prompt }),
  });
  assert.equal(response.status, 202);
  const body = await response.json() as { data: { accepted?: boolean; missionId?: string; threadId: string } };
  assert.equal(body.data.accepted, true);
  assert.equal(body.data.threadId, thread.id, "paused continuation must stay in the same active Thread");
  assert.ok(body.data.missionId, "paused continuation must create fresh Mission work");
  assert.notEqual(body.data.missionId, originalMission.id, "continuation must not mutate or reuse the paused Mission");

  const missions = repository.listMissions("workspace-a");
  assert.equal(missions.length, 2, "paused history and fresh continuation must both remain durable");
  const preserved = missions.find((mission) => mission.id === originalMission.id);
  const continuation = missions.find((mission) => mission.id === body.data.missionId);
  assert.equal(preserved?.status, "paused", "starting fresh continuation must preserve paused Mission history");
  assert.equal(preserved?.metadata.threadId, thread.id);
  assert.equal(continuation?.goal, paused.prompt);
  assert.equal(continuation?.metadata.threadId, thread.id, "fresh continuation Mission must retain the originating Thread lineage");

  await new Promise((resolve) => setTimeout(resolve, 2));
  const history = await fetch(`${origin}/api/threads/${thread.id}/messages`);
  assert.equal(history.status, 200);
  const historyBody = await history.json() as { data: Array<{ role: string; content: string }> };
  assert.deepEqual(
    historyBody.data.map((message) => [message.role, message.content]),
    [
      ["user", paused.prompt],
      ["assistant", `Started: ${paused.prompt}`],
    ],
    "prepared paused continuation must remain in the same Thread conversation when it is sent",
  );
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  repository.close();
  await rm(dir, { recursive: true, force: true });
}

console.log("paused-mission-recovery: ok — paused work gets an editable same-Thread continuation without mutating paused history or bypassing read-only/approval gates");
