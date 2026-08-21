import { useMemo } from "react";
import type { UiMission, UiTask, ViewMode } from "./types";

type ApprovalSummary = {
  id: string;
  taskId: string;
  reason: string;
};

type Props = {
  mission: UiMission;
  tasks: UiTask[];
  approvals: ApprovalSummary[];
  mode: ViewMode;
  redirectGoal: string;
  onRedirectGoalChange: (value: string) => void;
  onAction: (action: "pause" | "resume" | "cancel") => void;
  onRedirect: () => void;
};

const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed"]);

function statusLabel(status: UiMission["status"]): string {
  const labels: Record<UiMission["status"], string> = {
    planning: "Planning",
    active: "Active",
    paused: "Paused",
    waiting_for_approval: "Needs approval",
    blocked: "Blocked",
    verifying: "Verifying",
    completed: "Completed",
    cancelled: "Cancelled",
    failed: "Needs attention",
  };
  return labels[status];
}

function statusTone(status: UiMission["status"]): string {
  switch (status) {
    case "active":
    case "planning":
    case "verifying":
      return "border-cyan-500/35 bg-cyan-500/10 text-cyan-300";
    case "waiting_for_approval":
    case "blocked":
      return "border-amber-500/35 bg-amber-500/10 text-amber-300";
    case "completed":
      return "border-green-500/35 bg-green-500/10 text-green-300";
    case "failed":
    case "cancelled":
      return "border-red-500/35 bg-red-500/10 text-red-300";
    default:
      return "border-[#30363d] bg-[#161b22] text-[#c9d1d9]";
  }
}

function taskStatusLabel(status: UiTask["status"]): string {
  const labels: Record<UiTask["status"], string> = {
    pending: "Queued",
    assigned: "Assigned",
    spawning: "Starting",
    running: "Working",
    completed: "Done",
    failed: "Failed",
    blocked: "Blocked",
    cancelled: "Cancelled",
  };
  return labels[status];
}

export function MissionPanel({
  mission,
  tasks,
  approvals,
  mode,
  redirectGoal,
  onRedirectGoalChange,
  onAction,
  onRedirect,
}: Props) {
  const missionTasks = useMemo(() => {
    const membership = new Set(mission.taskIds);
    return tasks.filter((task) => membership.has(task.id));
  }, [mission.taskIds, tasks]);

  const missionApprovals = useMemo(() => {
    const membership = new Set(mission.taskIds);
    return approvals.filter((approval) => membership.has(approval.taskId));
  }, [approvals, mission.taskIds]);

  const completedCount = missionTasks.filter((task) => task.status === "completed").length;
  const activeCount = missionTasks.filter((task) => ["assigned", "spawning", "running"].includes(task.status)).length;
  const blockedTasks = missionTasks.filter((task) => task.status === "blocked" || task.status === "failed");
  const totalTaskCount = mission.taskIds.length;
  const progress = totalTaskCount > 0 ? Math.round((completedCount / totalTaskCount) * 100) : 0;
  const owners = Array.from(new Set(missionTasks.map((task) => task.assignedTo).filter((owner): owner is string => Boolean(owner))));
  const canControl = !TERMINAL_STATUSES.has(mission.status);

  return (
    <section className="border-b border-[#21262d] bg-[#0d1117] px-4 py-4" aria-label="Mission overview">
      <div className="mx-auto grid max-w-[1480px] gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <div className="min-w-0 rounded-xl border border-[#30363d] bg-[#010409]/55 p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6e7681]">Mission</span>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusTone(mission.status)}`}>{statusLabel(mission.status)}</span>
              </div>
              <h2 className="max-w-4xl text-sm font-semibold leading-5 text-[#f0f6fc]">{mission.goal}</h2>
              <p className="mt-1 text-[11px] text-[#6e7681]">
                Updated {new Date(mission.updatedAt).toLocaleString()}
                {mode === "power" ? ` · mission:${mission.id.slice(0, 8)}` : ""}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {mission.status === "paused" ? (
                <button onClick={() => onAction("resume")} className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-[11px] text-cyan-300 hover:bg-cyan-500/15">Resume</button>
              ) : canControl ? (
                <button onClick={() => onAction("pause")} className="rounded-md border border-[#30363d] bg-[#161b22] px-3 py-1.5 text-[11px] text-[#c9d1d9] hover:border-cyan-500/40">Pause</button>
              ) : null}
              {canControl && (
                <button onClick={() => onAction("cancel")} className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300 hover:bg-red-500/15">Cancel</button>
              )}
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            <Metric label="Progress" value={`${progress}%`} detail={`${completedCount}/${totalTaskCount} complete`} />
            <Metric label="Working" value={String(activeCount)} detail="active workers" />
            <Metric label="Attention" value={String(blockedTasks.length + missionApprovals.length)} detail={`${blockedTasks.length} blocked · ${missionApprovals.length} approvals`} />
            <Metric label="Team" value={String(owners.length)} detail={owners.length ? owners.slice(0, 2).join(", ") : "unassigned"} />
          </div>

          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#21262d]" aria-label={`Mission progress ${progress}%`}>
            <div className="h-full rounded-full bg-cyan-400 transition-[width] duration-300" style={{ width: `${progress}%` }} />
          </div>

          {!TERMINAL_STATUSES.has(mission.status) && (
            <form className="mt-4 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); onRedirect(); }}>
              <input
                value={redirectGoal}
                onChange={(event) => onRedirectGoalChange(event.target.value)}
                placeholder="Redirect or refine this Mission…"
                className="min-w-[240px] flex-1 rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2 text-[11px] text-[#e6edf3] outline-none placeholder:text-[#484f58] focus:border-cyan-500/50"
              />
              <button type="submit" disabled={!redirectGoal.trim()} className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-[11px] text-cyan-300 disabled:cursor-not-allowed disabled:opacity-40">Redirect</button>
            </form>
          )}
        </div>

        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-1">
          <div className="rounded-xl border border-[#30363d] bg-[#010409]/55 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8b949e]">Worker roster</h3>
              <span className="text-[10px] text-[#484f58]">{missionTasks.length} tasks</span>
            </div>
            <div className="max-h-28 space-y-1 overflow-y-auto pr-1">
              {missionTasks.length > 0 ? missionTasks.map((task) => (
                <div key={task.id} className="flex items-center justify-between gap-3 rounded-md bg-[#161b22]/75 px-2 py-1.5">
                  <div className="min-w-0">
                    <div className="truncate text-[11px] text-[#c9d1d9]">{task.title}</div>
                    <div className="truncate text-[9px] text-[#6e7681]">{task.assignedTo ?? "Unassigned"}</div>
                  </div>
                  <span className="shrink-0 text-[9px] text-[#8b949e]">{taskStatusLabel(task.status)}</span>
                </div>
              )) : <p className="text-[10px] text-[#6e7681]">No Mission tasks yet.</p>}
            </div>
          </div>

          <div className="rounded-xl border border-[#30363d] bg-[#010409]/55 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8b949e]">Needs attention</h3>
              <span className="text-[10px] text-[#484f58]">{blockedTasks.length + missionApprovals.length}</span>
            </div>
            <div className="max-h-28 space-y-1 overflow-y-auto pr-1">
              {missionApprovals.map((approval) => (
                <div key={approval.id} className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-[10px] text-amber-200">
                  Approval · {approval.reason}
                </div>
              ))}
              {blockedTasks.map((task) => (
                <div key={task.id} className="rounded-md border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-[10px] text-red-200">
                  {taskStatusLabel(task.status)} · {task.title}
                </div>
              ))}
              {missionApprovals.length === 0 && blockedTasks.length === 0 && (
                <p className="text-[10px] text-[#6e7681]">Nothing needs your attention right now.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-[#21262d] bg-[#0d1117] px-3 py-2">
      <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-[#6e7681]">{label}</div>
      <div className="mt-0.5 text-base font-semibold text-[#e6edf3]">{value}</div>
      <div className="truncate text-[9px] text-[#6e7681]" title={detail}>{detail}</div>
    </div>
  );
}
