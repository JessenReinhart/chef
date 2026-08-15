/**
 * Phase 1 acceptance tests: core node registry + execution engine (spec §12).
 *
 * Coverage:
 *  1. Registry lookup by type string returns the correct definition.
 *  2. Config validation rejects invalid configs and applies defaults.
 *  3. Graph validation: unique IDs, valid types, port matching, acyclic
 *     control edges, required inputs present.
 *  4. Linear chain File → Transform → Output executes, emitting
 *     reconstructable events/artifacts.
 *  5. Approval node blocks downstream execution until requestApproval
 *     resolves.
 *  6. Failure on node N stops downstream unless an error edge catches it.
 *  7. Cancellation propagates and updates statuses.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Harness, HarnessEvent, HarnessSession, SpawnConfig } from "../src/core/types.ts";
import type { NodeStatus } from "../src/core/nodes.ts";
import { NODE_DEFINITIONS, nodeRegistry, NodeRegistry } from "../src/runtime/node-registry.ts";
import {
  NodeExecutionEngine,
  validateGraph,
  type EngineHarnessRegistry,
} from "../src/runtime/node-execution-engine.ts";
import { Repository } from "../src/persistence/database.ts";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

function makeWorkspace(repo: Repository): { workspaceId: string } {
  const ws = repo.createWorkspace("node-registry-test");
  return { workspaceId: ws.id };
}

/** In-memory harness stub: echoes a canned response per spawn. */
class StubHarness implements Harness {
  readonly id = "stub-harness";
  readonly type = "stub";
  readonly name = "Stub Harness";
  responses: string[] = [];

  async detect(): Promise<boolean> {
    return true;
  }
  async spawn(_config: SpawnConfig): Promise<HarnessSession> {
    return {
      id: crypto.randomUUID(),
      harnessId: this.id,
      status: "running",
      pid: 1234,
      startedAt: Date.now(),
    };
  }
  async send(_sessionId: string, _input: string): Promise<void> {}
  async resize(_sessionId: string, _cols: number, _rows: number): Promise<void> {}
  async interrupt(_sessionId: string): Promise<void> {}
  async terminate(_sessionId: string): Promise<void> {}
  async kill(_sessionId: string): Promise<void> {}
  async *events(_sessionId: string): AsyncIterable<HarnessEvent> {
    yield { type: "data", data: this.responses.shift() ?? "" };
    yield { type: "exit", exitCode: 0 };
  }
}

class TestHarnessRegistry implements EngineHarnessRegistry {
  readonly #harnesses = new Map<string, Harness>();
  get(agentId: string): Harness | undefined {
    return this.#harnesses.get(agentId);
  }
  set(agentId: string, harness: Harness): void {
    this.#harnesses.set(agentId, harness);
  }
  values(): Iterable<Harness> {
    return this.#harnesses.values();
  }
}

interface Fixture {
  repo: Repository;
  workspaceId: string;
  harnesses: TestHarnessRegistry;
  engine: NodeExecutionEngine;
  events: unknown[];
  close: () => Promise<void>;
}

async function setup(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "chef-node-registry-"));
  const repo = new Repository(join(dir, "test.sqlite"));
  const { workspaceId } = makeWorkspace(repo);
  const harnesses = new TestHarnessRegistry();
  harnesses.set("stub", new StubHarness());
  const events: unknown[] = [];
  const engine = new NodeExecutionEngine(repo, harnesses, {
    onEvent: (event) => events.push(event),
  });
  return {
    repo,
    workspaceId,
    harnesses,
    engine,
    events,
    close: async () => {
      repo.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function node(
  id: string,
  type: string,
  config: Record<string, unknown> = {},
  inputs: Record<string, unknown> = {},
) {
  return { id, type, config, inputs };
}

function edge(
  id: string,
  source: string,
  target: string,
  kind: "data" | "control" | "conditional" | "error" | "approval",
  ports?: { sourcePort: string; targetPort: string },
) {
  return { id, source, target, kind, ...ports };
}

// ---------------------------------------------------------------------------
// 1. Registry lookup by type string
// ---------------------------------------------------------------------------

{
  const registry = new NodeRegistry();
  const defs = registry.list();
  assert.equal(defs.length, 10, "ten node type strings are registered (nine categories; human has approval + input)");

  const byType = new Map(defs.map((d) => [d.type, d]));
  assert.ok(byType.has("agent.llm"), "agent.llm registered");
  assert.ok(byType.has("tool.terminal"), "tool.terminal registered");
  assert.ok(byType.has("tool.file"), "tool.file registered");
  assert.ok(byType.has("tool.browser"), "tool.browser registered");
  assert.ok(byType.has("tool.transform"), "tool.transform registered");
  assert.ok(byType.has("control.logic"), "control.logic registered");
  assert.ok(byType.has("human.approval"), "human.approval registered");
  assert.ok(byType.has("human.input"), "human.input registered");
  assert.ok(byType.has("tool.database"), "tool.database registered");
  assert.ok(byType.has("tool.output"), "tool.output registered");

  assert.equal(nodeRegistry.get("tool.file")?.label, "File/Data", "lookup returns the File/Data definition");
  assert.equal(nodeRegistry.get("human.approval")?.category, "human", "approval node category is human");
  assert.equal(nodeRegistry.get("nope.nope"), undefined, "unknown type returns undefined");
  assert.throws(() => nodeRegistry.require("nope.nope"), /unknown node type/, "require throws on unknown type");

  console.log("registry-lookup: ok");
}

// ---------------------------------------------------------------------------
// 2. Config validation: rejects invalid, applies defaults
// ---------------------------------------------------------------------------

{
  // Defaults applied for a partial config.
  const fileConfig = nodeRegistry.validateConfig("tool.file", {});
  assert.deepEqual(fileConfig, {
    basePath: ".",
    allowedExtensions: [],
    maxSizeBytes: 10 * 1024 * 1024,
  }, "tool.file defaults applied");

  // Invalid config rejected.
  assert.throws(
    () => nodeRegistry.validateConfig("agent.llm", { model: 42 }),
    /config\.model is required/,
    "non-string model rejected",
  );
  // Invalid language falls back to default (js).
  const transformConfig = nodeRegistry.validateConfig("tool.transform", { language: "ruby" });
  assert.ok(typeof transformConfig === "object" && transformConfig !== null, "transform config is object");
  assert.equal((transformConfig as Record<string, unknown>).language, "js", "invalid language defaulted to js");

  // Every definition's defaults validate cleanly.
  for (const def of NODE_DEFINITIONS) {
    const validated = nodeRegistry.validateConfig(def.type, {});
    assert.notEqual(validated, undefined, `${def.type} defaults validate`);
  }

  console.log("config-validation: ok");
}

// ---------------------------------------------------------------------------
// 3. Graph validation
// ---------------------------------------------------------------------------

{
  const fileNode = node("read", "tool.file", {}, { source: "a.txt", operation: "read" });
  const transformNode = node("transform", "tool.transform", {}, { script: "return input;" });
  const outputNode = node("out", "tool.output", {}, { content: "x", format: "markdown" });

  // Valid graph passes.
  const valid = validateGraph(
    [fileNode, transformNode, outputNode],
    [
      edge("e1", "read", "transform", "data", { sourcePort: "content", targetPort: "input" }),
      edge("e2", "transform", "out", "data", { sourcePort: "output", targetPort: "content" }),
    ],
  );
  assert.equal(valid.valid, true, "valid graph passes");
  assert.deepEqual(valid.errors, [], "no errors on valid graph");

  // Duplicate node IDs.
  const dup = validateGraph([fileNode, { ...fileNode }], []);
  assert.equal(dup.valid, false, "duplicate node ids rejected");
  assert.ok(dup.errors.some((e) => e.code === "DUPLICATE_NODE_ID"), "duplicate id error code");

  // Unknown node type.
  const unknownType = validateGraph([node("x", "tool.doesnotexist")], []);
  assert.equal(unknownType.valid, false, "unknown node type rejected");
  assert.ok(unknownType.errors.some((e) => e.code === "UNKNOWN_NODE_TYPE"), "unknown type error code");

  // Invalid config.
  const badConfig = validateGraph([node("x", "agent.llm", { model: 42 })], []);
  assert.equal(badConfig.valid, false, "invalid config rejected");
  assert.ok(badConfig.errors.some((e) => e.code === "INVALID_CONFIG"), "invalid config error code");

  // Missing required input.
  const missingInput = validateGraph([node("x", "tool.terminal")], []);
  assert.equal(missingInput.valid, false, "missing required input rejected");
  assert.ok(
    missingInput.errors.some((e) => e.code === "MISSING_REQUIRED_INPUT"),
    "missing input error code",
  );

  // Port mismatch: edge targets a non-existent input port.
  const portMismatch = validateGraph(
    [fileNode, outputNode],
    [edge("e1", "read", "out", "data", { sourcePort: "content", targetPort: "nonexistent" })],
  );
  assert.equal(portMismatch.valid, false, "port mismatch rejected");
  assert.ok(portMismatch.errors.some((e) => e.code === "PORT_MISMATCH"), "port mismatch error code");

  // Approval edge requires approval ports on both endpoints.
  const approvalMismatch = validateGraph(
    [fileNode, transformNode],
    [edge("e1", "read", "transform", "approval")],
  );
  assert.equal(approvalMismatch.valid, false, "approval edge without approval ports rejected");

  // Cyclic control edges.
  const cycle = validateGraph(
    [
      node("a", "control.logic", { conditionType: "if" }, { condition: true }),
      node("b", "control.logic", { conditionType: "if" }, { condition: true }),
    ],
    [
      edge("c1", "a", "b", "control"),
      edge("c2", "b", "a", "control"),
    ],
  );
  assert.equal(cycle.valid, false, "cyclic control edges rejected");
  assert.ok(cycle.errors.some((e) => e.code === "CYCLIC_CONTROL_EDGES"), "cycle error code");

  // Invalid edge endpoints.
  const badEdge = validateGraph([fileNode], [edge("e1", "read", "ghost", "data")]);
  assert.equal(badEdge.valid, false, "edge to unknown target rejected");
  assert.ok(badEdge.errors.some((e) => e.code === "INVALID_EDGE_TARGET"), "invalid edge target code");

  console.log("graph-validation: ok");
}

// ---------------------------------------------------------------------------
// 4. Linear chain File → Transform → Output executes with events/artifacts
// ---------------------------------------------------------------------------

{
  const fx = await setup();
  try {
    const fileNode = node("read", "tool.file", {}, { source: "hello.txt", operation: "read", format: "text" });
    const transformNode = node("transform", "tool.transform", {}, { script: "return (input ?? '').toUpperCase();" });
    const outputNode = node("out", "tool.output", {}, { content: "placeholder", format: "markdown" });

    const result = await fx.engine.executeGraph(
      fx.workspaceId,
      "linear-chain",
      [fileNode, transformNode, outputNode],
      [
        edge("e1", "read", "transform", "data", { sourcePort: "content", targetPort: "input" }),
        edge("e2", "transform", "out", "data", { sourcePort: "output", targetPort: "content" }),
      ],
    );

    // File → Transform: content flows via the data edge.
    const transform = result.graph.nodes.get("transform")!;
    assert.equal(transform.status, "completed", "transform completed");
    assert.equal(transform.outputs.output, "HELLO.TXT", "transform received file content via data edge");

    // Output → artifact persisted via repository.
    const output = result.graph.nodes.get("out")!;
    assert.equal(output.status, "completed", "output completed");
    const artifact = output.artifacts[0];
    assert.ok(artifact, "output produced an artifact");
    const persisted = fx.repo.getArtifact(artifact.id);
    assert.ok(persisted, "artifact persisted to repository");
    assert.equal(persisted?.metadata.nodeType, "tool.output", "artifact metadata reconstructable");
    assert.ok(output.outputs.deliveryStatus, "output exposes delivery status");

    // Events reconstructable from the repository.
    const events = fx.repo.listEvents(fx.workspaceId);
    const types = events.map((e) => e.type);
    assert.ok(types.includes("node.started"), "node.started events persisted");
    assert.ok(types.includes("node.transform.completed"), "transform completion event persisted");
    assert.ok(types.includes("node.output.completed"), "output completion event persisted");
    assert.equal(events.length >= 6, true, "started/completed events for each node persisted");

    // Node statuses reconstructable from the graph.
    assert.equal(result.graph.nodes.get("read")!.status, "completed", "file node completed");
    assert.equal(result.finalStatuses.get("read"), "completed", "final status map complete");

    // Task rows persisted per node.
    assert.ok(fx.repo.getTask("linear-chain:read"), "task row created for file node");
    assert.ok(fx.repo.getTask("linear-chain:transform"), "task row created for transform node");
    assert.ok(fx.repo.getTask("linear-chain:out"), "task row created for output node");

    // All tasks terminal.
    for (const task of fx.repo.listTasks(fx.workspaceId)) {
      assert.equal(task.status, "completed", `task ${task.id} completed`);
    }

    console.log("linear-chain: ok");
  } finally {
    await fx.close();
  }
}

// ---------------------------------------------------------------------------
// 5. Approval node blocks downstream until requestApproval resolves
// ---------------------------------------------------------------------------

{
  const fx = await setup();
  try {
    const approvalNode = node("approve", "human.approval", {}, { request: "Approve the plan?" });
    const outputNode = node("out", "tool.output", {}, { content: "after approval", format: "markdown" });

    let approvalId: string | undefined;
    let settled = false;
    const execution = fx.engine
      .executeGraph(
        fx.workspaceId,
        "approval-graph",
        [approvalNode, outputNode],
        [edge("e1", "approve", "out", "control")],
      )
      .then((result) => {
        settled = true;
        return result;
      });

    // Wait for the approval to be created and the node to block.
    await new Promise<void>((resolve) => {
      const check = () => {
        const approvals = fx.repo.listApprovals(fx.workspaceId);
        if (approvals.length > 0) {
          approvalId = approvals[0].id;
          resolve();
        } else {
          setTimeout(check, 20);
        }
      };
      check();
    });

    // Downstream must not have run yet.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(settled, false, "execution blocks while approval is pending");
    const outTask = fx.repo.getTask("approval-graph:out");
    if (outTask) {
      assert.notEqual(outTask.status, "completed", "downstream not completed while blocked");
    }

    // Resolve the approval: downstream now proceeds.
    fx.engine.resolveApproval(approvalId!, "accepted", "tester");
    const result = await execution;
    assert.equal(result.graph.nodes.get("approve")!.status, "completed", "approval node completed");
    assert.equal(result.graph.nodes.get("out")!.status, "completed", "downstream ran after approval");
    assert.ok(result.graph.nodes.get("out")!.outputs.deliveryStatus, "downstream output produced");
    const approval = fx.repo.getApproval(approvalId!);
    assert.equal(approval?.status, "accepted", "approval persisted as accepted");
    const approvalEvents = fx.repo
      .listEvents(fx.workspaceId)
      .filter((e) => e.type === "approval.requested");
    assert.equal(approvalEvents.length, 1, "approval.requested event emitted");

    console.log("approval-blocking: ok");
  } finally {
    await fx.close();
  }
}

// ---------------------------------------------------------------------------
// 6. Failure propagation: stops downstream unless an error edge catches it
// ---------------------------------------------------------------------------

{
  const fx = await setup();
  try {
    // Failing node: tool.file with an invalid operation throws inside execute.
    const failing = node("fail", "tool.file", {}, { source: "x", operation: "bogus" });
    const downstream = node("down", "tool.output", {}, { content: "should not run", format: "markdown" });
    const catcher = node("catch", "tool.transform", {}, { script: "return 'handled:' + String(input?._error ?? 'none');" });

    const result = await fx.engine.executeGraph(
      fx.workspaceId,
      "failure-graph",
      [failing, downstream, catcher],
      [
        edge("e1", "fail", "down", "data", { sourcePort: "content", targetPort: "content" }),
        edge("e2", "fail", "catch", "error"),
      ],
    );

    assert.equal(result.graph.nodes.get("fail")!.status, "failed", "failing node failed");
    assert.equal(result.graph.nodes.get("down")!.status, "failed", "downstream stopped by failure");
    assert.ok(
      (result.graph.nodes.get("down")!.error ?? "").includes("upstream failure"),
      "downstream records upstream failure",
    );
    assert.equal(result.graph.nodes.get("catch")!.status, "completed", "error edge caught the failure");
    assert.ok(
      String(result.graph.nodes.get("catch")!.outputs.output).includes("handled"),
      "catcher received the error via _error input",
    );

    // Tasks reflect the statuses.
    assert.equal(fx.repo.getTask("failure-graph:fail")?.status, "failed", "fail task failed");
    assert.equal(fx.repo.getTask("failure-graph:down")?.status, "failed", "downstream task failed");
    assert.equal(fx.repo.getTask("failure-graph:catch")?.status, "completed", "catcher task completed");

    console.log("failure-propagation: ok");
  } finally {
    await fx.close();
  }
}

// ---------------------------------------------------------------------------
// 7. Cancellation propagates and updates statuses
// ---------------------------------------------------------------------------

{
  const fx = await setup();
  try {
    const approvalNode = node("approve", "human.approval", {}, { request: "Never resolve" });
    const downstream = node("down", "tool.output", {}, { content: "x", format: "markdown" });

    const execution = fx.engine.executeGraph(
      fx.workspaceId,
      "cancel-graph",
      [approvalNode, downstream],
      [edge("e1", "approve", "down", "control")],
    );

    // Wait for the approval node to block.
    await new Promise<void>((resolve) => {
      const check = () => {
        if (fx.repo.listApprovals(fx.workspaceId).length > 0) resolve();
        else setTimeout(check, 20);
      };
      check();
    });

    const cancelledCount = fx.engine.cancel("cancel-graph", "test cancellation");
    assert.equal(cancelledCount, 1, "cancel aborts the running execution");

    const result = await execution;
    const statuses = Object.fromEntries(result.finalStatuses);
    assert.equal(statuses.approve, "cancelled", "blocked approval node cancelled");
    assert.equal(statuses.down, "cancelled", "pending downstream cancelled");
    assert.equal(result.graph.nodes.get("approve")!.status, "cancelled", "approval node status updated");
    assert.equal(result.graph.nodes.get("down")!.status, "cancelled", "downstream node status updated");

    const tasks = fx.repo.listTasks(fx.workspaceId);
    assert.equal(tasks.length, 2, "both nodes created tasks");
    for (const task of tasks) {
      assert.equal(task.status, "cancelled", `task ${task.id} cancelled`);
    }

    console.log("cancellation: ok");
  } finally {
    await fx.close();
  }
}

// ---------------------------------------------------------------------------
// Registry edge cases
// ---------------------------------------------------------------------------

{
  const registry = new NodeRegistry();
  // Duplicate registration is rejected.
  assert.throws(() => new NodeRegistry([...NODE_DEFINITIONS, ...NODE_DEFINITIONS]), /duplicate/, "duplicate registration rejected");
  // Every definition carries the required contract fields.
  for (const def of NODE_DEFINITIONS) {
    assert.ok(def.type.startsWith("agent.") || def.type.startsWith("tool.") || def.type.startsWith("control.") || def.type.startsWith("human."), `${def.type} has a namespaced type`);
    assert.ok(def.inputs.length >= 1, `${def.type} declares inputs`);
    assert.ok(def.outputs.length >= 1, `${def.type} declares outputs`);
    assert.equal(typeof def.config.validate, "function", `${def.type} validates config`);
    assert.equal(typeof def.execute, "function", `${def.type} is executable`);
  }
  console.log("registry-edge-cases: ok");
}

console.log("\nAll node-registry tests passed.");
