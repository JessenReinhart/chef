import type {
  UiAutomation,
  UiCanvasEdge,
  UiCanvasNode,
  UiMission,
  UiRuntimeEvent,
  UiTask,
} from "./types";

export interface ThreadScopedSession {
  id?: string;
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

type EventPayload = Record<string, unknown>;

function missionThreadId(mission: UiMission): string | null {
  const value = mission.metadata?.threadId;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function eventPayload(event: UiRuntimeEvent): EventPayload {
  return event.payload && typeof event.payload === "object" ? event.payload as EventPayload : {};
}

function payloadString(payload: EventPayload, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function payloadStrings(payload: EventPayload, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function eventBelongsToThread(
  event: UiRuntimeEvent,
  missionIds: Set<string>,
  taskIds: Set<string>,
  sessionIds: Set<string>,
): boolean {
  const payload = eventPayload(event);
  if (event.source.type === "mission" && missionIds.has(event.source.id)) return true;
  if (event.source.type === "task" && taskIds.has(event.source.id)) return true;
  if (event.source.type === "session" && sessionIds.has(event.source.id)) return true;
  if (event.correlationId && missionIds.has(event.correlationId)) return true;
  if (event.taskId && taskIds.has(event.taskId)) return true;
  if (event.sessionId && sessionIds.has(event.sessionId)) return true;

  const missionId = payloadString(payload, "missionId");
  if (missionId && missionIds.has(missionId)) return true;
  return payloadStrings(payload, "taskIds").some((taskId) => taskIds.has(taskId));
}

export function scopeStateToThread(state: ThreadScopedState, threadId: string | null): ThreadScopedState {
  if (!threadId) return state;

  const missions = (state.missions ?? []).filter((mission) => missionThreadId(mission) === threadId);
  const missionIds = new Set(missions.map((mission) => mission.id));
  const taskIds = new Set(missions.flatMap((mission) => mission.taskIds));
  const sessions = state.sessions.filter((session) => taskIds.has(session.taskId));
  const sessionIds = new Set(sessions.flatMap((session) => typeof session.id === "string" ? [session.id] : []));
  const canvasNodes = state.canvasNodes.filter((node) => !node.taskId || taskIds.has(node.taskId));
  const canvasNodeIds = new Set(canvasNodes.map((node) => node.id));

  return {
    ...state,
    missions,
    tasks: state.tasks.filter((task) => taskIds.has(task.id)),
    sessions,
    approvals: state.approvals.filter((approval) => taskIds.has(approval.taskId)),
    canvasNodes,
    canvasEdges: state.canvasEdges.filter((edge) => canvasNodeIds.has(edge.source) && canvasNodeIds.has(edge.target)),
    events: state.events.filter((event) => eventBelongsToThread(event, missionIds, taskIds, sessionIds)),
  };
}

export function threadChatPath(threadId: string | null): string {
  return threadId ? `/api/threads/${encodeURIComponent(threadId)}/chat` : "/api/chat";
}

export function threadMessagesPath(threadId: string | null): string {
  return threadId ? `/api/threads/${encodeURIComponent(threadId)}/messages` : "/api/chat/messages";
}
