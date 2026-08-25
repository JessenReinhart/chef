import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { once } from "node:events";
import { LLMDecisionProvider } from "../src/orchestrator/llm-decision-provider.ts";
import { SingleWorkerFastPathDecisionProvider } from "../src/orchestrator/fast-path-decision-provider.ts";

let responsePlan: Record<string, unknown> = {};
let plannerRequestCount = 0;
const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  plannerRequestCount += 1;
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-routing-test",
      choices: [{ message: { role: "assistant", content: JSON.stringify(responsePlan) } }],
    }));
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("routing test server did not bind");

const planner = new LLMDecisionProvider({
  provider: "custom",
  apiKey: "test-key",
  model: "test-model",
  baseUrl: `http://127.0.0.1:${address.port}/v1`,
  timeoutMs: 5_000,
});
const provider = new SingleWorkerFastPathDecisionProvider(planner);
const context = {
  workspaceId: "workspace-routing",
  goal: "Implement the todo list",
  availableWorkers: [{ id: "codex", name: "Codex", type: "codex" }],
};

try {
  const canonicalGoal = "Create a simple todo app";
  const fastPath = await provider.proposePlan({ ...context, goal: canonicalGoal });
  assert.ok(fastPath);
  assert.equal(fastPath.tasks.length, 1, "the canonical simple request should have one owner");
  assert.equal(fastPath.tasks[0].nodeType, "agent.llm");
  assert.equal(fastPath.tasks[0].assignedTo, "codex", "the fast path uses a real available task-capable worker");
  assert.equal(fastPath.tasks[0].description, canonicalGoal, "the worker receives the full user goal");
  assert.equal(plannerRequestCount, 0, "the canonical simple request must not pay a planner-provider round trip");

  responsePlan = {
    goal: context.goal,
    tasks: [{
      id: "task-1",
      title: "Implement todo list",
      description: "Implement the requested todo list in the current project.",
      dependencies: [],
      priority: 1,
      nodeType: "agent.llm",
    }],
  };
  const routed = await provider.proposePlan(context);
  assert.ok(routed);
  assert.equal(routed.tasks[0].nodeType, "agent.llm", "nodeType describes the kind of work");
  assert.equal(routed.tasks[0].assignedTo, "codex", "omitted assignee routes to an available worker identity");

  responsePlan = {
    goal: context.goal,
    tasks: [{
      id: "task-2",
      title: "Wrong semantic assignment",
      description: "This fixture intentionally confuses node type with worker identity.",
      dependencies: [],
      priority: 1,
      nodeType: "agent.llm",
      assignedTo: "agent.llm",
    }],
  };
  await assert.rejects(
    () => provider.proposePlan(context),
    /Worker is not available for Mission execution: agent\.llm/,
    "a node type must not be accepted as assignedTo",
  );

  responsePlan = {
    goal: context.goal,
    tasks: [{
      id: "task-3",
      title: "Unsupported direct tool task",
      description: "V1 must not silently route this through a worker PTY.",
      dependencies: [],
      priority: 1,
      nodeType: "tool.terminal",
      assignedTo: "codex",
    }],
  };
  await assert.rejects(
    () => provider.proposePlan(context),
    /Mission node type is not executable in V1: tool\.terminal/,
    "unsupported Mission node types fail closed instead of falling through to a generic process",
  );

  const plannerRequestsBeforeComplexGoal = plannerRequestCount;
  const complexGoal = "Research and compare two architectures, then implement and verify a migration plan";
  responsePlan = {
    goal: complexGoal,
    tasks: [
      {
        id: "task-4",
        title: "Research architectures",
        description: "Compare the candidate architectures.",
        dependencies: [],
        priority: 1,
        nodeType: "agent.llm",
      },
      {
        id: "task-5",
        title: "Plan migration",
        description: "Use the comparison to prepare and verify a migration plan.",
        dependencies: ["task-4"],
        priority: 0,
        nodeType: "agent.llm",
      },
    ],
  };
  const complexPlan = await provider.proposePlan({ ...context, goal: complexGoal });
  assert.ok(complexPlan);
  assert.equal(plannerRequestCount, plannerRequestsBeforeComplexGoal + 1, "complex work must still invoke the planner");
  assert.equal(complexPlan.tasks.length, 2, "the planner remains free to decompose genuinely complex work");

  console.log("mission-worker-routing: ok — simple work skips planning while complex work still decomposes");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}