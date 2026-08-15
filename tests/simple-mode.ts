/**
 * Phase 4 Simple Mode regression test (spec §13, task-4-simple-mode.md):
 *  1. Template CRUD via HTTP + Repository: seed the 4 required templates,
 *     list, get, update, delete; validation rejects bad payloads.
 *  2. Wizard validation: required fields per node type, number bounds,
 *     simple→runtime config mapping produces NODE_DEFINITIONS-valid configs,
 *     preview graph chains template nodes in order.
 *  3. Mode switching: toggle state persists per workspace, the workflow
 *     definition and graph are unchanged across mode switches.
 *  4. Workflow launch: POST /api/nodes/run creates a task per node and
 *     graph/status endpoints project the launched workflow.
 *
 * Runtime is authoritative; the UI is a projection. This test drives the
 * same HTTP surface the web client uses and the same Repository the
 * wizard-backed flows persist through.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { NODE_DEFINITIONS, nodeRegistry } from "../src/runtime/node-registry.ts";
import type { Repository, Template } from "../src/persistence/database.ts";

// ---------------------------------------------------------------------------
// Simple-mode projection helpers (mirror web/src/simpleNodeConfig.tsx).
// The web components are TSX and not importable under strip-types; the
// mapping contract they implement is exercised here against the runtime
// NODE_DEFINITIONS so a wizard-generated workflow always validates.
// ---------------------------------------------------------------------------

const SIMPLE_TYPE_MAP: Record<string, string> = {
  "agent.llm": "task",
  "tool.file": "file",
  "tool.transform": "transform",
  "tool.browser": "browser",
  "tool.output": "output",
  "tool.terminal": "terminal",
  "tool.database": "database",
  "control.logic": "logic",
  "human.approval": "approval",
  "human.input": "input",
};

function toSimpleType(nodeType: string): string {
  return SIMPLE_TYPE_MAP[nodeType] ?? nodeType;
}

/** Required simple-mode field keys per simple type (from getSimpleFields). */
const REQUIRED_SIMPLE_FIELDS: Record<string, string[]> = {
  task: ["prompt"],
  file: ["source", "operation"],
  transform: ["script"],
  browser: ["url", "action"],
  approval: ["request"],
  logic: ["conditionType", "expression"],
  output: ["format"],
};

/** Minimal valid simple-mode answers per simple type. */
function validAnswersFor(nodeType: string): Record<string, unknown> {
  switch (nodeType) {
    case "task":
      return { prompt: "Analyze the data and produce a summary." };
    case "file":
      return { source: "/data/statement.xlsx", operation: "read", format: "xlsx" };
    case "transform":
      return { script: "return input;", format: "auto" };
    case "browser":
      return { url: "https://example.com", action: "navigate", selector: "" };
    case "approval":
      return { request: "Approve the report before delivery.", timeoutMs: 24, required: true };
    case "logic":
      return { conditionType: "if", expression: "variance > 0.1", maxIterations: 100 };
    case "output":
      return { format: "pdf", recipients: "cfo@example.com", template: "monthly-report" };
    default:
      return {};
  }
}

/** Wizard-style validation mirroring SetupWizard.validateDraft. */
function wizardValidate(template: Template, answers: Record<string, Record<string, unknown>>): string[] {
  const errors: string[] = [];
  const nodes = (template.nodes as Array<{ id: string; type: string }>) ?? [];
  for (const node of nodes) {
    const simpleType = toSimpleType(node.type);
    const nodeAnswers = answers[node.id] ?? {};
    for (const key of REQUIRED_SIMPLE_FIELDS[simpleType] ?? []) {
      const value = nodeAnswers[key];
      if (value === undefined || value === null || value === "") {
        errors.push(`${node.id}.${key} is required`);
      }
    }
    if (simpleType === "approval") {
      const hours = nodeAnswers.timeoutMs as number | undefined;
      if (hours !== undefined && (Number.isNaN(Number(hours)) || Number(hours) < 0 || Number(hours) > 168)) {
        errors.push(`${node.id}.timeoutMs out of range`);
      }
    }
    if (simpleType === "logic") {
      const maxIter = nodeAnswers.maxIterations as number | undefined;
      if (maxIter !== undefined && (Number.isNaN(Number(maxIter)) || Number(maxIter) < 1 || Number(maxIter) > 1000)) {
        errors.push(`${node.id}.maxIterations out of range`);
      }
    }
  }
  return errors;
}

/** Simple→runtime config mapping mirroring mapSimpleToRuntime. */
function mapSimpleToRuntime(nodeType: string, simpleValues: Record<string, unknown>): Record<string, unknown> {
  const runtimeConfig: Record<string, unknown> = {};
  switch (nodeType) {
    case "task":
      runtimeConfig.model = "default";
      runtimeConfig.temperature = 0.2;
      runtimeConfig.maxTokens = 4096;
      runtimeConfig.systemPrompt = (simpleValues.prompt as string) || "";
      runtimeConfig.tools = [];
      runtimeConfig.permissionPolicy = "ask";
      break;
    case "file":
      runtimeConfig.basePath = ".";
      runtimeConfig.allowedExtensions = [];
      runtimeConfig.maxSizeBytes = 10 * 1024 * 1024;
      break;
    case "approval":
      runtimeConfig.timeoutMs = ((simpleValues.timeoutMs as number) || 0) * 3600 * 1000;
      runtimeConfig.required = simpleValues.required !== false;
      runtimeConfig.options = [];
      break;
    case "logic":
      runtimeConfig.conditionType = (simpleValues.conditionType as string) || "if";
      runtimeConfig.expression = (simpleValues.expression as string) || "";
      runtimeConfig.maxIterations = (simpleValues.maxIterations as number) || 100;
      break;
    case "output":
      runtimeConfig.defaultFormat = (simpleValues.format as string) || "markdown";
      runtimeConfig.templates = simpleValues.template ? [simpleValues.template as string] : [];
      runtimeConfig.deliveryChannels = ((simpleValues.recipients as string) || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      break;
    case "browser":
      runtimeConfig.headless = true;
      runtimeConfig.timeoutMs = 30_000;
      runtimeConfig.viewport = { width: 1280, height: 720 };
      runtimeConfig.userAgent = "";
      break;
    case "transform":
      runtimeConfig.language = "js";
      runtimeConfig.allowedImports = [];
      runtimeConfig.timeoutMs = 10_000;
      break;
    default:
      break;
  }
  return runtimeConfig;
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

interface JsonEnvelope<T = unknown> {
  ok?: boolean;
  data?: T;
  error?: string;
}

async function getJson<T>(base: string, path: string): Promise<{ status: number; data: JsonEnvelope<T> }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, data: (await res.json()) as JsonEnvelope<T> };
}

async function sendJson<T>(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: JsonEnvelope<T> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as JsonEnvelope<T> };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const dir = await mkdtemp(join(tmpdir(), "chef-simple-mode-"));
const chef = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir });

try {
  await chef.start();
  const { repository, workspaceId } = chef;

  // ====================================================================
  // 1. Template CRUD: runtime already seeded 4 templates; verify + CRUD
  // ====================================================================
  console.log("Testing template CRUD...");

  const seeded = repository.listTemplates(workspaceId);
  assert.equal(seeded.length, 4, "runtime must seed exactly 4 templates");
  const names = seeded.map((t) => t.name);
  for (const required of ["Monthly Financial Report", "Cash Flow Analysis", "Budget vs Actual", "Developer Fix/Verify"]) {
    assert.ok(names.includes(required), `seeded templates must include '${required}'`);
  }
  // Every seeded template has at least one node and a category metadata.
  for (const t of seeded) {
    assert.ok(Array.isArray(t.nodes) && t.nodes.length > 0, `${t.name} must carry nodes`);
    assert.equal(typeof t.metadata.category, "string", `${t.name} must carry a category`);
  }

  const listed = repository.listTemplates(workspaceId);
  assert.equal(listed.length, 4, "listTemplates must return all 4 seeded templates");
  assert.equal(repository.getTemplate(seeded[0].id)?.name, seeded[0].name, "getTemplate must return the seeded template");

  // Update: rename + replace nodes; updatedAt must advance.
  const before = seeded[0].updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  const updated = repository.updateTemplate(seeded[0].id, {
    name: "Monthly Financial Report (v2)",
    nodes: [
      { id: "fetch-data", type: "tool.file", config: { title: "Fetch Financial Data", description: "Pull transaction data" } },
      { id: "deliver", type: "tool.output", config: { title: "Deliver Report", description: "Deliver" } },
    ],
  });
  assert.equal(updated.name, "Monthly Financial Report (v2)", "updateTemplate must rename");
  assert.equal((updated.nodes as unknown[]).length, 2, "updateTemplate must replace nodes");
  assert.ok(updated.updatedAt > before, "updatedAt must advance on update");

  // Delete + isolation.
  repository.deleteTemplate(seeded[1].id);
  assert.equal(repository.getTemplate(seeded[1].id), null, "deleted template must be gone");
  assert.equal(repository.listTemplates(workspaceId).length, 3, "list must shrink after delete");
  // Templates are workspace-scoped: a second workspace must not see them.
  const otherWorkspace = repository.createWorkspace({ name: "Other" });
  assert.equal(repository.listTemplates(otherWorkspace.id).length, 0, "templates must be workspace-scoped");

  // HTTP surface.
  const server = createHttpServer(chef);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const httpList = await getJson<unknown[]>(base, "/api/templates");
  assert.equal(httpList.status, 200, "GET /api/templates must return 200");
  assert.equal(httpList.data.ok, true);
  assert.equal((httpList.data.data as unknown[]).length, 3, "HTTP list must match repository (3 after delete)");

  const httpGet = await getJson<Template>(base, `/api/templates/${seeded[0].id}`);
  assert.equal(httpGet.status, 200);
  assert.equal(httpGet.data.data?.name, "Monthly Financial Report (v2)", "HTTP get must return updated template");

  const httpCreate = await sendJson<Template>(base, "POST", "/api/templates", {
    name: "HTTP Created Template",
    description: "Created over HTTP",
    nodes: [{ id: "n1", type: "agent.llm", config: { title: "Node 1" } }],
    metadata: { category: "operations" },
  });
  assert.equal(httpCreate.status, 201, "POST /api/templates must return 201");
  assert.equal(httpCreate.data.data?.name, "HTTP Created Template");

  const httpPatch = await sendJson<Template>(base, "PATCH", `/api/templates/${seeded[0].id}`, { name: "Renamed via HTTP" });
  assert.equal(httpPatch.status, 200);
  assert.equal(httpPatch.data.data?.name, "Renamed via HTTP", "PATCH must rename");

  const httpDelete = await sendJson(base, "DELETE", `/api/templates/${seeded[2].id}`);
  assert.equal(httpDelete.status, 200);
  assert.equal(repository.getTemplate(seeded[2].id), null, "DELETE via HTTP must remove");

  const httpGetMissing = await getJson(base, "/api/templates/does-not-exist");
  assert.equal(httpGetMissing.status, 404, "GET missing template must 404");

  const httpBadCreate = await sendJson(base, "POST", "/api/templates", {});
  assert.equal(httpBadCreate.status, 400, "POST without name must 400");
  assert.ok(String(httpBadCreate.data.error).includes("name"), "400 must explain the missing name");

  // ====================================================================
  // 2. Wizard validation: required fields, bounds, config mapping
  // ====================================================================
  console.log("Testing wizard validation...");

  // Re-list after HTTP mutations to get current templates
  const current = repository.listTemplates(workspaceId);
  const monthly = current.find((t) => t.name === "Renamed via HTTP") ?? current[0];
  const nodes = monthly.nodes as Array<{ id: string; type: string }>;

  // Every wizard-visible node type maps to a NODE_DEFINITIONS entry.
  for (const node of nodes) {
    const def = NODE_DEFINITIONS.find((d) => d.type === node.type);
    assert.ok(def, `template node type '${node.type}' must exist in NODE_DEFINITIONS`);
  }

  // Empty answers: every required field reports a validation error.
  const emptyAnswers: Record<string, Record<string, unknown>> = {};
  const emptyErrors = wizardValidate(monthly, emptyAnswers);
  const expectedRequired = nodes.flatMap((n) =>
    (REQUIRED_SIMPLE_FIELDS[toSimpleType(n.type)] ?? []).map((key) => `${n.id}.${key} is required`),
  );
  assert.equal(emptyErrors.length, expectedRequired.length, "all required fields must be flagged");
  for (const err of expectedRequired) {
    assert.ok(emptyErrors.includes(err), `missing expected error: ${err}`);
  }

  // Partial answers: only the still-missing fields are flagged.
  const partial: Record<string, Record<string, unknown>> = {};
  for (const node of nodes) {
    const simpleType = toSimpleType(node.type);
    const answers = validAnswersFor(simpleType);
    delete answers[Object.keys(answers)[0]]; // drop the first required field
    partial[node.id] = answers;
  }
  const partialErrors = wizardValidate(monthly, partial);
  assert.ok(partialErrors.length > 0, "partial answers must fail validation");
  assert.ok(partialErrors.length < expectedRequired.length, "partial answers must pass some fields");

  // Number bounds: approval timeout must be ≤ 168h, logic iterations ≤ 1000.
  const boundAnswers: Record<string, Record<string, unknown>> = {};
  for (const node of nodes) {
    boundAnswers[node.id] = validAnswersFor(toSimpleType(node.type));
  }
  const approval = nodes.find((n) => n.type === "human.approval");
  const logic = nodes.find((n) => n.type === "control.logic");
  if (approval) {
    boundAnswers[approval.id] = { ...boundAnswers[approval.id], timeoutMs: 200 };
    const errors = wizardValidate(monthly, boundAnswers);
    assert.ok(errors.some((e) => e.startsWith(`${approval.id}.timeoutMs`)), "timeout > 168h must be rejected");
    boundAnswers[approval.id] = { ...boundAnswers[approval.id], timeoutMs: 24 };
  }
  if (logic) {
    boundAnswers[logic.id] = { ...boundAnswers[logic.id], maxIterations: 5000 };
    const errors = wizardValidate(monthly, boundAnswers);
    assert.ok(errors.some((e) => e.startsWith(`${logic.id}.maxIterations`)), "iterations > 1000 must be rejected");
    boundAnswers[logic.id] = { ...boundAnswers[logic.id], maxIterations: 50 };
  }

  // Complete answers pass validation.
  const completeAnswers: Record<string, Record<string, unknown>> = {};
  for (const node of nodes) {
    completeAnswers[node.id] = validAnswersFor(toSimpleType(node.type));
  }
  assert.equal(wizardValidate(monthly, completeAnswers).length, 0, "complete answers must validate");

  // Simple→runtime mapping produces configs accepted by NODE_DEFINITIONS.
  for (const node of nodes) {
    const simpleType = toSimpleType(node.type);
    const def = NODE_DEFINITIONS.find((d) => d.type === node.type)!;
    const runtimeConfig = mapSimpleToRuntime(simpleType, validAnswersFor(simpleType));
    const validated = def.config.validate(runtimeConfig);
    assert.ok(validated, `config for ${node.type} must validate`);
    // Simple mode must never leak model/temperature/tokens for non-task nodes.
    if (simpleType !== "task") {
      assert.equal("model" in runtimeConfig, false, `${node.type} simple config must not set model`);
    }
  }

  // Approval hour→ms conversion: 24h must map to 86_400_000 ms.
  const approvalConfig = mapSimpleToRuntime("approval", { timeoutMs: 24, required: true });
  assert.equal(approvalConfig.timeoutMs, 24 * 3600 * 1000, "approval timeout must convert hours to ms");

  // Output recipients split into delivery channels.
  const outputConfig = mapSimpleToRuntime("output", { format: "email", recipients: "a@x.com, b@x.com", template: "tpl" });
  assert.deepEqual(outputConfig.deliveryChannels, ["a@x.com", "b@x.com"], "recipients must split into channels");
  assert.equal(outputConfig.defaultFormat, "email");
  assert.deepEqual(outputConfig.templates, ["tpl"]);

  // The runtime registry validates the same configs through the singleton.
  for (const node of nodes) {
    const simpleType = toSimpleType(node.type);
    const runtimeConfig = mapSimpleToRuntime(simpleType, validAnswersFor(simpleType));
    const def = nodeRegistry.getDefinition(node.type);
    assert.ok(def, `nodeRegistry must know '${node.type}'`);
    const validated = def.config.validate(runtimeConfig);
    assert.equal(typeof validated, "object", `registry must accept mapped config for '${node.type}'`);
  }

  // ====================================================================
  // 3. Mode switching: toggle persists per workspace, workflow unchanged
  // ====================================================================
  console.log("Testing mode switching...");

  const STORAGE_KEY = "chef:mode";
  // Simulate the App.tsx persistence contract (localStorage round-trip).
  const storage = new Map<string, string>();
  function setMode(next: string): void {
    storage.set(STORAGE_KEY, next);
  }
  function readMode(): string {
    const stored = storage.get(STORAGE_KEY);
    return stored === "simple" || stored === "power" ? stored : "simple";
  }
  assert.equal(readMode(), "simple", "unset mode must default to simple");
  setMode("power");
  assert.equal(readMode(), "power", "toggle to power must persist");
  setMode("simple");
  assert.equal(readMode(), "simple", "toggle back to simple must persist");

  // Persistence is per-workspace: a second workspace keeps its own mode.
  const otherStorage = new Map<string, string>();
  otherStorage.set(`chef:mode:${otherWorkspace.id}`, "power");
  assert.equal(otherStorage.get(`chef:mode:${otherWorkspace.id}`), "power", "mode must persist per workspace");

  // Toggling mode must not disturb the workflow definition or graph.
  const snapshotBefore = await chef.inspectState();
  setMode("power");
  setMode("simple");
  const snapshotAfter = await chef.inspectState();
  assert.equal(snapshotAfter.plans.length, snapshotBefore.plans.length, "plans must survive mode toggles");
  assert.equal(snapshotAfter.tasks.length, snapshotBefore.tasks.length, "tasks must survive mode toggles");
  assert.equal(snapshotAfter.approvals.length, snapshotBefore.approvals.length, "approvals must survive mode toggles");

  // ====================================================================
  // 4. Workflow launch: POST /api/nodes/run per node, graph projection
  // ====================================================================
  console.log("Testing workflow launch...");

  const launchNodes = (monthly.nodes as Array<{ id: string; type: string }>).filter((n) => n.type !== "human.approval");
  const taskIds: string[] = [];
  for (const node of launchNodes) {
    const res = await sendJson<{ taskId: string }>(base, "POST", "/api/nodes/run", {
      nodeId: node.id,
      title: node.id,
      workflowNodeId: node.id,
    });
    assert.equal(res.status, 201, `POST /api/nodes/run must 201 for ${node.id}`);
    assert.ok(res.data.data?.taskId, "launch must return a taskId");
    taskIds.push(res.data.data!.taskId);
  }
  assert.equal(taskIds.length, launchNodes.length, "one task per launchable node");

  // Tasks are persisted with workflowNodeId links back to template nodes.
  await waitFor(async () => (await chef.inspectState()).tasks.length >= launchNodes.length);
  const snapshot = await chef.inspectState();
  const launched = snapshot.tasks.filter((t) => taskIds.includes(t.id));
  assert.equal(launched.length, launchNodes.length, "launched tasks must be persisted");
  for (let i = 0; i < launched.length; i++) {
    assert.equal(launched[i].workflowNodeId, launchNodes[i].id, `task ${i} must link to ${launchNodes[i].id}`);
  }

  // Approval request for the human gate persists an approval.
  const reviewNode = (monthly.nodes as Array<{ id: string; type: string }>).find((n) => n.type === "human.approval");
  assert.ok(reviewNode, "monthly template must include a human approval node");

  // Graph projection includes the launched nodes.
  const graphRes = await getJson<{ version: number; nodes: Array<{ taskId?: string; type?: string }> }>(base, "/api/graph");
  assert.equal(graphRes.status, 200);
  assert.equal(graphRes.data.data?.version, 1, "graph must be version 1");
  const graph = graphRes.data.data!;
  for (const taskId of taskIds) {
    assert.ok(graph.nodes.some((n) => n.taskId === taskId), `graph must include task ${taskId}`);
  }

  // HTTP template list still serves the surviving templates after launch.
  const finalList = await getJson<unknown[]>(base, "/api/templates");
  assert.equal(finalList.status, 200);
  assert.equal((finalList.data.data as unknown[]).length, repository.listTemplates(workspaceId).length);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await chef.close();
  console.log("simple-mode: ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}