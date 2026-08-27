import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecisionProvider } from "../src/core/types.ts";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { createImmediateChatServer } from "../src/server/immediate-chat-http.ts";

const ACK_BUDGET_MS = 1_000;
const WORKER_STARTUP_BUDGET_MS = 1_500;
const MISSION_COMPLETION_BUDGET_MS = 5_000;
const POLL_MS = 20;

async function waitForWorkerStartup(
  inspect: () => Promise<{ tasks: Array<{ id: string }>; sessions: Array<{ id: string }> }>,
): Promise<void> {
  const deadline = Date.now() + WORKER_STARTUP_BUDGET_MS;
  let lastTaskCount = 0;
  let lastSessionCount = 0;

  while (Date.now() < deadline) {
    const snapshot = await inspect();
    lastTaskCount = snapshot.tasks.length;
    lastSessionCount = snapshot.sessions.length;
    if (lastTaskCount > 0 && lastSessionCount > 0) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  assert.fail(
    `Living Workspace request did not reach a real worker session within ${WORKER_STARTUP_BUDGET_MS}ms `
    + `(tasks=${lastTaskCount}, sessions=${lastSessionCount})`,
  );
}

async function runHeldPlannerAcceptance(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "chef-immediate-chat-planning-"));
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
      signal: AbortSignal.timeout(ACK_BUDGET_MS),
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(response.status, 202, "Living Workspace send should acknowledge accepted work immediately");
    assert.ok(elapsed < ACK_BUDGET_MS, `chat acknowledgement exceeded its 1s test budget (${elapsed}ms)`);
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
    const deadline = Date.now() + ACK_BUDGET_MS;
    while (Date.now() < deadline) {
      if (chef.repository.getMission(mission!.id)?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    assert.equal(chef.repository.getMission(mission!.id)?.status, "failed", "background orchestration should continue after acknowledgement");
  } finally {
    releasePlanner();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await chef.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function runCanonicalWorkerStartupAcceptance(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "chef-immediate-chat-worker-"));
  const chef = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir });
  await chef.start();
  const server = createImmediateChatServer(chef, createHttpServer(chef));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("canonical immediate-chat HTTP server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Create a todo app" }),
      signal: AbortSignal.timeout(ACK_BUDGET_MS),
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(response.status, 202, "canonical todo request should be acknowledged before execution completes");
    assert.ok(elapsed < ACK_BUDGET_MS, `canonical todo acknowledgement exceeded its 1s budget (${elapsed}ms)`);
    const body = await response.json() as { data?: { accepted?: boolean; missionId?: string } };
    assert.equal(body.data?.accepted, true);
    assert.ok(body.data?.missionId, "canonical acknowledgement must expose durable Mission lineage");
    const missionId = body.data!.missionId!;

    await waitForWorkerStartup(async () => {
      const snapshot = await chef.inspectState();
      return {
        tasks: snapshot.tasks.filter((task) => task.missionId === missionId),
        sessions: snapshot.sessions.filter((session) => {
          const task = snapshot.tasks.find((candidate) => candidate.id === session.taskId);
          return task?.missionId === missionId;
        }),
      };
    });

    const snapshot = await chef.inspectState();
    const route = snapshot.events.find((event) =>
      event.type === "chat.plan.proposed"
      && (event.payload as { missionId?: unknown }).missionId === missionId
    );
    assert.ok(route, "canonical Living Workspace request must retain durable routing evidence before worker startup");

    const completionDeadline = Date.now() + MISSION_COMPLETION_BUDGET_MS;
    while (Date.now() < completionDeadline) {
      const status = chef.repository.getMission(missionId)?.status;
      if (status === "completed" || status === "failed" || status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    assert.equal(
      chef.repository.getMission(missionId)?.status,
      "completed",
      "canonical background work should finish before the runtime is closed",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await chef.close();
    await rm(dir, { recursive: true, force: true });
  }
}

await runHeldPlannerAcceptance();
await runCanonicalWorkerStartupAcceptance();

console.log("immediate-chat-http: ok — Living Workspace acknowledges durable work immediately and the canonical todo path reaches a real worker Session");
