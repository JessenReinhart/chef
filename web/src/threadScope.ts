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

function eventNamesMission(event: UiRuntimeEvent, missionIds: Set<string>): boolean {
  if (event.source.type === "mission" && missionIds.has(event.source.id)) return true;
  if (event.correlationId && missionIds.has(event.correlationId)) return true;
  const missionId = payloadString(eventPayload(event), "missionId");
  return Boolean(missionId && missionIds.has(missionId));
}

function recoverMissionTaskIds(
  events: UiRuntimeEvent[],
  missionIds: Set<string>,
  taskIds: Set<string>,
): void {
  for (const event of events) {
    if (!eventNamesMission(event, missionIds)) continue;
    const payload = eventPayload(event);
    if (event.taskId) taskIds.add(event.taskId);
    const payloadTaskId = payloadString(payload, "taskId");
    if (payloadTaskId) taskIds.add(payloadTaskId);
    for (const taskId of payloadStrings(payload, "taskIds")) taskIds.add(taskId);
  }
}

function eventBelongsToThread(
  event: UiRuntimeEvent,
  missionIds: Set<string>,
  taskIds: Set<string>,
  sessionIds: Set<string>,
): boolean {
  const payload = eventPayload(event);
  if (eventNamesMission(event, missionIds)) return true;
  if (event.source.type === "task" && taskIds.has(event.source.id)) return true;
  if (event.source.type === "session" && sessionIds.has(event.source.id)) return true;
  if (event.taskId && taskIds.has(event.taskId)) return true;
  if (event.sessionId && sessionIds.has(event.sessionId)) return true;
  const payloadTaskId = payloadString(payload, "taskId");
  if (payloadTaskId && taskIds.has(payloadTaskId)) return true;
  const payloadSessionId = payloadString(payload, "sessionId");
  if (payloadSessionId && sessionIds.has(payloadSessionId)) return true;
  return payloadStrings(payload, "taskIds").some((taskId) => taskIds.has(taskId));
}

function sessionIdForEvent(event: UiRuntimeEvent): string | null {
  if (event.sessionId) return event.sessionId;
  if (event.source.type === "session") return event.source.id;
  return payloadString(eventPayload(event), "sessionId");
}

function preserveSessionTaskLineage(
  event: UiRuntimeEvent,
  sessionTaskIds: Map<string, string>,
): UiRuntimeEvent {
  if (event.taskId) return event;
  const sessionId = sessionIdForEvent(event);
  const taskId = sessionId ? sessionTaskIds.get(sessionId) : undefined;
  return taskId ? { ...event, taskId } : event;
}

export function scopeStateToThread(state: ThreadScopedState, threadId: string | null): ThreadScopedState {
  if (!threadId) return state;

  const missions = (state.missions ?? []).filter((mission) => missionThreadId(mission) === threadId);
  const missionIds = new Set(missions.map((mission) => mission.id));
  const taskIds = new Set(missions.flatMap((mission) => mission.taskIds));

  // Plan/runtime events can durably name a Mission's Tasks before the Mission
  // snapshot catches up. Keep that lineage so Simple Mode does not briefly
  // lose workers and activity during the pre-worker/startup boundary.
  recoverMissionTaskIds(state.events, missionIds, taskIds);

  const sessions = state.sessions.filter((session) => taskIds.has(session.taskId));
  const sessionTaskIds = new Map(
    sessions.flatMap((session) => typeof session.id === "string" ? [[session.id, session.taskId] as const] : []),
  );
  const sessionIds = new Set(sessionTaskIds.keys());
  const canvasNodes = state.canvasNodes.filter((node) => !node.taskId || taskIds.has(node.taskId));
  const canvasNodeIds = new Set(canvasNodes.map((node) => node.id));
  const events = state.events
    .filter((event) => eventBelongsToThread(event, missionIds, taskIds, sessionIds))
    .map((event) => preserveSessionTaskLineage(event, sessionTaskIds));

  return {
    ...state,
    missions,
    tasks: state.tasks.filter((task) => taskIds.has(task.id)),
    sessions,
    approvals: state.approvals.filter((approval) => taskIds.has(approval.taskId)),
    canvasNodes,
    canvasEdges: state.canvasEdges.filter((edge) => canvasNodeIds.has(edge.source) && canvasNodeIds.has(edge.target)),
    events,
  };
}

export function threadChatPath(threadId: string | null): string {
  return threadId ? `/api/threads/${encodeURIComponent(threadId)}/chat` : "/api/chat";
}

export function threadMessagesPath(threadId: string | null): string {
  return threadId ? `/api/threads/${encodeURIComponent(threadId)}/messages` : "/api/chat/messages";
}
