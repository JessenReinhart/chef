/**
 * Approval gate regression (spec §11.3):
 *  1. Tasks linked to a pending approval are held (not dispatched).
 *  2. Acceptance transitions the task to running and spawns a session.
 *  3. Rejection cancels the held task.
 *  4. Every gate decision persists an approval.resolved event.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createChef } from "../src/main.ts";
import { GenericTerminalHarness } from "../src/harness/generic.ts";
import type { AgentId, Decision, Plan, PlanProposalContext, PlanTaskOutcome, WorkspaceId } from "../src/core/types.ts";
import type { Approval, ApprovalDecision } from "../src/core/approvals.ts";

/** Provider whose plan marks the single task as requiring a human gate. */
class GatedProvider {
  readonly name = "approval-gate-test";
  #workspaceId = "";
  #approvalId = "";
  readonly #script: string;
  constructor(script: string) { this.#script = script; }
  get approvalId(): string { return this.#approvalId; }
  async proposePlan(input: PlanProposalContext): Promise<Plan> {
    this.#workspaceId = input.workspaceId;
    this.#approvalId = randomUUID();
    const taskId = randomUUID();
    return {
      id: randomUUID(), workspaceId: input.workspaceId, goal: input.goal, status: "proposed",
      tasks: [{
        id: taskId, title: "Gated worker", description: input.goal, dependencies: [], priority: 1,
        assignedTo: "cat", approvalId: this.#approvalId,
      }],
      taskIds: [taskId], createdAt: Date.now(),
    };
  }
  harnessFor(agentId: AgentId, workspaceId: WorkspaceId): GenericTerminalHarness {
    assert.equal(agentId, "cat");
    return new GenericTerminalHarness({ agentId, workspaceId, command: process.execPath, args: [this.#script] });
  }
  async evaluate(outcome: PlanTaskOutcome): Promise<Decision> {
    return { id: randomUUID(), workspaceId: this.#workspaceId, type: "task.evaluation", summary: outcome.status, payload: outcome, madeBy: this.name, timestamp: Date.now(), status: "accepted" };
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
}

const dir = await mkdtemp(join(tmpdir(), "chef-approvals-"));
const script = join(dir, "worker.mjs");
// This worker must stay alive long enough to observe the accepted Task in the
// running state, then exit on its own. The approval regression must not depend
// on a global Mission timeout to eventually release `await execution`.
await writeFile(script, "setTimeout(() => process.exit(0), 1_000);", "utf8");

async function runScenario(decision: ApprovalDecision): Promise<void> {
  const chef = createChef({
    dbPath: join(dir, `chef-${decision}.sqlite`),
    projectDir: dir,
    decisionProvider: new GatedProvider(script),
  });
  try {
    await chef.start();
    const execution = chef.sendUserMessage("needs human gate");
    await waitFor(async () => (await chef.inspectState()).approvals.length > 0);
    const snapshot = await chef.inspectState();
    const approval = snapshot.approvals.find((entry: Approval) => entry.status === "pending")!;
    assert.ok(approval, "an approval request must be visible in the snapshot");
    const held = snapshot.tasks.find((task) => task.status === "blocked");
    assert.ok(held, "task linked to a pending approval must be held (blocked)");
    assert.equal(held!.approvalId, approval.id);
    assert.equal(snapshot.sessions.length, 0, "held task must not be dispatched");
    assert.ok(
      snapshot.events.some((event) => event.type === "approval.requested" && event.taskId === held!.id),
      "approval.requested must be persisted",
    );

    if (decision === "accepted") {
      await chef.resolveApproval(approval.id, decision, "human", "looks safe");
    } else {
      await chef.resolveApproval(approval.id, decision, "human", "not now");
    }

    await waitFor(async () => {
      const state = await chef.inspectState();
      return state.approvals.find((entry: Approval) => entry.id === approval.id)?.status !== "pending";
    });

    if (decision === "accepted") {
      await waitFor(async () => {
        const state = await chef.inspectState();
        const task = state.tasks.find((entry) => entry.id === held!.id);
        return task?.status === "running" && state.sessions.some((session) => session.taskId === held!.id);
      });
    }

    const after = await chef.inspectState();
    const resolved = after.approvals.find((entry: Approval) => entry.id === approval.id)!;
    assert.equal(resolved.status, decision);
    assert.equal(resolved.approver, "human");
    assert.ok(
      after.events.some((event) => event.type === "approval.resolved" && event.payload?.decision === decision),
      "approval.resolved must be persisted",
    );

    const task = after.tasks.find((entry) => entry.id === held!.id)!;
    if (decision === "accepted") {
      assert.equal(task.status, "running", "accepted task must dispatch");
      assert.ok(after.sessions.some((session) => session.taskId === held!.id), "accepted task must spawn a session");
    } else {
      assert.equal(task.status, "cancelled", "rejected task must be cancelled");
      assert.equal(after.sessions.length, 0, "rejected task must never spawn");
    }
    await execution;
  } finally {
    await chef.close();
  }
}

try {
  await runScenario("accepted");
  await runScenario("rejected");
  console.log("approvals: ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
