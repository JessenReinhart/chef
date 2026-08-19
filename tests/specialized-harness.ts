import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessEvent } from "../src/harness/generic.ts";
import { SpecializedCliHarness } from "../src/harness/specialized.ts";
import { HarnessRegistry } from "../src/runtime/harness-registry.ts";
import { createChef } from "../src/main.ts";
import type { Decision, DecisionProvider, Plan, PlanProposalContext, PlanTaskOutcome } from "../src/core/types.ts";

const root = await mkdtemp(join(tmpdir(), "chef-specialized-harness-"));
const sessionId = "scheduler-owned-session";
const workerPath = fileURLToPath(new URL("./fixtures/specialized-worker.mjs", import.meta.url));
let created: SpecializedCliHarness | undefined;

try {
  const registry = new HarnessRegistry({ includeDefaults: false });
  registry.register("test-cli", "Test CLI", () => {
    created = new SpecializedCliHarness({
      id: "test-cli",
      type: "test-cli",
      name: "Test CLI",
      binary: process.execPath,
      flags: [workerPath],
      workspaceId: "workspace-test",
      cwd: process.cwd(),
      sidebandRoot: root,
      pollIntervalMs: 10,
    });
    return created;
  });

  const detection = await registry.initialize();
  assert.deepEqual(detection, [{ id: "test-cli", name: "Test CLI", available: true }]);
  const harness = registry.get("test-cli");
  assert.ok(harness, "detected specialized harness is scheduler-addressable");

  const session = await harness.spawn({ sessionId, cols: 90, rows: 30 });
  assert.equal(session.id, sessionId, "spawn preserves the scheduler's persisted session id");
  await harness.resize(sessionId, 100, 35);

  await harness.writeContextRefs(sessionId, [{ type: "task", id: "upstream-task" }]);
  await harness.writeMessage(sessionId, "peer-agent", "review this");

  const outboxEnvelope = {
    version: 1,
    id: "structured-from-child",
    kind: "result",
    from: "process",
    payload: { ok: true },
    timestamp: Date.now(),
  };
  await writeFile(
    join(root, sessionId, "outbox", "structured-from-child.json"),
    JSON.stringify(outboxEnvelope),
    "utf8",
  );

  const events: HarnessEvent[] = [];
  const consume = (async () => {
    for await (const event of harness.events(sessionId)) {
      events.push(event);
      if (event.type === "exit" || event.type === "crash") break;
    }
  })();

  for (let attempt = 0; attempt < 100 && !events.some((event) => event.type === "data" && event.data.includes("CHILD-READY")); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    events.some((event) => event.type === "data" && event.data.includes("CHILD-READY")),
    "specialized child becomes ready",
  );
  await harness.send(sessionId, "ping\r");
  await Promise.race([
    consume,
    new Promise((_, reject) => setTimeout(() => reject(new Error("specialized session timed out")), 10_000)),
  ]);

  assert.ok(
    events.some((event) => event.type === "data" && event.data.includes("CHILD-ECHO:ping")),
    "send reaches the same live PTY that spawn registered",
  );
  assert.ok(
    events.some((event) => event.type === "structured" && event.payload !== null),
    "the persistent adapter retains structured sideband delivery",
  );
  assert.ok(events.some((event) => event.type === "exit"), "child exit remains observable");

  let sidebandDisposed = false;
  for (let attempt = 0; attempt < 100 && !sidebandDisposed; attempt++) {
    try {
      await access(join(root, sessionId));
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      sidebandDisposed = true;
    }
  }
  assert.equal(sidebandDisposed, true, "terminal session teardown disposes its sideband directory");

  await harness.forget(sessionId);
  assert.throws(() => harness.events(sessionId), /No active session/, "forget releases the finished session queue");
  await registry.close();

  console.log("specialized-harness: ok");
} finally {
  await created?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

class SpecializedPlanProvider implements DecisionProvider {
  readonly name = "specialized-plan-test";

  async proposePlan(input: PlanProposalContext): Promise<Plan> {
    const taskId = randomUUID();
    return {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      goal: input.goal,
      status: "proposed",
      tasks: [{
        id: taskId,
        title: "Specialized worker",
        description: input.goal,
        dependencies: [],
        priority: 1,
        assignedTo: "test-cli",
      }],
      taskIds: [taskId],
      createdAt: Date.now(),
    };
  }

  async evaluate(outcome: PlanTaskOutcome): Promise<Decision> {
    return {
      id: randomUUID(),
      workspaceId: "workspace-test",
      type: "task.evaluation",
      summary: outcome.status,
      payload: outcome,
      madeBy: this.name,
      timestamp: Date.now(),
      status: "accepted",
    };
  }

  harnessFor(): never {
    throw new Error("provider fallback must not replace a detected specialized harness");
  }
}

const runtimeRoot = await mkdtemp(join(tmpdir(), "chef-specialized-runtime-"));
const artifactWorker = fileURLToPath(new URL("./fixtures/specialized-artifact-worker.mjs", import.meta.url));
const chef = createChef({
  dbPath: join(runtimeRoot, "chef.sqlite"),
  projectDir: runtimeRoot,
  decisionProvider: new SpecializedPlanProvider(),
});
chef.specializedHarnesses.register("test-cli", "Test CLI", () => new SpecializedCliHarness({
  id: "test-cli",
  type: "test-cli",
  name: "Test CLI",
  binary: process.execPath,
  flags: [artifactWorker],
  workspaceId: chef.workspaceId,
  cwd: runtimeRoot,
  pollIntervalMs: 10,
}));

try {
  await chef.start();
  const result = await chef.sendUserMessage("run through the specialized adapter");
  assert.equal(result.ok, true, result.report);
  const snapshot = await chef.inspectState();
  assert.ok(
    snapshot.sessions.some((session) => session.harnessId === "test-cli" && session.status === "completed"),
    "orchestrator consumes the same detected specialized adapter registered with the scheduler",
  );
  assert.ok(snapshot.artifacts.some((artifact) => artifact.name === "specialized-result"));
  console.log("specialized-harness-orchestration: ok");
} finally {
  await chef.close();
  await rm(runtimeRoot, { recursive: true, force: true });
}
