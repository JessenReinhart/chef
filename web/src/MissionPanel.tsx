import { useMemo, useState } from "react";
import { MissionTimelineFeature } from "./MissionTimelineFeature";
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

type VerificationSummary = {
  label: string;
  detail: string;
  tone: string;
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

function readSuccessCriteria(mission: UiMission): string[] {
  const value = mission.metadata?.successCriteria;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function buildVerificationSummary(
  mission: UiMission,
  missionTasks: UiTask[],
  successCriteria: string[],
): VerificationSummary {
  const attentionCount = missionTasks.filter((task) => task.status === "failed" || task.status === "blocked").length;
  const criteriaDetail = successCriteria.length > 0
    ? `${successCriteria.length} explicit success ${successCriteria.length === 1 ? "criterion" : "criteria"}`
    : "No explicit success criteria recorded";

  if (mission.status === "verifying") {
    return {
      label: "Checking outcome",
      detail: successCriteria.length > 0 ? `${criteriaDetail} under review.` : "Chef is checking the Mission outcome before completion.",
      tone: "border-cyan-500/25 bg-cyan-500/5 text-cyan-200",
    };
  }
  if (mission.status === "completed") {
    return {
      label: "Outcome verified",
      detail: successCriteria.length > 0 ? `${criteriaDetail} · Mission completed.` : "Mission completed after the runtime verification phase.",
      tone: "border-green-500/25 bg-green-500/5 text-green-200",
    };
  }
  if (mission.status === "failed") {
    return {
      label: "Verification failed",
      detail: attentionCount > 0 ? `${attentionCount} work ${attentionCount === 1 ? "item needs" : "items need"} attention.` : "Mission ended without a verified successful outcome.",
      tone: "border-red-500/25 bg-red-500/5 text-red-200",
    };
  }
  if (mission.status === "cancelled") {
    return {
      label: "Not verified",
      detail: "Mission was cancelled before a successful outcome was verified.",
      tone: "border-[#30363d] bg-[#161b22]/75 text-[#8b949e]",
    };
  }
  if (attentionCount > 0 || mission.status === "blocked") {
    return {
      label: "Blocked before verification",
      detail: `${attentionCount || 1} work ${attentionCount === 1 ? "item needs" : "items need"} attention first.`,
      tone: "border-amber-500/25 bg-amber-500/5 text-amber-200",
    };
  }
  return {
    label: "Pending",
    detail: successCriteria.length > 0 ? `${criteriaDetail} will be checked before completion.` : "Verification begins after planned work is ready to evaluate.",
    tone: "border-[#30363d] bg-[#161b22]/75 text-[#8b949e]",
  };
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

  const successCriteria = readSuccessCriteria(mission);
  const [editingCriteria, setEditingCriteria] = useState(false);
  const [criteriaDraft, setCriteriaDraft] = useState("");
  const [criteriaSaving, setCriteriaSaving] = useState(false);
  const [criteriaError, setCriteriaError] = useState<string | null>(null);
  const [followUpDraft, setFollowUpDraft] = useState("");
  const [followUpSubmitting, setFollowUpSubmitting] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);

  const completedCount = missionTasks.filter((task) => task.status === "completed").length;
  const activeCount = missionTasks.filter((task) => ["assigned", "spawning", "running"].includes(task.status)).length;
  const blockedTasks = missionTasks.filter((task) => task.status === "blocked" || task.status === "failed");
  const totalTaskCount = mission.taskIds.length;
  const progress = totalTaskCount > 0 ? Math.round((completedCount / totalTaskCount) * 100) : 0;
  const owners = Array.from(new Set(missionTasks.map((task) => task.assignedTo).filter((owner): owner is string => Boolean(owner))));
  const canControl = !TERMINAL_STATUSES.has(mission.status);
  const verification = buildVerificationSummary(mission, missionTasks, successCriteria);

  const beginCriteriaEdit = () => {
    setCriteriaDraft(successCriteria.join("\n"));
    setCriteriaError(null);
    setEditingCriteria(true);
  };

  const saveCriteria = async () => {
    const next = criteriaDraft.split("\n").map((item) => item.trim()).filter(Boolean);
    setCriteriaSaving(true);
    setCriteriaError(null);
    try {
      const response = await fetch(`/api/missions/${encodeURIComponent(mission.id)}/success-criteria`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ successCriteria: next }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      setEditingCriteria(false);
    } catch (error) {
      setCriteriaError(error instanceof Error ? error.message : "Could not save success criteria");
    } finally {
      setCriteriaSaving(false);
    }
  };

  const startFollowUp = async () => {
    const request = followUpDraft.trim();
    if (!request || followUpSubmitting) return;
    setFollowUpSubmitting(true);
    setFollowUpError(null);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: `Previous Mission goal: ${mission.goal}\n\nFollow-up request: ${request}`,
        }),
      });
      const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || body.ok === false) {
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      setFollowUpDraft("");
    } catch (error) {
      setFollowUpError(error instanceof Error ? error.message : "Could not start follow-up Mission");
    } finally {
      setFollowUpSubmitting(false);
    }
  };

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

          <div className="mt-4 rounded-lg border border-[#21262d] bg-[#0d1117] p-3" aria-label="Mission success criteria">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8b949e]">Success criteria</h3>
                <p className="mt-0.5 text-[10px] text-[#6e7681]">Define what must be true before this Mission is considered successful.</p>
              </div>
              {canControl && !editingCriteria && (
                <button onClick={beginCriteriaEdit} className="shrink-0 rounded-md border border-[#30363d] bg-[#161b22] px-2.5 py-1 text-[10px] text-[#c9d1d9] hover:border-cyan-500/40">
                  {successCriteria.length > 0 ? "Edit" : "Add criteria"}
                </button>
              )}
            </div>

            {editingCriteria ? (
              <div className="mt-3">
                <textarea
                  value={criteriaDraft}
                  onChange={(event) => setCriteriaDraft(event.target.value)}
                  rows={Math.max(3, Math.min(7, criteriaDraft.split("\n").length + 1))}
                  placeholder={"One criterion per line\nTests pass\nNo regression in existing behavior"}
                  className="w-full resize-y rounded-md border border-[#30363d] bg-[#010409] px-3 py-2 text-[11px] leading-5 text-[#e6edf3] outline-none placeholder:text-[#484f58] focus:border-cyan-500/50"
                />
                {criteriaError && <p className="mt-1 text-[10px] text-red-300">{criteriaError}</p>}
                <div className="mt-2 flex justify-end gap-2">
                  <button onClick={() => setEditingCriteria(false)} disabled={criteriaSaving} className="rounded-md border border-[#30363d] px-2.5 py-1 text-[10px] text-[#8b949e] disabled:opacity-40">Cancel</button>
                  <button onClick={() => void saveCriteria()} disabled={criteriaSaving} className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[10px] text-cyan-300 disabled:opacity-40">{criteriaSaving ? "Saving…" : "Save criteria"}</button>
                </div>
              </div>
            ) : successCriteria.length > 0 ? (
              <ul className="mt-3 space-y-1.5">
                {successCriteria.map((criterion, index) => (
                  <li key={`${index}:${criterion}`} className="flex items-start gap-2 text-[11px] leading-4 text-[#c9d1d9]">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full border border-cyan-400/60 bg-cyan-400/15" />
                    <span>{criterion}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-[10px] text-[#6e7681]">No explicit success criteria yet. Chef can still run the Mission, but completion is less inspectable.</p>
            )}
          </div>

          {!TERMINAL_STATUSES.has(mission.status) ? (
            <form className="mt-4 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); onRedirect(); }}>
              <input
                value={redirectGoal}
                onChange={(event) => onRedirectGoalChange(event.target.value)}
                placeholder="Redirect or refine this Mission…"
                className="min-w-[240px] flex-1 rounded-md border border-[#30363d] bg-[#0d1117] px-3 py-2 text-[11px] text-[#e6edf3] outline-none placeholder:text-[#484f58] focus:border-cyan-500/50"
              />
              <button type="submit" disabled={!redirectGoal.trim()} className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-[11px] text-cyan-300 disabled:cursor-not-allowed disabled:opacity-40">Redirect</button>
            </form>
          ) : (
            <form className="mt-4 rounded-lg border border-[#30363d] bg-[#0d1117] p-3" aria-label="Continue with a follow-up Mission" onSubmit={(event) => { event.preventDefault(); void startFollowUp(); }}>
              <div className="mb-2">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8b949e]">Continue from here</h3>
                <p className="mt-0.5 text-[10px] text-[#6e7681]">Start a new Mission that carries this Mission goal forward in the request, while keeping this finished run intact.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <input
                  value={followUpDraft}
                  onChange={(event) => setFollowUpDraft(event.target.value)}
                  placeholder="What should Chef do next?"
                  className="min-w-[240px] flex-1 rounded-md border border-[#30363d] bg-[#010409] px-3 py-2 text-[11px] text-[#e6edf3] outline-none placeholder:text-[#484f58] focus:border-cyan-500/50"
                />
                <button type="submit" disabled={!followUpDraft.trim() || followUpSubmitting} className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-[11px] text-cyan-300 disabled:cursor-not-allowed disabled:opacity-40">
                  {followUpSubmitting ? "Starting…" : "Start follow-up"}
                </button>
              </div>
              {followUpError && <p className="mt-2 text-[10px] text-red-300">{followUpError}</p>}
            </form>
          )}
        </div>

        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-1">
          <div className={`rounded-xl border p-3 ${verification.tone}`} aria-label="Mission verification state">
            <div className="mb-1 flex items-center justify-between gap-2">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em]">Verification</h3>
              <span className="text-[10px] opacity-70">{mission.status === "verifying" ? "Live" : "State"}</span>
            </div>
            <div className="text-[11px] font-medium">{verification.label}</div>
            <p className="mt-1 text-[10px] leading-4 opacity-80">{verification.detail}</p>
          </div>

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

        <MissionTimelineFeature missionId={mission.id} mode={mode} />
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
