import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecisionProvider } from "../src/core/types.ts";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { createImmediateChatServer } from "../src/server/immediate-chat-http.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-immediate-chat-"));
let releasePlanner!: () => void;
const plannerGate = new Promise<void>((resolve) => { releasePlanner = resolve; });

const heldPlanner: DecisionProvider = {
  name: "held-planner",
  async proposePlan() {
    await plannerGate;
    return null;
  },
  async evaluate(input) {
    return {
      id: crypto.randomUUID(),
      workspaceId: "test-workspace",
      type: "test",
      summary: `unused evaluation for ${input.taskId}`,
      payload: input,
      madeBy: "held-planner",
      timestamp: Date.now(),
      status: "accepted",
    };
  },
};

const chef = createChef({
  dbPath: join(dir, "chef.sqlite"),
  projectDir: dir,
  decisionProvider: heldPlanner,
});
await chef.start();
const server = createImmediateChatServer(chef, createHttpServer(chef));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("immediate-chat HTTP server did not bind");
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Research the project performance" }),
    signal: AbortSignal.timeout(1_000),
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(response.status, 202, "Living Workspace send should acknowledge accepted work immediately");
  assert.ok(elapsed < 1_000, `chat acknowledgement exceeded its 1s test budget (${elapsed}ms)`);
  const body = await response.json() as { data?: { accepted?: boolean; missionId?: string } };
  assert.equal(body.data?.accepted, true);
  assert.ok(body.data?.missionId, "immediate acknowledgement should expose the persisted Mission id");

  const snapshot = await chef.inspectState();
  const mission = snapshot.missions.find((candidate) => candidate.id === body.data?.missionId);
  assert.equal(mission?.status, "planning", "Mission must already be durable while the planner is still blocked");
  assert.ok(snapshot.events.some((event) =>
    event.type === "chat.plan.started"
    && (event.payload as { missionId?: string }).missionId === mission?.id
  ), "planner-start evidence must be durable before the HTTP acknowledgement returns");
  assert.equal(snapshot.tasks.length, 0, "the test must prove acknowledgement does not fake a worker Task");
  assert.equal(snapshot.sessions.length, 0, "the test must prove acknowledgement does not fake a worker Session");

  releasePlanner();
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (chef.repository.getMission(mission!.id)?.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(chef.repository.getMission(mission!.id)?.status, "failed", "background orchestration should continue after acknowledgement");
} finally {
  releasePlanner();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await chef.close();
  await rm(dir, { recursive: true, force: true });
}

console.log("immediate-chat-http: ok — Living Workspace receives a durable Mission acknowledgement before planning finishes");
