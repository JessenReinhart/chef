import { strict as assert } from "node:assert";
import { Api } from "../web/src/api.ts";
import { projectMissionActivity } from "../web/src/missionActivityProjection.ts";
import {
  scopeStateToThread,
  threadChatPath,
  threadMessagesPath,
  type ThreadScopedState,
} from "../web/src/threadScope.ts";
import type { UiMission, UiTask } from "../web/src/types.ts";

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

const selectedMission = mission("mission-a", "thread-a", "task-a", "active", 100);
const otherMission = mission("mission-b", "thread-b", "task-b", "active", 200);
const state: ThreadScopedState = {
  missions: [selectedMission, otherMission],
  tasks: [task("task-a", "running"), task("task-b", "running")],
  sessions: [],
  approvals: [
    { id: "approval-a", reason: "selected thread", taskId: "task-a", status: "pending" },
    { id: "approval-b", reason: "other thread", taskId: "task-b", status: "pending" },
  ],
  canvasNodes: [
    { id: "helper", workspaceId: "workspace-1", taskId: null, label: "Browser", nodeType: "proxy", kind: "tool", harnessId: null, position: { x: 0, y: 0 }, updatedAt: 1 },
    { id: "node-a", workspaceId: "workspace-1", taskId: "task-a", label: "Selected worker", nodeType: "proxy", kind: "agent", harnessId: "claude-code", position: { x: 0, y: 0 }, updatedAt: 1 },
    { id: "node-b", workspaceId: "workspace-1", taskId: "task-b", label: "Other worker", nodeType: "proxy", kind: "agent", harnessId: "claude-code", position: { x: 0, y: 0 }, updatedAt: 1 },
  ],
  canvasEdges: [],
  events: [],
};

const scoped = scopeStateToThread(state, "thread-a");
assert.deepEqual(scoped.missions?.map((item) => item.id), ["mission-a"], "selected Thread must own the visible Mission history");
assert.deepEqual(scoped.tasks.map((item) => item.id), ["task-a"], "another Thread's worker must not appear in the selected conversation");
assert.deepEqual(scoped.approvals.map((item) => item.id), ["approval-a"], "another Thread's approval must not interrupt the selected conversation");
assert.deepEqual(scoped.canvasNodes.map((item) => item.id), ["helper", "node-a"], "project helpers may remain visible but task-backed nodes must follow selected Thread lineage");

const activity = projectMissionActivity({ missions: scoped.missions ?? [], tasks: scoped.tasks, events: scoped.events }, []);
assert.ok(activity);
assert.equal(activity.mission.id, "mission-a", "Living Workspace activity must stay on the selected Thread even when another Thread has newer active work");
assert.equal(activity.mission.goal, "Goal for thread-a");

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
  const body = url.endsWith("/api/state")
    ? state
    : url.endsWith("/api/threads/thread-a/messages")
      ? []
      : { ok: true, taskIds: [], report: "Work accepted" };
  return new Response(JSON.stringify({ ok: true, data: body }), {
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

  storage.set("chef:view-mode", "power");
  const powerState = await client.stateRaw();
  assert.deepEqual(powerState.missions?.map((item) => item.id), ["mission-a", "mission-b"], "Power Mode must retain project-wide runtime visibility");
} finally {
  globalThis.fetch = originalFetch;
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
}

console.log("living-workspace-thread-continuity: ok — Simple Mode submission, history, Mission activity, workers, approvals, and results stay in the selected Thread lineage");
