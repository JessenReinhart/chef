import type { UiTask } from "./types";

export interface MissionTaskVisibility {
  visible: UiTask[];
  earlier: UiTask[];
}

function visibilityPriority(status: UiTask["status"]): number {
  if (status === "failed" || status === "blocked") return 0;
  if (status === "running" || status === "assigned" || status === "spawning") return 1;
  if (status === "pending") return 2;
  if (status === "cancelled") return 3;
  return 4;
}

export function partitionMissionTasksForSimpleMode(
  tasks: UiTask[],
  visibleLimit = 6,
): MissionTaskVisibility {
  const limit = Math.max(0, Math.floor(visibleLimit));
  if (tasks.length <= limit) return { visible: tasks, earlier: [] };
  if (limit === 0) return { visible: [], earlier: tasks };

  const ranked = tasks
    .map((task, index) => ({ index, priority: visibilityPriority(task.status) }))
    .sort((a, b) => a.priority - b.priority || b.index - a.index)
    .slice(0, limit);
  const visibleIndexes = new Set(ranked.map(({ index }) => index));

  return {
    visible: tasks.filter((_, index) => visibleIndexes.has(index)),
    earlier: tasks.filter((_, index) => !visibleIndexes.has(index)),
  };
}
