import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { summarizeMissionProgressEvent } from "./missionProgress";
import type { HarnessInfo, UiMission, UiRuntimeEvent, UiTask } from "./types";

type ActivitySnapshot = {
  missions: UiMission[];
  tasks: UiTask[];
  events: UiRuntimeEvent[];
};

const EMPTY: ActivitySnapshot = { missions: [], tasks: [], events: [] };

function workerState(task: UiTask): string {
  if (task.status === "running" || task.status === "spawning" || task.status === "assigned") return "Working";
  if (task.status === "completed") return "Done";
  if (task.status === "failed" || task.status === "blocked") return "Needs attention";
  if (task.status === "cancelled") return "Stopped";
  return "Queued";
}

function missionState(mission: UiMission | null): string {
  if (!mission) return "Ready";
  if (mission.status === "completed") return "Done";
  if (mission.status === "failed" || mission.status === "blocked" || mission.status === "waiting_for_approval") return "Needs attention";
  if (mission.status === "cancelled") return "Stopped";
  if (mission.status === "paused") return "Paused";
  return "Working";
}

export function MissionActivityRail() {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>(EMPTY);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);

  const refresh = useCallback(async () => {
    try {
      const state = await api.stateRaw();
      setSnapshot({
        missions: state.missions ?? [],
        tasks: state.tasks,
        events: state.events,
      });
    } catch {
      // The Living Workspace owns the primary error surface. Keep this rail quiet.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    void api.harnesses().then(setHarnesses).catch(() => setHarnesses([]));
  }, []);

  const latestMission = useMemo(
    () => [...snapshot.missions].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
    [snapshot.missions],
  );

  const taskIds = useMemo(() => new Set(latestMission?.taskIds ?? []), [latestMission?.taskIds]);
  const tasksById = useMemo(() => new Map(snapshot.tasks.map((task) => [task.id, task])), [snapshot.tasks]);
  const missionTasks = useMemo(
    () => (latestMission?.taskIds ?? []).map((id) => tasksById.get(id)).filter((task): task is UiTask => Boolean(task)),
    [latestMission?.taskIds, tasksById],
  );
  const harnessNames = useMemo(() => new Map(harnesses.map((harness) => [harness.id, harness.name])), [harnesses]);

  const recentActivity = useMemo(() => {
    const lines: string[] = [];
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
      lines.push(text);
      if (lines.length === 3) break;
    }
    return lines;
  }, [harnessNames, snapshot.events, taskIds, tasksById]);

  if (!latestMission) return null;

  return (
    <aside className="chef-live-activity" aria-label="Live Chef activity">
      <header>
        <div>
          <span className="chef-live-activity__eyebrow">Live activity</span>
          <strong>{missionState(latestMission)}</strong>
        </div>
        <i data-status={latestMission.status} />
      </header>

      <p className="chef-live-activity__goal">{latestMission.goal}</p>

      {missionTasks.length > 0 && (
        <div className="chef-live-activity__workers">
          {missionTasks.slice(0, 4).map((task) => (
            <div key={task.id} className="chef-live-worker" data-status={task.status}>
              <span className="chef-live-worker__mark">✦</span>
              <span className="chef-live-worker__copy">
                <strong>{task.assignedTo ? (harnessNames.get(task.assignedTo) ?? task.assignedTo) : "Chef"}</strong>
                <small>{task.title}</small>
              </span>
              <span className="chef-live-worker__status">{workerState(task)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="chef-live-activity__feed">
        <span>What is happening</span>
        {recentActivity.length > 0 ? recentActivity.map((line) => <p key={line}>{line}</p>) : (
          <p>{latestMission.status === "planning" ? "Chef is deciding who and what this work needs." : "Work is active. Waiting for the next useful update."}</p>
        )}
      </div>
    </aside>
  );
}