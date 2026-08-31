import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericTerminalHarness } from "../src/harness/generic.ts";
import { createChef } from "../src/main.ts";
import { artifactHandoff } from "../web/src/artifactHandoff.ts";
import type { LivingArtifact } from "../web/src/artifactProjection.ts";
import type {
  AgentId,
  Decision,
  DecisionProvider,
  Plan,
  PlanProposalContext,
  PlanTaskOutcome,
  WorkspaceId,
} from "../src/core/types.ts";

const REQUEST = "Create a simple todo app";
const RESULT_FILE = "todo-app.mjs";

class EarlyResultDecisionProvider implements DecisionProvider {
  readonly name = "early-result-acceptance";
  readonly #projectDir: string;
  readonly #workerScript: string;
  #workspaceId: WorkspaceId = "";

  constructor(projectDir: string, workerScript: string) {
    this.#projectDir = projectDir;
    this.#workerScript = workerScript;
  }

  async proposePlan(input: PlanProposalContext): Promise<Plan & { routingMode: "single-worker" }> {
    this.#workspaceId = input.workspaceId;
    const taskId = crypto.randomUUID();
    return {
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      goal: input.goal,
      status: "proposed",
      routingMode: "single-worker",
      tasks: [{
        id: taskId,
        title: "Build the todo app",
        description: input.goal,
        dependencies: [],
        priority: 1,
        assignedTo: "todo-builder",
      }],
      taskIds: [taskId],
      createdAt: Date.now(),
    };
  }

  harnessFor(agentId: AgentId, workspaceId: WorkspaceId): GenericTerminalHarness {
    assert.equal(agentId, "todo-builder");
    return new GenericTerminalHarness({
      agentId,
      workspaceId,
      command: process.execPath,
      args: [this.#workerScript],
      cwd: this.#projectDir,
    });
  }

  async evaluate(taskResult: PlanTaskOutcome): Promise<Decision> {
    // Keep the Mission in real verification long enough to prove that a result
    // is independently discoverable before the orchestration request settles.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const accepted = taskResult.status === "completed";
    return {
      id: crypto.randomUUID(),
      workspaceId: this.#workspaceId,
      type: "task.evaluation",
      summary: accepted ? "Todo app verified" : `Todo app ended as ${taskResult.status}`,
      payload: taskResult,
      madeBy: this.name,
      timestamp: Date.now(),
      status: accepted ? "accepted" : "rejected",
    };
  }
}

async function writeWorker(projectDir: string): Promise<string> {
  const workerScript = join(projectDir, "early-result-worker.cjs");
  const source = String.raw`
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const appPath = path.join(process.cwd(), ${JSON.stringify(RESULT_FILE)});
fs.writeFileSync(appPath, "console.log('todo app');\n", "utf8");

const sid = process.env.CHEF_SESSION_ID;
if (!sid) throw new Error("CHEF_SESSION_ID is required");
const envelope = {
  version: 1,
  id: crypto.randomUUID(),
  kind: "artifact",
  from: "process",
  payload: {
    type: "result",
    name: "todo-app",
    uri: "file://" + appPath.replace(/\\\\/g, "/"),
    metadata: {
      content: "Created runnable todo app at " + appPath,
      run: process.execPath + " " + appPath,
      verifiedBy: "early-result-worker"
    }
  },
  timestamp: Date.now()
};
const outbox = path.join(os.tmpdir(), "chef-sideband", sid, "outbox");
fs.mkdirSync(outbox, { recursive: true });
fs.writeFileSync(path.join(outbox, envelope.id + ".json"), JSON.stringify(envelope));
`;
  await writeFile(workerScript, source, "utf8");
  return workerScript;
}

async function waitForArtifact(chef: ReturnType<typeof createChef>, timeoutMs: number): Promise<LivingArtifact> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await chef.inspectState();
    if (snapshot.artifacts.length > 0) return snapshot.artifacts[0] as LivingArtifact;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`result artifact was not discoverable within ${timeoutMs} ms`);
}

async function main(): Promise<void> {
  const projectDir = await mkdtemp(join(tmpdir(), "chef-early-result-"));
  const dbPath = join(projectDir, "chef.sqlite");
  const appPath = join(projectDir, RESULT_FILE);

  try {
    const workerScript = await writeWorker(projectDir);
    const chef = createChef({
      dbPath,
      projectDir,
      decisionProvider: new EarlyResultDecisionProvider(projectDir, workerScript),
      orchestratorTimeoutMs: 10_000,
    });
    await chef.start();

    let sendSettled = false;
    const sendPromise = chef.sendUserMessage(REQUEST).finally(() => { sendSettled = true; });

    const artifact = await waitForArtifact(chef, 2_000);
    assert.equal(sendSettled, false, "result must become discoverable before the orchestration request completes");
    assert.equal(artifact.name, "todo-app", "early durable result must identify the requested output");

    const handoff = artifactHandoff(artifact);
    assert.equal(handoff.summary, `Created runnable todo app at ${appPath}`, "early Simple Mode handoff must explain what changed");
    assert.equal(handoff.location, appPath.replace(/\\/g, "/"), "early Simple Mode handoff must expose the result location");
    assert.equal(handoff.runCommand, `${process.execPath} ${appPath}`, "early Simple Mode handoff must explain how to run the result");
    assert.equal(handoff.verification, "Verified by early-result-worker", "early Simple Mode handoff must expose available verification evidence");

    const result = await sendPromise;
    assert.equal(result.ok, true, `orchestrator failed: ${result.report}`);

    const completed = await chef.inspectState();
    assert.equal(completed.artifacts.length, 1, "early result must remain durable after Mission completion");
    assert.equal(completed.artifacts[0].id, artifact.id, "completion must retain the same result rather than replacing it");
    await chef.close();
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

await main();
console.log("result handoff availability: ok");
