import { summarizeMissionProgressEvent } from "./missionProgress.ts";
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

function payloadStrings(payload: EventPayload, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function directlyBelongsToMission(event: UiRuntimeEvent, missionId: string): boolean {
  const payload = eventPayload(event);
  return (event.source.type === "mission" && event.source.id === missionId)
    || event.correlationId === missionId
    || payloadString(payload, "missionId") === missionId;
}

function scopedMissionEvents(events: UiRuntimeEvent[], mission: UiMission): UiRuntimeEvent[] {
  const ownedTaskIds = new Set(mission.taskIds);

  for (const event of events) {
    if (!directlyBelongsToMission(event, mission.id)) continue;
    for (const taskId of payloadStrings(eventPayload(event), "taskIds")) ownedTaskIds.add(taskId);
  }

  return events
    .filter((event) => {
      if (directlyBelongsToMission(event, mission.id)) return true;
      if (event.taskId && ownedTaskIds.has(event.taskId)) return true;
      return payloadStrings(eventPayload(event), "taskIds").some((taskId) => ownedTaskIds.has(taskId));
    })
    .sort((a, b) => b.seq - a.seq);
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

export function projectMissionActivity(
  snapshot: MissionActivitySnapshot,
  harnesses: HarnessInfo[],
): MissionActivityProjection | null {
  const mission = [...snapshot.missions].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  if (!mission) return null;

  const tasksById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const harnessNames = new Map(harnesses.map((harness) => [harness.id, harness.name]));
  const workers = mission.taskIds
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
  for (const event of scopedMissionEvents(snapshot.events, mission)) {
    const task = event.taskId ? tasksById.get(event.taskId) : undefined;
    const worker = task?.assignedTo ? (harnessNames.get(task.assignedTo) ?? task.assignedTo) : "Chef";
    let text: string | null = null;

    if (event.type === "session.data") {
      text = summarizeMissionProgressEvent(event)?.text ?? "A worker is actively producing output.";
    } else if (event.type === "task.running") {
      text = `${worker} started ${task?.title ?? "the task"}.`;
    } else if (event.type === "task.completed") {
      text = `${worker} finished ${task?.title ?? "the task"}.`;
    } else if (event.type === "task.failed") {
      text = `${worker} needs attention.`;
    } else {
      text = summarizeMissionProgressEvent(event)?.text ?? null;
    }

    if (!text || seen.has(text)) continue;
    seen.add(text);
    feed.push(text);
    if (feed.length === 3) break;
  }

  return {
    mission,
    missionState: missionActivityState(mission),
    workers,
    feed,
    fallback: mission.status === "planning"
      ? "Chef is deciding who and what this work needs."
      : "Work is active. Waiting for the next useful update.",
  };
}
