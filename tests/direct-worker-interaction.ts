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
await writeFile(script, "process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => process.stdout.write(chunk));", "utf8");
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
  await chef.sendInput(sessionId, "hello from UI\n");
  await chef.resizeSession(sessionId, 100, 30);
  await chef.interruptSession(sessionId);
  const result = await execution;
  assert.equal(result.ok, true, `orchestrator failed: ${result.report}`);
  const snapshot = await chef.inspectState();
  const userEvents = snapshot.events.filter((event) => event.type.startsWith("user."));
  assert.deepEqual(userEvents.map((event) => event.type), ["user.input", "user.resize", "user.interrupt"]);
  assert.ok(userEvents.every((event) => event.source.type === "user" && event.source.id === "ui"));
  assert.ok(userEvents.every((event) => event.taskId && event.sessionId === sessionId));
  const output = snapshot.events.filter((event) => event.type === "session.data");
  assert.ok(output.some((event) => JSON.stringify(event.payload).includes("hello from UI")), "PTY must echo direct input");
  await chef.close();
  console.log("direct-worker-interaction: ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
