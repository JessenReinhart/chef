import { strict as assert } from "node:assert";
import { Api } from "../web/src/api.ts";
import { projectMissionActivity } from "../web/src/missionActivityProjection.ts";
import {
  scopeStateToThread,
  threadChatPath,
  threadMessagesPath,
  type ThreadScopedState,
} from "../web/src/threadScope.ts";
import type { UiMission, UiRuntimeEvent, UiTask } from "../web/src/types.ts";

const mission = (id: string, threadId: string, taskId: string, status: UiMission["status"], createdAt: number): UiMission => ({
  id,
  goal: `Goal for ${threadId}`,
  status,
  taskIds: [taskId],
  metadata: { threadId },
  createdAt,
  updatedAt: createdAt,
});

const task = (id: string, status: UiTask["status"]): UiTask => ({
  id,
  title: `Task ${id}`,
  description: "thread continuity fixture",
  status,
});

const runtimeEvent = (
  id: string,
  seq: number,
  source: UiRuntimeEvent["source"],
  type: string,
  overrides: Partial<UiRuntimeEvent> = {},
): UiRuntimeEvent => ({
  id,
  seq,
  timestamp: seq * 100,
  source,
  type,
  payload: {},
  ...overrides,
});

const selectedMission = mission("mission-a", "thread-a", "task-a", "active", 100);
const otherMission = mission("mission-b", "thread-b", "task-b", "active", 200);
const state: ThreadScopedState = {
  missions: [selectedMission, otherMission],
  tasks: [task("task-a", "running"), task("task-b", "running")],
  sessions: [
    { id: "session-a", taskId: "task-a", status: "running", pid: 101 },
    { id: "session-b", taskId: "task-b", status: "running", pid: 202 },
  ],
  approvals: [
    { id: "approval-a", reason: "selected thread", taskId: "task-a", status: "pending" },
    { id: "approval-b", reason: "other thread", taskId: "task-b", status: "pending" },
  ],
  canvasNodes: [
    { id: "helper", workspaceId: "workspace-1", taskId: null, label: "Browser", nodeType: "proxy", kind: "tool", harnessId: null, position: { x: 0, y: 0 }, updatedAt: 1 },
    { id: "node-a", workspaceId: "workspace-1", taskId: "task-a", label: "Selected worker", nodeType: "proxy", kind: "agent", harnessId: "claude-code", position: { x: 0, y: 0 }, updatedAt: 1 },
    { id: "node-b", workspaceId: "workspace-1", taskId: "task-b", label: "Other worker", nodeType: "proxy", kind: "agent", harnessId: "claude-code", position: { x: 0, y: 0 }, updatedAt: 1 },
  ],
  canvasEdges: [
    { id: "edge-a", workspaceId: "workspace-1", source: "helper", target: "node-a", sourceHandle: null, targetHandle: null, updatedAt: 1 },
    { id: "edge-b", workspaceId: "workspace-1", source: "helper", target: "node-b", sourceHandle: null, targetHandle: null, updatedAt: 1 },
  ],
  events: [
    runtimeEvent("mission-a-plan", 1, { type: "orchestrator", id: "orchestrator" }, "orchestrator.plan.started", { correlationId: "mission-a", payload: { missionId: "mission-a" } }),
    runtimeEvent("task-a-running", 2, { type: "runtime", id: "workspace-1" }, "task.running", { payload: { taskId: "task-a" } }),
    runtimeEvent("session-a-data", 3, { type: "runtime", id: "workspace-1" }, "session.data", { payload: { sessionId: "session-a" } }),
    runtimeEvent("mission-b-plan", 4, { type: "orchestrator", id: "orchestrator" }, "orchestrator.plan.started", { correlationId: "mission-b", payload: { missionId: "mission-b" } }),
    runtimeEvent("task-b-running", 5, { type: "runtime", id: "workspace-1" }, "task.running", { payload: { taskId: "task-b" } }),
    runtimeEvent("session-b-data", 6, { type: "runtime", id: "workspace-1" }, "session.data", { payload: { sessionId: "session-b" } }),
    runtimeEvent("project-only", 7, { type: "runtime", id: "workspace-1" }, "runtime.note"),
  ],
};

const scoped = scopeStateToThread(state, "thread-a");
assert.deepEqual(scoped.missions?.map((item) => item.id), ["mission-a"], "selected Thread must own the visible Mission history");
assert.deepEqual(scoped.tasks.map((item) => item.id), ["task-a"], "another Thread's task must not appear in the selected conversation");
assert.deepEqual(scoped.sessions.map((item) => item.id), ["session-a"], "another Thread's worker Session must not appear in the selected conversation");
assert.deepEqual(scoped.approvals.map((item) => item.id), ["approval-a"], "another Thread's approval must not interrupt the selected conversation");
assert.deepEqual(scoped.canvasNodes.map((item) => item.id), ["helper", "node-a"], "project helpers may remain visible but task-backed nodes must follow selected Thread lineage");
assert.deepEqual(scoped.canvasEdges.map((item) => item.id), ["edge-a"], "Simple Mode graph edges must not reference nodes owned by another Thread");
assert.deepEqual(
  scoped.events.map((item) => item.id),
  ["mission-a-plan", "task-a-running", "session-a-data"],
  "Simple Mode runtime evidence must include selected Mission/Task/Session lineage even when task/session ids only exist inside event payloads",
);
assert.equal(scoped.events.find((item) => item.id === "session-a-data")?.taskId, "task-a", "payload-only Session lineage must be enriched with its selected-Thread Task before activity projection");

const activity = projectMissionActivity({ missions: scoped.missions ?? [], tasks: scoped.tasks, events: scoped.events }, []);
assert.ok(activity);
assert.equal(activity.mission.id, "mission-a", "Living Workspace activity must stay on the selected Thread even when another Thread has newer active work");
assert.equal(activity.mission.goal, "Goal for thread-a");
assert.ok(activity.feed.some((item) => item.includes("actively producing output")), "selected Thread Session activity must remain visible after runtime-event scoping");

const laggingState: ThreadScopedState = {
  ...state,
  missions: [
    { ...selectedMission, taskIds: [] },
    { ...otherMission, taskIds: [] },
  ],
  events: [
    runtimeEvent("mission-a-plan", 1, { type: "orchestrator", id: "orchestrator" }, "orchestrator.plan.proposed", {
      correlationId: "mission-a",
      payload: { missionId: "mission-a", taskId: "task-a", routingMode: "single-worker" },
    }),
    runtimeEvent("task-a-running", 2, { type: "runtime", id: "workspace-1" }, "task.running", { payload: { taskId: "task-a" } }),
    runtimeEvent("session-a-data", 3, { type: "runtime", id: "workspace-1" }, "session.data", { payload: { sessionId: "session-a" } }),
    runtimeEvent("mission-b-plan", 4, { type: "orchestrator", id: "orchestrator" }, "orchestrator.plan.proposed", {
      correlationId: "mission-b",
      payload: { missionId: "mission-b", taskId: "task-b", routingMode: "single-worker" },
    }),
    runtimeEvent("task-b-running", 5, { type: "runtime", id: "workspace-1" }, "task.running", { payload: { taskId: "task-b" } }),
    runtimeEvent("session-b-data", 6, { type: "runtime", id: "workspace-1" }, "session.data", { payload: { sessionId: "session-b" } }),
  ],
};

const laggingScoped = scopeStateToThread(laggingState, "thread-a");
assert.deepEqual(laggingScoped.missions?.[0]?.taskIds, [], "fixture must represent a Mission snapshot that has not caught up with durable plan lineage yet");
assert.deepEqual(laggingScoped.tasks.map((item) => item.id), ["task-a"], "a Mission-correlated singular payload.taskId must recover selected-Thread Task ownership while the Mission snapshot lags");
assert.deepEqual(laggingScoped.sessions.map((item) => item.id), ["session-a"], "a freshly started worker Session must remain visible when Task ownership is only durable in the plan event");
assert.deepEqual(laggingScoped.canvasNodes.map((item) => item.id), ["helper", "node-a"], "worker canvas state must stay visible through the same recovered Task lineage");
assert.deepEqual(
  laggingScoped.events.map((item) => item.id),
  ["mission-a-plan", "task-a-running", "session-a-data"],
  "payload-only recovered Task and Session lineage must preserve later worker activity while still excluding another Thread",
);
const laggingActivity = projectMissionActivity({ missions: laggingScoped.missions ?? [], tasks: laggingScoped.tasks, events: laggingScoped.events }, []);
assert.ok(laggingActivity?.feed.some((item) => item.includes("one worker")), "pre-worker routing feedback must remain visible while the Mission task list catches up");
assert.ok(laggingActivity?.feed.some((item) => item.includes("actively producing output")), "worker activity must remain visible after payload-based ownership recovery");

assert.equal(threadChatPath("thread-a"), "/api/threads/thread-a/chat", "Simple Mode submissions must use the selected Thread chat boundary");
assert.equal(threadMessagesPath("thread-a"), "/api/threads/thread-a/messages", "Simple Mode assistant history must come from the selected Thread");
assert.equal(threadChatPath("thread/a b"), "/api/threads/thread%2Fa%20b/chat", "Thread ids must be encoded before entering a URL path");
assert.equal(threadChatPath(null), "/api/chat", "legacy project chat remains available when no Thread has been selected");
assert.equal(scopeStateToThread(state, null), state, "Power/legacy project-level views must keep the full runtime state when no Thread scope is requested");

const originalFetch = globalThis.fetch;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const storage = new Map<string, string>([
  ["chef:view-mode", "simple"],
  ["chef:selected-thread", "thread-a"],
]);
const requested: string[] = [];

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

globalThis.fetch = async (input) => {
  const url = String(input);
  requested.push(url);
  if (url.endsWith("/api/state")) {
    return new Response(JSON.stringify(state), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const data = url.endsWith("/api/threads/thread-a/messages")
    ? []
    : { ok: true, taskIds: [], report: "Work accepted" };
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

try {
  const client = new Api("http://chef.test");
  const chat = await client.chat("Create a todo app");
  assert.equal(chat.ok, true);
  assert.ok(requested.includes("http://chef.test/api/threads/thread-a/chat"), "the actual Simple Mode API client must submit to the selected Thread, not project-level /api/chat");

  await client.chatMessages();
  assert.ok(requested.includes("http://chef.test/api/threads/thread-a/messages"), "the actual Simple Mode API client must read assistant history from the selected Thread");

  const scopedState = await client.stateRaw();
  assert.deepEqual(scopedState.missions?.map((item) => item.id), ["mission-a"], "the API state consumed by Living Workspace must exclude another Thread's newer Mission");
  assert.deepEqual(scopedState.sessions.map((item) => item.id), ["session-a"], "the API state consumed by Living Workspace must exclude another Thread's worker Session");
  assert.deepEqual(scopedState.events.map((item) => item.id), ["mission-a-plan", "task-a-running", "session-a-data"], "the actual Simple Mode API state must retain payload-linked selected-Thread runtime activity and exclude another Thread");

  storage.set("chef:view-mode", "power");
  const powerState = await client.stateRaw();
  assert.deepEqual(powerState.missions?.map((item) => item.id), ["mission-a", "mission-b"], "Power Mode must retain project-wide runtime visibility");
  assert.deepEqual(powerState.sessions.map((item) => item.id), ["session-a", "session-b"], "Power Mode must retain project-wide worker Session visibility");
  assert.deepEqual(powerState.events.map((item) => item.id), state.events.map((item) => item.id), "Power Mode must retain the complete project runtime event stream");
} finally {
  globalThis.fetch = originalFetch;
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
}

console.log("living-workspace-thread-continuity: ok — Simple Mode submission, history, Mission/Task/Session runtime evidence, approvals, graph state, and results stay in the selected Thread lineage");