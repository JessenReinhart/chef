import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { LLMDecisionProvider } from "../src/orchestrator/llm-decision-provider.ts";
import {
  currentWorkerPolicy,
  parseWorkerPolicy,
  resolveWorkerPolicy,
  runWithWorkerPolicy,
} from "../src/runtime/worker-policy.ts";

const workers = [
  { id: "claude-code", name: "Claude Code", type: "claude-code" },
  { id: "omp", name: "OMP", type: "omp" },
];

assert.deepEqual(parseWorkerPolicy(undefined), { mode: "auto" });
assert.deepEqual(parseWorkerPolicy({ mode: "preferred", workerId: " omp " }), { mode: "preferred", workerId: "omp" });
assert.throws(() => parseWorkerPolicy({ mode: "locked" }), /workerId is required/);
assert.throws(() => parseWorkerPolicy({ mode: "random" }), /mode must be auto, preferred, or locked/);

assert.deepEqual(resolveWorkerPolicy(workers, { mode: "auto" }).workers.map((worker) => worker.id), ["claude-code", "omp"]);
const preferred = resolveWorkerPolicy(workers, { mode: "preferred", workerId: "omp" });
assert.deepEqual(preferred.workers.map((worker) => worker.id), ["omp"]);
assert.equal(preferred.fallback, false);
const fallback = resolveWorkerPolicy(workers, { mode: "preferred", workerId: "missing" });
assert.deepEqual(fallback.workers.map((worker) => worker.id), ["claude-code", "omp"]);
assert.equal(fallback.fallback, true);
assert.throws(
  () => resolveWorkerPolicy(workers, { mode: "locked", workerId: "missing" }),
  /Required worker is not available for Mission execution: missing/,
);

// AsyncLocalStorage keeps simultaneous chat requests from leaking worker
// selection into each other while preserving policy across awaits.
const observed = await Promise.all([
  runWithWorkerPolicy({ mode: "locked", workerId: "omp" }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    return currentWorkerPolicy();
  }),
  runWithWorkerPolicy({ mode: "preferred", workerId: "claude-code" }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return currentWorkerPolicy();
  }),
]);
assert.deepEqual(observed, [
  { mode: "locked", workerId: "omp" },
  { mode: "preferred", workerId: "claude-code" },
]);
assert.deepEqual(currentWorkerPolicy(), { mode: "auto" }, "worker policy must not escape its request scope");

// Integration proof: the LLM planner only sees the selected worker. A model
// response that tries to route to another detected worker is rejected.
let responseWorker = "omp";
const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  req.on("data", (chunk) => { raw += chunk.toString("utf8"); });
  req.on("end", () => {
    const body = JSON.parse(raw) as { messages?: Array<{ role?: string; content?: string }> };
    const system = body.messages?.find((message) => message.role === "system")?.content ?? "";
    assert.match(system, /- omp: OMP \(omp\)/);
    assert.doesNotMatch(system, /claude-code: Claude Code/);
    const plan = {
      goal: "worker policy test",
      tasks: [{
        id: crypto.randomUUID(),
        title: "Policy task",
        description: "Complete the bounded policy test.",
        dependencies: [],
        priority: 1,
        nodeType: "agent.llm",
        assignedTo: responseWorker,
      }],
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }] }));
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("worker policy test server did not bind");

const provider = new LLMDecisionProvider({
  provider: "custom",
  apiKey: "test-key",
  model: "test-model",
  baseUrl: `http://127.0.0.1:${address.port}/v1`,
  timeoutMs: 5_000,
});
const context = { workspaceId: "worker-policy", goal: "test worker selection", availableWorkers: workers };

try {
  const lockedPlan = await runWithWorkerPolicy(
    { mode: "locked", workerId: "omp" },
    () => provider.proposePlan(context),
  );
  assert.ok(lockedPlan);
  assert.equal(lockedPlan.tasks[0].assignedTo, "omp");

  responseWorker = "claude-code";
  await assert.rejects(
    () => runWithWorkerPolicy({ mode: "locked", workerId: "omp" }, () => provider.proposePlan(context)),
    /Worker is not available for Mission execution: claude-code/,
    "planner cannot override a locked user worker",
  );
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log("worker-policy: ok — Auto, Preferred, Locked, and request isolation enforced");
