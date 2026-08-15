/**
 * Regression: plan timeout must cancel plan execution and tear down PTY
 * sessions. Before the AbortController fix, #withTimeout raced a timer
 * against #executePlan and returned on timeout while the consume loop kept
 * running — sessions stayed live in the harness registry and the plan's
 * finally-cleanup never ran, leaking PTYs.
 *
 * Uses a custom DecisionProvider whose agent script sleeps past the plan
 * timeout, so the orchestrator's 500ms deadline fires mid-execution. After
 * the timeout the session must not be stuck "running", and closing the chef
 * must not hang on a live PTY.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createChef } from "../src/main.ts";
import { GenericTerminalHarness } from "../src/harness/generic.ts";
import type { DecisionProvider, Plan, AgentId } from "../src/core/types.ts";

const dir = mkdtempSync(join(tmpdir(), "chef-timeout-test-"));
const dbPath = join(dir, "test.db");

const SCRIPT = join(dir, "slow-agent.js");
await import("node:fs").then((fs) =>
  fs.writeFileSync(SCRIPT, "setTimeout(() => process.exit(0), 60_000);\n"),
);

/**
 * Decision provider whose agent harness runs a node script that sleeps for
 * 60s — far past the 500ms orchestrator timeout. The harness is created via
 * the same GenericTerminalHarness the runtime uses, so the timeout path must
 * terminate the real PTY process.
 */
class SlowDecisionProvider implements DecisionProvider {
  readonly name = "slow-agent";
  #script: string;

  constructor(script: string) {
    this.#script = script;
  }

  async proposePlan(input: { workspaceId: string; goal: string }): Promise<Plan | null> {
    return {
      id: "timeout-plan",
      workspaceId: input.workspaceId,
      goal: input.goal,
      status: "proposed",
      taskIds: ["t1"],
      createdAt: Date.now(),
      tasks: [
        {
          id: "t1",
          title: "sleep forever",
          description: "spawns a node process that sleeps past the plan timeout",
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

const provider = new SlowDecisionProvider(SCRIPT);
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
// cleanup path. Probe by snapshotting — a lingering "running" session is a leak.
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

console.log("timeout-cancellation: ok — plan timed out, sessions torn down, close clean");
