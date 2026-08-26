import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Decision,
  DecisionProvider,
  Plan,
  PlanProposalContext,
  PlanTaskOutcome,
} from "../src/core/types.ts";
import { createChef } from "../src/main.ts";
import { SingleWorkerFastPathDecisionProvider } from "../src/orchestrator/fast-path-decision-provider.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { createThreadServer } from "../src/server/thread-http.ts";
import { deriveMissionHeartbeat, summarizeMissionProgressForMission } from "../web/src/missionProgress.ts";
import type { UiRuntimeEvent } from "../web/src/types.ts";

class StubPlanner implements DecisionProvider {
  readonly name = "stub-planner";
  calls = 0;
  readonly #hang: boolean;

  constructor(hang = false) {
    this.#hang = hang;
  }

  async proposePlan(input: PlanProposalContext): Promise<Plan | null> {
    this.calls += 1;
    if (this.#hang) return new Promise<Plan | null>(() => {});
    const taskId = crypto.randomUUID();
    return {
      id: crypto.randomUUID(), workspaceId: input.workspaceId, goal: input.goal, status: "proposed",
      tasks: [{ id: taskId, title: "Planned work", description: input.goal, dependencies: [], priority: 1, nodeType: "agent.llm", assignedTo: input.availableWorkers?.[0]?.id }],
      taskIds: [taskId], createdAt: Date.now(),
    };
  }

  async evaluate(taskResult: PlanTaskOutcome): Promise<Decision> {
    return { id: crypto.randomUUID(), workspaceId: "test-workspace", type: "task.evaluation", summary: taskResult.status, payload: taskResult, madeBy: this.name, timestamp: Date.now(), status: taskResult.status === "completed" ? "accepted" : "rejected" };
  }
}

const worker = { id: "codex", name: "Codex", type: "codex" };
const context = { workspaceId: "workspace-preworker-hotfix", availableWorkers: [worker] };

for (const goal of ["Create a todo app", "Implement a todo app"]) {
  const planner = new StubPlanner();
  const provider = new SingleWorkerFastPathDecisionProvider(planner);
  const plan = await provider.proposePlan({ ...context, goal });
  assert.ok(plan);
  assert.equal(plan.routingMode, "single-worker");
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].assignedTo, worker.id);
  assert.equal(plan.tasks[0].description, goal);
  assert.equal(planner.calls, 0);
}

{
  const planner = new StubPlanner();
  const provider = new SingleWorkerFastPathDecisionProvider(planner);
  const plan = await provider.proposePlan({ ...context, goal: "Create a dashboard and then test it" });
  assert.ok(plan);
  assert.equal(plan.routingMode, "planner");
  assert.equal(planner.calls, 1);
}

{
  const planner = new StubPlanner(true);
  const provider = new SingleWorkerFastPathDecisionProvider(planner, { plannerTimeoutMs: 25 });
  const startedAt = Date.now();
  await assert.rejects(() => provider.proposePlan({ ...context, goal: "Analyze the existing app architecture" }), /Planner timed out after 25ms before any worker could start/);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(planner.calls, 1);
}

{
  const dir = mkdtempSync(join(tmpdir(), "chef-preworker-http-hotfix-"));
  const planner = new StubPlanner(true);
  const provider = new SingleWorkerFastPathDecisionProvider(planner, { plannerTimeoutMs: 25 });
  const chef = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir, decisionProvider: provider });
  await chef.start();
  const server = createThreadServer(chef, createHttpServer(chef));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("pre-worker hotfix HTTP server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const createThreadResponse = await fetch(`${baseUrl}/api/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Hotfix regression" }) });
    assert.equal(createThreadResponse.status, 201);
    const created = await createThreadResponse.json() as { data?: { id?: string } };
    const threadId = created.data?.id;
    assert.ok(threadId);
    const startedAt = Date.now();
    const chatResponse = await fetch(`${baseUrl}/api/threads/${encodeURIComponent(threadId)}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Analyze the existing app architecture" }) });
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(chatResponse.status, 200);
    const chatBody = await chatResponse.json() as { ok?: boolean; data?: { ok?: boolean; report?: string; missionId?: string; taskIds?: string[] } };
    assert.equal(chatBody.ok, false);
    assert.equal(chatBody.data?.ok, false);
    assert.match(chatBody.data?.report ?? "", /Planner timed out after 25ms before any worker could start/);
    assert.deepEqual(chatBody.data?.taskIds ?? [], []);
    const snapshot = chef.repository.getWorkspaceSnapshot(chef.workspaceId);
    const mission = snapshot.missions.find((candidate) => candidate.id === chatBody.data?.missionId) ?? snapshot.missions.at(-1);
    assert.ok(mission);
    assert.equal(mission.status, "failed");
    assert.equal(mission.taskIds.length, 0);
    assert.equal(snapshot.sessions.length, 0);

    const planningStarted = snapshot.events.find((event) => {
      if (event.type !== "orchestrator.plan.started") return false;
      return (event.payload as { missionId?: unknown }).missionId === mission.id;
    });
    assert.ok(planningStarted, "pre-worker planning must be durable and correlated to its Mission before the provider call resolves");

    const planningFailure = snapshot.events.find((event) => {
      if (event.type !== "orchestrator.plan.error") return false;
      const payload = event.payload as { missionId?: unknown; error?: unknown };
      return payload.missionId === mission.id && String(payload.error ?? "").includes("Planner timed out after 25ms");
    });
    assert.ok(planningFailure, "planner timeout must remain durable and correlated to the same Mission");
    assert.ok(planningStarted.seq < planningFailure.seq, "planning-start evidence must precede the terminal planner failure");

    const planningEvent = planningStarted as unknown as UiRuntimeEvent;
    const planningHeartbeat = deriveMissionHeartbeat(
      [planningEvent],
      mission.id,
      [],
      planningEvent.timestamp + 11_000,
      10_000,
    );
    assert.equal(
      planningHeartbeat?.text,
      "Chef is still planning. Last runtime activity was 11 seconds ago.",
      "Simple Mode must remain informative while the provider is slow before any worker exists",
    );

    const projectedFailure = summarizeMissionProgressForMission(
      [planningEvent, planningFailure as unknown as UiRuntimeEvent],
      mission.id,
      [],
      3,
      planningFailure.timestamp + 11_000,
    );
    assert.equal(projectedFailure[0]?.eventType, "orchestrator.plan.error");
    assert.equal(projectedFailure[0]?.tone, "attention");
    assert.match(projectedFailure[0]?.text ?? "", /Planning failed: Planner timed out after 25ms/);
    assert.equal(
      deriveMissionHeartbeat(
        [planningEvent, planningFailure as unknown as UiRuntimeEvent],
        mission.id,
        [],
        planningFailure.timestamp + 11_000,
        10_000,
      ),
      null,
      "a durable planner failure must stop the still-planning heartbeat",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await chef.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("preworker-planning-hotfix: ok — straightforward work skips planning and hung planning is bounded, Mission-correlated, and visible through Thread chat");
