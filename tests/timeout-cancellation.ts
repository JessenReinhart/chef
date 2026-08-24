/**
 * Regression coverage for Mission timeout policy.
 *
 * Core Orchestrator execution is cancellation-driven by default. A caller can
 * still opt into a timeout, and that timeout must abort execution and tear
 * down PTY sessions cleanly.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createChef } from "../src/main.ts";
import { GenericTerminalHarness } from "../src/harness/generic.ts";
import type { DecisionProvider, Plan, AgentId } from "../src/core/types.ts";

class SlowDecisionProvider implements DecisionProvider {
  readonly name = "slow-agent";
  #script: string;
  #planId: string;
  #taskId: string;

  constructor(script: string, planId = "timeout-plan", taskId = "t1") {
    this.#script = script;
    this.#planId = planId;
    this.#taskId = taskId;
  }

  async proposePlan(input: { workspaceId: string; goal: string }): Promise<Plan | null> {
    return {
      id: this.#planId,
      workspaceId: input.workspaceId,
      goal: input.goal,
      status: "proposed",
      taskIds: [this.#taskId],
      createdAt: Date.now(),
      tasks: [
        {
          id: this.#taskId,
          title: "wait for worker",
          description: "runs a node process long enough to exercise Mission timeout policy",
          dependencies: [],
          assignedTo: "investigator",
          priority: 1,
        },
      ],
    };
  }

  harnessFor(agentId: AgentId, workspaceId: string): GenericTerminalHarness {
    if (agentId !== "investigator") throw new Error(`no harness for ${agentId}`);
    return new GenericTerminalHarness({
      agentId,
      workspaceId,
      command: "node",
      args: [this.#script],
    });
  }

  async evaluate(): Promise<{ status: "accepted"; summary: string }> {
    return { status: "accepted", summary: "evaluated" };
  }
}

// Default policy is a constructor contract, not a wall-clock behavior test.
// Keep this assertion deterministic: a successful real worker can legitimately
// run for an arbitrary duration when no Mission deadline is configured.
const orchestratorSource = readFileSync(
  new URL("../src/orchestrator/orchestrator.ts", import.meta.url),
  "utf8",
);
if (orchestratorSource.includes("DEFAULT_TIMEOUT_MS")) {
  throw new Error("core Orchestrator must not restore an implicit default Mission timeout");
}
if (!orchestratorSource.includes("this.#timeoutMs = options.timeoutMs;")) {
  throw new Error("core Orchestrator must keep Mission timeout opt-in");
}
if (!orchestratorSource.includes("if (timeoutMs === undefined) return work;")) {
  throw new Error("unconfigured Mission timeout must bypass timeout racing entirely");
}

// Explicit policy: configured timeout still cancels the Mission and cleans up
// the real PTY process rather than merely racing and abandoning execution.
{
  const dir = mkdtempSync(join(tmpdir(), "chef-timeout-test-"));
  const dbPath = join(dir, "test.db");
  const script = join(dir, "slow-agent.js");
  writeFileSync(script, "setTimeout(() => process.exit(0), 60_000);\n");

  const provider = new SlowDecisionProvider(script);
  const chef = createChef({
    dbPath,
    projectDir: dir,
    decisionProvider: provider,
    orchestratorTimeoutMs: 500,
  });

  const result = await chef.sendUserMessage("run the timeout plan");
  if (result.ok) throw new Error(`expected plan failure on timeout, got: ${result.report}`);
  if (!result.report.includes("Timed out")) {
    throw new Error(`expected timeout error in report, got: ${result.report}`);
  }

  // The plan session must be gone: terminate()/forget() ran in the finally
  // cleanup path. Probe by snapshotting; a live session is a leak.
  const snapshot = chef.repository.getWorkspaceSnapshot(chef.workspaceId);
  const sessions = snapshot.sessions.filter((s) => s.taskId === "t1");
  for (const session of sessions) {
    if (session.status === "running" || session.status === "spawning") {
      throw new Error(`session ${session.id} still live after plan timeout (${session.status})`);
    }
  }

  const timedOutPlan = snapshot.plans.find((plan) => plan.goal.includes("timeout"));
  if (!timedOutPlan) throw new Error("timed-out plan must be persisted durably");
  if (timedOutPlan.status !== "failed") {
    throw new Error(`timed-out plan must be persisted as failed, got: ${timedOutPlan.status}`);
  }

  // close() must not hang on a live PTY that timeout cancellation should have killed.
  const closeTimer = setTimeout(() => {
    throw new Error("close() hung: a PTY survived the timeout cancellation");
  }, 5000);
  closeTimer.unref();
  await chef.close();
  clearTimeout(closeTimer);
  rmSync(dir, { recursive: true, force: true });
}

console.log("timeout-cancellation: ok — default is opt-in, explicit timeout still tears down cleanly");
