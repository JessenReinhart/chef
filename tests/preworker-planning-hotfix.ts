import { strict as assert } from "node:assert";
import type {
  Decision,
  DecisionProvider,
  Plan,
  PlanProposalContext,
  PlanTaskOutcome,
} from "../src/core/types.ts";
import { SingleWorkerFastPathDecisionProvider } from "../src/orchestrator/fast-path-decision-provider.ts";

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

console.log("preworker-planning-hotfix: ok — trivial work skips planning and hung planning is bounded");
