import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createChef } from "../src/main.ts";
import { GenericTerminalHarness } from "../src/harness/generic.ts";
import type { AgentId, Decision, Plan, PlanProposalContext, PlanTaskOutcome, WorkspaceId } from "../src/core/types.ts";

class CatProvider {
  readonly name = "direct-worker-test";
  readonly #script: string;
  #workspaceId = "";
  constructor(script: string) { this.#script = script; }
  async proposePlan(input: PlanProposalContext): Promise<Plan> {
    this.#workspaceId = input.workspaceId;
    const taskId = randomUUID();
    return {
      id: randomUUID(), workspaceId: input.workspaceId, goal: input.goal, status: "proposed",
      tasks: [{ id: taskId, title: "Interactive worker", description: input.goal, dependencies: [], priority: 1, assignedTo: "cat" }],
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

const dir = await mkdtemp(join(tmpdir(), "chef-direct-worker-"));
const script = join(dir, "cat.mjs");
await writeFile(
  script,
  "process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => process.stdout.write(chunk)); process.stdout.write('READY\\n'); setInterval(() => {}, 1_000);",
  "utf8",
);
const chef = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir, decisionProvider: new CatProvider(script) });
try {
  await chef.start();
  const execution = chef.sendUserMessage("interactive PTY");
  let sessionId = "";
  for (let attempt = 0; attempt < 100 && !sessionId; attempt++) {
    const snapshot = await chef.inspectState();
    sessionId = snapshot.sessions.find((session) => session.status === "running" || session.status === "spawning")?.id ?? "";
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
  assert.ok(sessionId, "worker session must become visible");
  let workerReady = false;
  for (let attempt = 0; attempt < 100 && !workerReady; attempt++) {
    const snapshot = await chef.inspectState();
    workerReady = snapshot.events
      .filter((event) => event.type === "session.data")
      .some((event) => JSON.stringify(event.payload).includes("READY"));
    if (!workerReady) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 10);
      await promise;
    }
  }
  assert.equal(workerReady, true, "worker must be ready before direct input");
  await chef.sendInput(sessionId, "hello from UI\n");
  let observedEcho = false;
  for (let attempt = 0; attempt < 100 && !observedEcho; attempt++) {
    const snapshot = await chef.inspectState();
    observedEcho = snapshot.events
      .filter((event) => event.type === "session.data")
      .some((event) => JSON.stringify(event.payload).includes("hello from UI"));
    if (!observedEcho) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 10);
      await promise;
    }
  }
  assert.equal(observedEcho, true, "PTY must echo direct input before interruption");
  await chef.resizeSession(sessionId, 100, 30);
  await chef.interruptSession(sessionId);
  const result = await execution;
  const snapshot = await chef.inspectState();
  const task = snapshot.tasks[0];
  // node-pty reports Ctrl+C differently across PTY backends (graceful exit on
  // some, signal/non-zero exit on others). It must never become cancellation:
  // only cancelTask owns that lifecycle transition.
  assert.ok(task.status === "completed" || task.status === "failed");
  assert.equal(result.ok, task.status === "completed");
  const userEvents = snapshot.events.filter((event) => event.type.startsWith("user."));
  assert.deepEqual(userEvents.map((event) => event.type), ["user.input", "user.resize", "user.interrupt"]);
  assert.ok(userEvents.every((event) => event.source.type === "user" && event.source.id === "ui"));
  assert.ok(userEvents.every((event) => event.taskId && event.sessionId === sessionId));
  console.log("direct-worker-interaction: ok");
} finally {
  await chef.close();
  await rm(dir, { recursive: true, force: true });
}
