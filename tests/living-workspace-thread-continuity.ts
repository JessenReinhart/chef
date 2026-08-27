import { strict as assert } from "node:assert";
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
  workspaceId: "workspace-1",
  title: `Task ${id}`,
  description: "thread continuity fixture",
  status,
  priority: 1,
  dependencies: [],
  createdAt: 1,
  updatedAt: 1,
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
    { id: "helper", label: "Browser", nodeType: "runtime", kind: "tool", config: {}, position: { x: 0, y: 0 }, createdAt: 1, updatedAt: 1 },
    { id: "node-a", taskId: "task-a", label: "Selected worker", nodeType: "runtime", kind: "agent", config: {}, position: { x: 0, y: 0 }, createdAt: 1, updatedAt: 1 },
    { id: "node-b", taskId: "task-b", label: "Other worker", nodeType: "runtime", kind: "agent", config: {}, position: { x: 0, y: 0 }, createdAt: 1, updatedAt: 1 },
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

console.log("living-workspace-thread-continuity: ok — Simple Mode submission, Mission activity, workers, approvals, and results stay in the selected Thread lineage");
