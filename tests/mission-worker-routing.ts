import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { once } from "node:events";
import { LLMDecisionProvider } from "../src/orchestrator/llm-decision-provider.ts";

let responsePlan: Record<string, unknown> = {};
const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
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

const provider = new LLMDecisionProvider({
  provider: "custom",
  apiKey: "test-key",
  model: "test-model",
  baseUrl: `http://127.0.0.1:${address.port}/v1`,
  timeoutMs: 5_000,
});
const context = {
  workspaceId: "workspace-routing",
  goal: "Implement the todo list",
  availableWorkers: [{ id: "codex", name: "Codex", type: "codex" }],
};

try {
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

  // Real OpenAI-compatible models sometimes add a harmless `plan` envelope
  // and use `prompt` for the task instruction even when asked for JSON. Keep
  // that transport variance at the provider boundary instead of starving the
  // worker of its actual Mission instruction.
  responsePlan = {
    plan: {
      tasks: [{
        id: "task-wrapped",
        nodeType: "agent.llm",
        assignedTo: "codex",
        priority: 1,
        dependencies: [],
        prompt: "Create chef-e2e-proof.txt and verify it contains CHEF_E2E_OK.",
      }],
    },
  };
  const wrapped = await provider.proposePlan(context);
  assert.ok(wrapped);
  assert.equal(wrapped.tasks[0].assignedTo, "codex");
  assert.equal(
    wrapped.tasks[0].description,
    "Create chef-e2e-proof.txt and verify it contains CHEF_E2E_OK.",
    "prompt compatibility must preserve the worker instruction",
  );
  assert.notEqual(wrapped.tasks[0].title, "Untitled", "a prompt-only task should get a useful fallback title");

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

  responsePlan = {
    tasks: [{
      id: "task-empty",
      nodeType: "agent.llm",
      dependencies: [],
      priority: 1,
    }],
  };
  await assert.rejects(
    () => provider.proposePlan(context),
    /every task requires description or prompt/,
    "Mission tasks must never reach a worker with an empty instruction",
  );

  console.log("mission-worker-routing: ok — node type, worker identity, and provider plan envelopes stay coherent");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
