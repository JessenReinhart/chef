import { deriveMissionHeartbeat, summarizeMissionProgressEvent } from "./missionProgress.ts";
import type { HarnessInfo, UiMission, UiRuntimeEvent, UiTask } from "./types.ts";

export interface MissionActivitySnapshot {
  missions: UiMission[];
  tasks: UiTask[];
  events: UiRuntimeEvent[];
}

export interface MissionActivityWorker {
  id: string;
  name: string;
  title: string;
  state: string;
  status: UiTask["status"];
}

export interface MissionActivityProjection {
  mission: UiMission;
  taskIds: string[];
  missionState: string;
  workers: MissionActivityWorker[];
  feed: string[];
  fallback: string;
}

type EventPayload = Record<string, unknown>;

function eventPayload(event: UiRuntimeEvent): EventPayload {
  return event.payload && typeof event.payload === "object" ? event.payload as EventPayload : {};
}

function payloadString(payload: EventPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function payloadNumber(payload: EventPayload, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function payloadStrings(payload: EventPayload, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function simpleModeActivityText(raw: string): string | undefined {
  const meaningfulLines = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (meaningfulLines.length === 0) return undefined;

  const firstLine = meaningfulLines[0]!;
  const text = firstLine.endsWith(":") && meaningfulLines[1]
    ? `${firstLine} ${meaningfulLines[1]}`
    : firstLine;
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

function simpleModeFailureReason(payload: EventPayload): string | undefined {
  const raw = payloadString(payload, "error") ?? payloadString(payload, "reason");
  return raw ? simpleModeActivityText(raw) : undefined;
}

function directlyBelongsToMission(event: UiRuntimeEvent, missionId: string): boolean {
  const payload = eventPayload(event);
  return (event.source.type === "mission" && event.source.id === missionId)
    || event.correlationId === missionId
    || payloadString(payload, "missionId") === missionId;
}

function scopeMissionActivity(events: UiRuntimeEvent[], mission: UiMission): {
  ownedTaskIds: Set<string>;
  events: UiRuntimeEvent[];
} {
  const ownedTaskIds = new Set(mission.taskIds);

  for (const event of events) {
    if (!directlyBelongsToMission(event, mission.id)) continue;
    const payload = eventPayload(event);
    const taskId = payloadString(payload, "taskId");
    if (taskId) ownedTaskIds.add(taskId);
    for (const payloadTaskId of payloadStrings(payload, "taskIds")) ownedTaskIds.add(payloadTaskId);
  }

  return {
    ownedTaskIds,
    events: events
      .filter((event) => {
        if (directlyBelongsToMission(event, mission.id)) return true;
        if (event.taskId && ownedTaskIds.has(event.taskId)) return true;
        const payload = eventPayload(event);
        const taskId = payloadString(payload, "taskId");
        if (taskId && ownedTaskIds.has(taskId)) return true;
        return payloadStrings(payload, "taskIds").some((payloadTaskId) => ownedTaskIds.has(payloadTaskId));
      })
      .sort((a, b) => b.seq - a.seq),
  };
}

function isMissionOngoing(mission: UiMission): boolean {
  return mission.status !== "completed" && mission.status !== "cancelled" && mission.status !== "failed";
}

export function selectLivingWorkspaceMission(missions: UiMission[]): UiMission | null {
  const newestFirst = [...missions].sort((a, b) => b.createdAt - a.createdAt);
  return newestFirst.find(isMissionOngoing) ?? newestFirst[0] ?? null;
}

export function workerActivityState(task: UiTask): string {
  if (task.status === "running" || task.status === "spawning" || task.status === "assigned") return "Working";
  if (task.status === "completed") return "Done";
  if (task.status === "failed" || task.status === "blocked") return "Needs attention";
  if (task.status === "cancelled") return "Stopped";
  return "Queued";
}

export function missionActivityState(mission: UiMission | null): string {
  if (!mission) return "Ready";
  if (mission.status === "completed") return "Done";
  if (mission.status === "failed" || mission.status === "blocked" || mission.status === "waiting_for_approval") return "Needs attention";
  if (mission.status === "cancelled") return "Stopped";
  if (mission.status === "paused") return "Paused";
  return "Working";
}

function missionCanHeartbeat(mission: UiMission): boolean {
  return mission.status === "planning" || mission.status === "active" || mission.status === "verifying";
}

function missionActivityFallback(mission: UiMission): string {
  if (mission.status === "planning") return "Chef is deciding who and what this work needs.";
  if (mission.status === "completed") return "Work is complete. Results are available in this workspace.";
  if (mission.status === "waiting_for_approval") return "Chef needs your approval before work can continue.";
  if (mission.status === "blocked") return "Work is blocked. Chef is waiting for a dependency or recovery action before it can continue.";
  if (mission.status === "failed") return "Work failed before a useful recovery update was available.";
  if (mission.status === "cancelled") return "Work was stopped. Start a new request when you are ready.";
  if (mission.status === "paused") return "Work is paused. Resume it when you are ready.";
  if (mission.status === "verifying") return "Chef is verifying the completed work.";
  return "Work is active. Waiting for the next useful update.";
}

export function projectMissionActivity(
  snapshot: MissionActivitySnapshot,
  harnesses: HarnessInfo[],
  now = Date.now(),
): MissionActivityProjection | null {
  const mission = selectLivingWorkspaceMission(snapshot.missions);
  if (!mission) return null;

  const tasksById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const harnessNames = new Map(harnesses.map((harness) => [harness.id, harness.name]));
  const scoped = scopeMissionActivity(snapshot.events, mission);
  const workers = [...scoped.ownedTaskIds]
    .map((id) => tasksById.get(id))
    .filter((task): task is UiTask => Boolean(task))
    .slice(0, 4)
    .map((task) => ({
      id: task.id,
      name: task.assignedTo ? (harnessNames.get(task.assignedTo) ?? task.assignedTo) : "Chef",
      title: task.title,
      state: workerActivityState(task),
      status: task.status,
    }));

  const feed: string[] = [];
  const seen = new Set<string>();

  // Prefer concrete recent progress. A heartbeat is useful only when there are
  // not already enough meaningful runtime updates to explain what is happening.
  for (const event of scoped.events) {
    const task = event.taskId ? tasksById.get(event.taskId) : undefined;
    const worker = task?.assignedTo ? (harnessNames.get(task.assignedTo) ?? task.assignedTo) : "Chef";
    const payload = eventPayload(event);
    let text: string | null = null;

    if (event.type === "session.data") {
      text = summarizeMissionProgressEvent(event)?.text ?? "A worker is actively producing output.";
    } else if (event.type === "task.running") {
      const retryCount = payloadNumber(payload, "retryCount") ?? 0;
      text = retryCount > 0
        ? `${worker} is retrying ${task?.title ?? "the task"} (retry ${retryCount}).`
        : `${worker} started ${task?.title ?? "the task"}.`;
    } else if (event.type === "task.completed") {
      text = `${worker} finished ${task?.title ?? "the task"}.`;
    } else if (event.type === "task.failed") {
      const reason = simpleModeFailureReason(payload);
      text = reason
        ? `${worker} failed ${task?.title ?? "the task"}: ${reason}`
        : `${worker} failed ${task?.title ?? "the task"} and needs recovery.`;
    } else {
      text = summarizeMissionProgressEvent(event)?.text ?? null;
    }

    const safeText = text ? simpleModeActivityText(text) : undefined;
    if (!safeText || seen.has(safeText)) continue;
    seen.add(safeText);
    feed.push(safeText);
    if (feed.length === 3) break;
  }

  if (feed.length < 3 && missionCanHeartbeat(mission)) {
    const heartbeat = deriveMissionHeartbeat(snapshot.events, mission.id, scoped.ownedTaskIds, now);
    if (heartbeat && !seen.has(heartbeat.text)) feed.unshift(heartbeat.text);
  }

  return {
    mission,
    taskIds: [...scoped.ownedTaskIds],
    missionState: missionActivityState(mission),
    workers,
    feed,
    fallback: missionActivityFallback(mission),
  };
}
