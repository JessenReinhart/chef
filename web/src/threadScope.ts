import type {
  UiAutomation,
  UiCanvasEdge,
  UiCanvasNode,
  UiMission,
  UiRuntimeEvent,
  UiTask,
} from "./types";

export interface ThreadScopedSession {
  taskId: string;
  [key: string]: unknown;
}

export interface ThreadScopedState {
  tasks: UiTask[];
  sessions: ThreadScopedSession[];
  approvals: Array<{ id: string; reason: string; taskId: string; status: string }>;
  canvasNodes: UiCanvasNode[];
  canvasEdges: UiCanvasEdge[];
  missions?: UiMission[];
  automations?: UiAutomation[];
  events: UiRuntimeEvent[];
}

function missionThreadId(mission: UiMission): string | null {
  const value = mission.metadata?.threadId;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function scopeStateToThread(state: ThreadScopedState, threadId: string | null): ThreadScopedState {
  if (!threadId) return state;

  const missions = (state.missions ?? []).filter((mission) => missionThreadId(mission) === threadId);
  const taskIds = new Set(missions.flatMap((mission) => mission.taskIds));

  return {
    ...state,
    missions,
    tasks: state.tasks.filter((task) => taskIds.has(task.id)),
    sessions: state.sessions.filter((session) => taskIds.has(session.taskId)),
    approvals: state.approvals.filter((approval) => taskIds.has(approval.taskId)),
    canvasNodes: state.canvasNodes.filter((node) => !node.taskId || taskIds.has(node.taskId)),
  };
}

export function threadChatPath(threadId: string | null): string {
  return threadId ? `/api/threads/${encodeURIComponent(threadId)}/chat` : "/api/chat";
}

export function threadMessagesPath(threadId: string | null): string {
  return threadId ? `/api/threads/${encodeURIComponent(threadId)}/messages` : "/api/chat/messages";
}
