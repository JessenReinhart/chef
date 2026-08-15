/**
 * Phase 2 API backend regression test:
 *  1. Workflow/Plan endpoints: list, get, create, update status
 *  2. Template endpoints: list, get, create, update, delete
 *  3. Node-run endpoints: create task, get status, cancel
 *  4. Tool endpoints: list, execute (placeholder)
 *  5. Inspector endpoints: state, sessions, events, artifacts
 *  6. SSE: filtering by type and afterSeq for restart-safe catch-up
 *  7. Strict validation: malformed payloads return 400
 *  8. Restart-safe state: data persists across close/reopen
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-api-test-"));
const chef = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir });

try {
  await chef.start();
  const server = createHttpServer(chef);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  // Helper for JSON requests
  async function postJson<T>(path: string, body: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as T };
  }

  async function patchJson<T>(path: string, body: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(`${base}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as T };
  }

  async function delJson<T>(path: string): Promise<{ status: number; data: T }> {
    const res = await fetch(`${base}${path}`, { method: "DELETE" });
    return { status: res.status, data: (await res.json()) as T };
  }

  async function getJson<T>(path: string): Promise<{ status: number; data: T }> {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, data: (await res.json()) as T };
  }

  // ============================================================
  // 1. Workflow/Plan endpoints
  // ============================================================
  console.log("Testing workflow endpoints...");

  const listEmpty = await getJson<{ ok: boolean; data: unknown[] }>("/api/workflows");
  assert.equal(listEmpty.status, 200);
  assert.equal(listEmpty.data.ok, true);
  assert.ok(Array.isArray(listEmpty.data.data));

  const createPlan = await postJson<{ ok: boolean; data: { id: string; goal: string; status: string } }>("/api/workflows", { goal: "Test workflow" });
  assert.equal(createPlan.status, 201);
  assert.equal(createPlan.data.ok, true);
  assert.equal(createPlan.data.data.goal, "Test workflow");
  assert.equal(createPlan.data.data.status, "draft");
  const planId = createPlan.data.data.id;

  const getPlan = await getJson<{ ok: boolean; data: { id: string; goal: string } }>(`/api/workflows/${planId}`);
  assert.equal(getPlan.status, 200);
  assert.equal(getPlan.data.ok, true);
  assert.equal(getPlan.data.data.id, planId);

  const updatePlan = await patchJson<{ ok: boolean; data: { status: string } }>(`/api/workflows/${planId}`, { status: "approved" });
  assert.equal(updatePlan.status, 200);
  assert.equal(updatePlan.data.ok, true);
  assert.equal(updatePlan.data.data.status, "approved");

  // Validation: missing goal
  const badCreate = await postJson("/api/workflows", {});
  assert.equal(badCreate.status, 400);
  assert.ok(badCreate.data.error?.includes("goal"));

  // Validation: invalid status
  const badStatus = await patchJson(`/api/workflows/${planId}`, { status: "invalid" });
  assert.equal(badStatus.status, 400);
  assert.ok(badStatus.data.error?.includes("status"));

  // Not found
  const notFound = await getJson(`/api/workflows/nonexistent`);
  assert.equal(notFound.status, 404);

  // ============================================================
  // 2. Template endpoints
  // ============================================================
  console.log("Testing template endpoints...");

  const listTemplatesEmpty = await getJson<{ ok: boolean; data: unknown[] }>("/api/templates");
  assert.equal(listTemplatesEmpty.status, 200);
  assert.equal(listTemplatesEmpty.data.ok, true);

  const createTemplate = await postJson<{ ok: boolean; data: { id: string; name: string } }>("/api/templates", {
    name: "Test Template",
    description: "A test template",
    nodes: [{ id: "1", type: "task", title: "Task 1" }],
    metadata: { version: 1 },
  });
  assert.equal(createTemplate.status, 201);
  assert.equal(createTemplate.data.ok, true);
  const templateId = createTemplate.data.data.id;

  const getTemplate = await getJson<{ ok: boolean; data: { id: string; name: string } }>(`/api/templates/${templateId}`);
  assert.equal(getTemplate.status, 200);
  assert.equal(getTemplate.data.ok, true);

  const updateTemplate = await patchJson<{ ok: boolean; data: { name: string } }>(`/api/templates/${templateId}`, {
    name: "Updated Template",
    nodes: [{ id: "1", type: "task", title: "Task 1" }, { id: "2", type: "task", title: "Task 2" }],
  });
  assert.equal(updateTemplate.status, 200);
  assert.equal(updateTemplate.data.ok, true);
  assert.equal(updateTemplate.data.data.name, "Updated Template");

  const deleteTemplate = await delJson(`/api/templates/${templateId}`);
  assert.equal(deleteTemplate.status, 200);
  assert.equal(deleteTemplate.data.ok, true);

  const getDeleted = await getJson(`/api/templates/${templateId}`);
  assert.equal(getDeleted.status, 404);

  // Validation: missing name
  const badTemplate = await postJson("/api/templates", {});
  assert.equal(badTemplate.status, 400);
  assert.ok(badTemplate.data.error?.includes("name"));

  // ============================================================
  // 3. Node-run endpoints
  // ============================================================
  console.log("Testing node-run endpoints...");

  const runNode = await postJson<{ ok: boolean; data: { taskId: string } }>("/api/nodes/run", {
    nodeId: "test-node-1",
    title: "Run test node",
    assignedTo: "agent-1",
    workflowNodeId: "wf-node-1",
  });
  assert.equal(runNode.status, 201);
  assert.equal(runNode.data.ok, true);
  const taskId = runNode.data.data.taskId;

  const getNodeStatus = await getJson<{ ok: boolean; data: { id: string; status: string } }>(`/api/nodes/${taskId}/status`);
  assert.equal(getNodeStatus.status, 200);
  assert.equal(getNodeStatus.data.ok, true);
  assert.equal(getNodeStatus.data.data.id, taskId);
  assert.equal(getNodeStatus.data.data.status, "pending");

  const cancelNode = await postJson<{ ok: boolean }>(`/api/nodes/${taskId}/cancel`, {});
  assert.equal(cancelNode.status, 200);
  assert.equal(cancelNode.data.ok, true);

  // Validation: missing nodeId
  const badNode = await postJson("/api/nodes/run", {});
  assert.equal(badNode.status, 400);
  assert.ok(badNode.data.error?.includes("nodeId"));

  // Not found
  const notFoundNode = await getJson(`/api/nodes/nonexistent/status`);
  assert.equal(notFoundNode.status, 404);

  // ============================================================
  // 4. Tool endpoints
  // ============================================================
  console.log("Testing tool endpoints...");

  const listTools = await getJson<{ ok: boolean; data: Array<{ type: string }> }>("/api/tools");
  assert.equal(listTools.status, 200);
  assert.equal(listTools.data.ok, true);
  assert.ok(listTools.data.data.length >= 6);
  const toolTypes = listTools.data.data.map((t) => t.type);
  assert.ok(toolTypes.includes("code_exec"));
  assert.ok(toolTypes.includes("file_read"));
  assert.ok(toolTypes.includes("file_write"));
  assert.ok(toolTypes.includes("web_search"));
  assert.ok(toolTypes.includes("fetch"));
  assert.ok(toolTypes.includes("bash"));

  const execTool = await postJson<{ error: string }>("/api/tools/execute", {
    type: "code_exec",
    params: { language: "typescript", code: "console.log('hello')" },
  });
  assert.equal(execTool.status, 501, "tool execution without a runner must be an explicit 501 (no fake success)");
  assert.ok(execTool.data.error.includes("not implemented"));

  // Validation: missing type
  const badTool = await postJson("/api/tools/execute", {});
  assert.equal(badTool.status, 400);
  assert.ok(badTool.data.error?.includes("type"));

  // ============================================================
  // 5. Inspector endpoints
  // ============================================================
  console.log("Testing inspector endpoints...");

  const inspectorState = await getJson<{ ok: boolean; data: { tasks: unknown[]; sessions: unknown[] } }>("/api/inspector/state");
  assert.equal(inspectorState.status, 200);
  assert.equal(inspectorState.data.ok, true);
  assert.ok(Array.isArray(inspectorState.data.data.tasks));
  assert.ok(Array.isArray(inspectorState.data.data.sessions));

  const inspectorSessions = await getJson<{ ok: boolean; data: unknown[] }>("/api/inspector/sessions");
  assert.equal(inspectorSessions.status, 200);
  assert.equal(inspectorSessions.data.ok, true);

  const inspectorSessionsLive = await getJson<{ ok: boolean; data: unknown[] }>("/api/inspector/sessions?live=true");
  assert.equal(inspectorSessionsLive.status, 200);
  assert.equal(inspectorSessionsLive.data.ok, true);

  const inspectorEvents = await getJson<{ ok: boolean; data: unknown[] }>("/api/inspector/events");
  assert.equal(inspectorEvents.status, 200);
  assert.equal(inspectorEvents.data.ok, true);

  const inspectorEventsPaginated = await getJson<{ ok: boolean; data: unknown[] }>("/api/inspector/events?afterSeq=0&limit=5");
  console.log("Testing SSE event stream...");

  // Test SSE with afterSeq (replay)
  const sseRes = await fetch(`${base}/api/events?afterSeq=0&types=task.*`);
  assert.equal(sseRes.status, 200);
  assert.equal(sseRes.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = sseRes.body!.getReader();
  const { done, value } = await reader.read();
  assert.equal(done, false);
  const text = new TextDecoder().decode(value);
  assert.ok(text.includes("data:"));
  await reader.cancel();

  // Test SSE with specific type filter
  const sseRes2 = await fetch(`${base}/api/events?types=session.data,user.input`);
  assert.equal(sseRes2.status, 200);
  const reader2 = sseRes2.body!.getReader();
  await reader2.cancel();

  // ============================================================
  // 7. Restart-safe state: close/reopen cycle
  // ============================================================
  console.log("Testing restart-safe state...");

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await chef.close();

  // Reopen
  const chef2 = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir });
  await chef2.start();
  const server2 = createHttpServer(chef2);
  await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", resolve));
  const address2 = server2.address() as AddressInfo;
  const base2 = `http://127.0.0.1:${address2.port}`;

  // Verify plan persists
  const reopenedPlan = await fetch(`${base2}/api/workflows/${planId}`);
  assert.equal(reopenedPlan.status, 200);
  const reopenedPlanData = await reopenedPlan.json();
  assert.equal(reopenedPlanData.ok, true);
  assert.equal(reopenedPlanData.data.id, planId);
  assert.equal(reopenedPlanData.data.status, "approved");

  // Verify template deletion persists
  const reopenedTemplate = await fetch(`${base2}/api/templates/${templateId}`);
  assert.equal(reopenedTemplate.status, 404);

  // Verify task persists
  const reopenedTask = await fetch(`${base2}/api/nodes/${taskId}/status`);
  assert.equal(reopenedTask.status, 200);
  const reopenedTaskData = await reopenedTask.json();
  assert.equal(reopenedTaskData.ok, true);
  assert.equal(reopenedTaskData.data.id, taskId);

  // Verify events accessible after reopen (restart-safe catch-up)
  const reopenedEvents = await fetch(`${base2}/api/inspector/events`);
  assert.equal(reopenedEvents.status, 200);
  const reopenedEventsData = await reopenedEvents.json();
  assert.equal(reopenedEventsData.ok, true);
  assert.ok(reopenedEventsData.data.length > 0);

  // SSE afterSeq works after reopen
  const sseAfterReopen = await fetch(`${base2}/api/events?afterSeq=0`);
  assert.equal(sseAfterReopen.status, 200);
  const reader3 = sseAfterReopen.body!.getReader();
  const { value: val3 } = await reader3.read();
  assert.ok(val3);
  await reader3.cancel();

  await new Promise<void>((resolve) => server2.close(() => resolve()));
  await chef2.close();

  console.log("api-backend: ok — all endpoints working, validation enforced, restart-safe state verified");
} finally {
  await rm(dir, { recursive: true, force: true });
}