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

  const taskIds = new Set(mission.taskIds);
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
  for (const event of [...snapshot.events].sort((a, b) => b.seq - a.seq)) {
    if (!event.taskId || !taskIds.has(event.taskId)) continue;
    const task = tasksById.get(event.taskId);
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
