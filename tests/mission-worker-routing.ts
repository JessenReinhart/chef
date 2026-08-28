import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { once } from "node:events";
import { LLMDecisionProvider } from "../src/orchestrator/llm-decision-provider.ts";
import { createMissionDecisionProvider, SingleWorkerFastPathDecisionProvider } from "../src/orchestrator/fast-path-decision-provider.ts";

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
  goal: "Analyze the existing todo architecture",
  availableWorkers: [{ id: "codex", name: "Codex", type: "codex" }],
};

try {
  const canonicalGoal = "Create a todo app";
  const fastPath = await provider.proposePlan({ ...context, goal: canonicalGoal });
  assert.ok(fastPath);
  assert.equal(fastPath.routingMode, "single-worker", "the canonical request must retain its direct execution route without magic qualifier wording");
  assert.equal(fastPath.tasks.length, 1, "the canonical request should have one owner");
  assert.equal(fastPath.tasks[0].nodeType, "agent.llm");
  assert.equal(fastPath.tasks[0].assignedTo, "codex", "the fast path uses a real available task-capable worker");
  assert.equal(fastPath.tasks[0].description, canonicalGoal, "the worker receives the full user goal");
  assert.equal(plannerRequestCount, 0, "the canonical request must not pay a planner-provider round trip");

  const simpleIntentGoals = ["I need a todo app", "I want a todo app"];
  for (const intentGoal of simpleIntentGoals) {
    const requestsBeforeIntent = plannerRequestCount;
    const intentFastPath = await provider.proposePlan({ ...context, goal: intentGoal });
    assert.ok(intentFastPath);
    assert.equal(intentFastPath.routingMode, "single-worker", `${intentGoal} should route directly without requiring an action-verb rewrite`);
    assert.equal(intentFastPath.tasks.length, 1, `${intentGoal} should keep one worker owner`);
    assert.equal(intentFastPath.tasks[0].assignedTo, "codex", `${intentGoal} should use the available task-capable worker`);
    assert.equal(intentFastPath.tasks[0].description, intentGoal, `${intentGoal} must reach the worker unchanged`);
    assert.equal(plannerRequestCount, requestsBeforeIntent, `${intentGoal} must not pay a planner-provider round trip`);
  }

  const fastEvaluationRequestsBefore = plannerRequestCount;
  const fastEvaluation = await provider.evaluate({
    taskId: fastPath.tasks[0].id,
    status: "completed",
    resultSummary: "Todo app created and verified",
  });
  assert.equal(fastEvaluation.status, "accepted", "a completed direct-worker task should finish deterministically");
  assert.match(fastEvaluation.summary, /Todo app created and verified/);
  assert.equal(
    plannerRequestCount,
    fastEvaluationRequestsBefore,
    "a completed direct-worker task must not pay a second provider round trip before Chef can report completion",
  );

  const previousEnv = {
    provider: process.env.CHEF_PROVIDER,
    apiKey: process.env.CHEF_API_KEY,
    model: process.env.CHEF_MODEL,
    baseUrl: process.env.CHEF_BASE_URL,
  };
  try {
    process.env.CHEF_PROVIDER = "custom";
    process.env.CHEF_API_KEY = "test-key";
    process.env.CHEF_MODEL = "test-model";
    process.env.CHEF_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    const configuredProvider = createMissionDecisionProvider();
    assert.ok(configuredProvider, "configured Chef runtime must construct a Mission routing provider");
    const requestsBeforeConfiguredFastPath = plannerRequestCount;
    const configuredFastPath = await configuredProvider.proposePlan({ ...context, goal: canonicalGoal });
    assert.ok(configuredFastPath);
    assert.equal(configuredFastPath.routingMode, "single-worker", "the configured runtime factory must preserve the qualifier-free canonical direct-worker route");
    assert.equal(configuredFastPath.tasks[0].assignedTo, "codex");
    assert.equal(plannerRequestCount, requestsBeforeConfiguredFastPath, "the configured runtime factory must not call the planner for the qualifier-free canonical request");
    const configuredEvaluation = await configuredProvider.evaluate({
      taskId: configuredFastPath.tasks[0].id,
      status: "completed",
      resultSummary: "Configured runtime worker finished",
    });
    assert.equal(configuredEvaluation.status, "accepted");
    assert.equal(
      plannerRequestCount,
      requestsBeforeConfiguredFastPath,
      "the configured direct route must remain provider-independent through its terminal evaluation",
    );
  } finally {
    if (previousEnv.provider === undefined) delete process.env.CHEF_PROVIDER; else process.env.CHEF_PROVIDER = previousEnv.provider;
    if (previousEnv.apiKey === undefined) delete process.env.CHEF_API_KEY; else process.env.CHEF_API_KEY = previousEnv.apiKey;
    if (previousEnv.model === undefined) delete process.env.CHEF_MODEL; else process.env.CHEF_MODEL = previousEnv.model;
    if (previousEnv.baseUrl === undefined) delete process.env.CHEF_BASE_URL; else process.env.CHEF_BASE_URL = previousEnv.baseUrl;
  }

  const straightforwardResearchGoal = "Research the best way on how to create a system with AI";
  const researchRequestsBefore = plannerRequestCount;
  const researchFastPath = await provider.proposePlan({ ...context, goal: straightforwardResearchGoal });
  assert.ok(researchFastPath);
  assert.equal(researchFastPath.routingMode, "single-worker", "straightforward research keeps its direct routing decision observable");
  assert.equal(researchFastPath.tasks.length, 1, "straightforward research should have one owner");
  assert.equal(researchFastPath.tasks[0].assignedTo, "codex", "straightforward research routes directly to an available worker");
  assert.equal(researchFastPath.tasks[0].description, straightforwardResearchGoal, "the research worker receives the full request");
  assert.equal(plannerRequestCount, researchRequestsBefore, "straightforward research must not pay a planner-provider round trip");

  const chainedDeliverableGoal = "Research the options and write a migration report";
  const plannerRequestsBeforeChainedDeliverable = plannerRequestCount;
  responsePlan = {
    goal: chainedDeliverableGoal,
    tasks: [
      {
        id: "task-research",
        title: "Research options",
        description: "Research the available options.",
        dependencies: [],
        priority: 1,
        nodeType: "agent.llm",
      },
      {
        id: "task-report",
        title: "Write migration report",
        description: "Turn the research into the requested migration report.",
        dependencies: ["task-research"],
        priority: 0,
        nodeType: "agent.llm",
      },
    ],
  };
  const chainedDeliverablePlan = await provider.proposePlan({ ...context, goal: chainedDeliverableGoal });
  assert.ok(chainedDeliverablePlan);
  assert.equal(chainedDeliverablePlan.routingMode, "planner", "a chained research deliverable must not be collapsed into the single-worker shortcut");
  assert.equal(plannerRequestCount, plannerRequestsBeforeChainedDeliverable + 1, "a chained research deliverable must invoke the planner");
  assert.equal(chainedDeliverablePlan.tasks.length, 2, "the planner may preserve distinct research and deliverable stages");

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
  assert.equal(routed.routingMode, "planner", "non-fast-path work must retain that it went through planning");
  assert.equal(routed.tasks[0].nodeType, "agent.llm", "nodeType describes the kind of work");
  assert.equal(routed.tasks[0].assignedTo, "codex", "omitted assignee routes to an available worker identity");

  const plannerEvaluationRequestsBefore = plannerRequestCount;
  responsePlan = { summary: "Planner-routed task accepted", status: "accepted" };
  const plannerEvaluation = await provider.evaluate({
    taskId: routed.tasks[0].id,
    status: "completed",
    resultSummary: "Architecture analysis complete",
  });
  assert.equal(plannerEvaluation.status, "accepted");
  assert.equal(
    plannerRequestCount,
    plannerEvaluationRequestsBefore + 1,
    "planner-routed work must retain provider-backed evaluation instead of being mistaken for a direct task",
  );

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
  assert.equal(complexPlan.routingMode, "planner", "complex work must preserve its planner route for downstream observability");
  assert.equal(plannerRequestCount, plannerRequestsBeforeComplexGoal + 1, "complex work must still invoke the planner");
  assert.equal(complexPlan.tasks.length, 2, "the planner remains free to decompose genuinely complex work");

  const complexIntentGoal = "I need an architecture comparison and then write a migration report";
  const plannerRequestsBeforeComplexIntent = plannerRequestCount;
  responsePlan = {
    goal: complexIntentGoal,
    tasks: [
      {
        id: "task-6",
        title: "Compare architectures",
        description: "Compare the candidate architectures.",
        dependencies: [],
        priority: 1,
        nodeType: "agent.llm",
      },
      {
        id: "task-7",
        title: "Write migration report",
        description: "Write the migration report from the comparison.",
        dependencies: ["task-6"],
        priority: 0,
        nodeType: "agent.llm",
      },
    ],
  };
  const complexIntentPlan = await provider.proposePlan({ ...context, goal: complexIntentGoal });
  assert.ok(complexIntentPlan);
  assert.equal(complexIntentPlan.routingMode, "planner", "intent phrasing must not override explicit complexity markers");
  assert.equal(plannerRequestCount, plannerRequestsBeforeComplexIntent + 1, "complex intent phrasing must still invoke the planner");
  assert.equal(complexIntentPlan.tasks.length, 2, "planner decomposition remains available for complex intent phrasing");

  console.log("mission-worker-routing: ok — simple intent phrasing and qualifier-free direct work stay provider-independent while explicit complexity still plans and evaluates through the provider");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
