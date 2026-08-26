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
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      goal: input.goal,
      status: "proposed",
      tasks: [{
        id: taskId,
        title: "Planned work",
        description: input.goal,
        dependencies: [],
        priority: 1,
        nodeType: "agent.llm",
        assignedTo: input.availableWorkers?.[0]?.id,
      }],
      taskIds: [taskId],
      createdAt: Date.now(),
    };
  }

  async evaluate(taskResult: PlanTaskOutcome): Promise<Decision> {
    return {
      id: crypto.randomUUID(),
      workspaceId: "test-workspace",
      type: "task.evaluation",
      summary: taskResult.status,
      payload: taskResult,
      madeBy: this.name,
      timestamp: Date.now(),
      status: taskResult.status === "completed" ? "accepted" : "rejected",
    };
  }
}

const worker = { id: "codex", name: "Codex", type: "codex" };
const context = {
  workspaceId: "workspace-preworker-hotfix",
  availableWorkers: [worker],
};

// Regression: a trivial implementation request must not require the literal
// word "simple" to skip the planner and reach a real worker.
{
  const planner = new StubPlanner();
  const provider = new SingleWorkerFastPathDecisionProvider(planner);
  const goal = "Create a todo app";
  const plan = await provider.proposePlan({ ...context, goal });

  assert.ok(plan);
  assert.equal(plan.routingMode, "single-worker");
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].assignedTo, worker.id);
  assert.equal(plan.tasks[0].description, goal);
  assert.equal(planner.calls, 0, "trivial single-stage work must not wait on the planner");
}

// Keep decomposition for explicitly chained/complex work.
{
  const planner = new StubPlanner();
  const provider = new SingleWorkerFastPathDecisionProvider(planner);
  const plan = await provider.proposePlan({
    ...context,
    goal: "Create a dashboard and then test it",
  });

  assert.ok(plan);
  assert.equal(plan.routingMode, "planner");
  assert.equal(planner.calls, 1, "multi-stage work must still use planning");
}

// Regression: a planner that never resolves must not leave Chef perpetually in
// the pre-worker Preparing state. The wrapper must fail inside a bounded time.
{
  const planner = new StubPlanner(true);
  const provider = new SingleWorkerFastPathDecisionProvider(planner, { plannerTimeoutMs: 25 });
  const startedAt = Date.now();

  await assert.rejects(
    () => provider.proposePlan({ ...context, goal: "Implement the todo list" }),
    /Planner timed out after 25ms before any worker could start/,
  );

  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 500, `hung planner must fail promptly in the regression fixture (elapsed ${elapsedMs}ms)`);
  assert.equal(planner.calls, 1);
}

// Exercise the same Thread chat HTTP boundary used by Simple Mode. A hung
// planner must return a durable failed Mission instead of keeping the request
// and UI in Preparing forever.
{
  const dir = mkdtempSync(join(tmpdir(), "chef-preworker-http-hotfix-"));
  const planner = new StubPlanner(true);
  const provider = new SingleWorkerFastPathDecisionProvider(planner, { plannerTimeoutMs: 25 });
  const chef = createChef({
    dbPath: join(dir, "chef.sqlite"),
    projectDir: dir,
    decisionProvider: provider,
  });
  await chef.start();

  const server = createThreadServer(chef, createHttpServer(chef));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("pre-worker hotfix HTTP server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createThreadResponse = await fetch(`${baseUrl}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Hotfix regression" }),
    });
    assert.equal(createThreadResponse.status, 201);
    const created = await createThreadResponse.json() as { data?: { id?: string } };
    const threadId = created.data?.id;
    assert.ok(threadId);

    const startedAt = Date.now();
    const chatResponse = await fetch(`${baseUrl}/api/threads/${encodeURIComponent(threadId)}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Implement the todo list" }),
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(chatResponse.status, 200);
    assert.ok(elapsedMs < 500, `Thread chat must leave pre-worker planning promptly (elapsed ${elapsedMs}ms)`);

    const chatBody = await chatResponse.json() as {
      ok?: boolean;
      data?: { ok?: boolean; report?: string; missionId?: string; taskIds?: string[] };
    };
    assert.equal(chatBody.ok, false);
    assert.equal(chatBody.data?.ok, false);
    assert.match(chatBody.data?.report ?? "", /Planner timed out after 25ms before any worker could start/);
    assert.deepEqual(chatBody.data?.taskIds ?? [], []);

    const snapshot = chef.repository.getWorkspaceSnapshot(chef.workspaceId);
    const mission = snapshot.missions.find((candidate) => candidate.id === chatBody.data?.missionId)
      ?? snapshot.missions.at(-1);
    assert.ok(mission, "the failed planning attempt must remain a durable Mission");
    assert.equal(mission.status, "failed");
    assert.equal(mission.taskIds.length, 0, "no fake Task should be created when planning never completes");
    assert.equal(snapshot.sessions.length, 0, "no fake worker Session should exist before routing succeeds");

    const planningFailure = snapshot.events.find((event) =>
      event.type === "orchestrator.plan.error"
      && String((event.payload as { error?: unknown }).error ?? "").includes("Planner timed out after 25ms")
    );
    assert.ok(planningFailure, "planner timeout must be durable runtime evidence for Simple/Power Mode projections");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await chef.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("preworker-planning-hotfix: ok — trivial work skips planning and hung planning is bounded through Thread chat");
