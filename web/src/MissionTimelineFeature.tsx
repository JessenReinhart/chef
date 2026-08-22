import { useEffect, useMemo, useState } from "react";
import type { UiRuntimeEvent, ViewMode } from "./types";

type Props = {
  missionId: string;
  mode: ViewMode;
};

type TimelineResponse = {
  ok: boolean;
  data?: UiRuntimeEvent[];
  error?: string;
};

type MissionPlanTask = {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  priority: number;
  assignedTo?: string;
};

type MissionPlanTaskState = {
  id: string;
  status: string;
  assignedTo?: string;
  resultSummary?: string;
  error?: string;
};

type MissionPlan = {
  id: string;
  goal: string;
  status: string;
  createdAt: number;
  updatedAt?: number;
  isCurrent: boolean;
  tasks: MissionPlanTask[];
  taskIds: string[];
  taskStates: MissionPlanTaskState[];
};

type MissionPlanProjection = {
  missionId: string;
  currentPlanId?: string;
  plans: MissionPlan[];
};

type MissionPlanResponse = {
  ok: boolean;
  data?: MissionPlanProjection;
  error?: string;
};

type OutcomeHighlight = {
  id: string;
  title: string;
  detail: string;
  status: string;
};

type MissionOutcome = {
  status: string;
  completed: number;
  failed: number;
  blocked: number;
  cancelled: number;
  total: number;
  highlights: OutcomeHighlight[];
};

type MissionProgressSummary = {
  headline: string;
  detail: string;
  completed: number;
  active: number;
  waiting: number;
  attention: number;
  highlights: OutcomeHighlight[];
};

const FRIENDLY_EVENT_LABELS: Record<string, string> = {
  "mission.created": "Mission started",
  "mission.status": "Mission status changed",
  "mission.redirected": "Mission direction updated",
  "plan.created": "Chef prepared a plan",
  "plan.revised": "Chef revised the plan",
  "task.created": "Work item added",
  "task.assigned": "Work assigned",
  "task.status": "Work status changed",
  "task.completed": "Work item completed",
  "task.failed": "Work item needs attention",
  "approval.requested": "Approval requested",
  "approval.resolved": "Approval resolved",
  "artifact.created": "New result produced",
};

const PLAN_TASK_LIMIT = 12;
const OUTCOME_HIGHLIGHT_LIMIT = 4;
const PROGRESS_HIGHLIGHT_LIMIT = 3;
const TERMINAL_PLAN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_TASK_STATUSES = new Set(["assigned", "spawning", "running"]);
const ATTENTION_TASK_STATUSES = new Set(["failed", "blocked"]);

function friendlyEventLabel(event: UiRuntimeEvent): string {
  return FRIENDLY_EVENT_LABELS[event.type]
    ?? event.type
      .replace(/[._-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function eventDetail(event: UiRuntimeEvent): string | null {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return null;
  const payload = event.payload as Record<string, unknown>;
  const detail = payload.reason
    ?? payload.message
    ?? payload.status
    ?? payload.title
    ?? payload.result;
  return typeof detail === "string" && detail.trim() ? detail.trim() : null;
}

function planTaskStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "Queued",
    assigned: "Assigned",
    spawning: "Starting",
    running: "Working",
    completed: "Done",
    failed: "Failed",
    blocked: "Blocked",
    cancelled: "Cancelled",
  };
  return labels[status] ?? status.replace(/[._-]+/g, " ");
}

function planTaskTone(status: string): string {
  if (status === "completed") return "border-green-500/25 bg-green-500/5 text-green-200";
  if (status === "failed" || status === "cancelled") return "border-red-500/25 bg-red-500/5 text-red-200";
  if (status === "blocked") return "border-amber-500/25 bg-amber-500/5 text-amber-200";
  if (["assigned", "spawning", "running"].includes(status)) return "border-cyan-500/25 bg-cyan-500/5 text-cyan-200";
  return "border-[#21262d] bg-[#0d1117] text-[#8b949e]";
}

function outcomeTone(status: string): string {
  if (status === "completed") return "border-green-500/25 bg-green-500/5";
  if (status === "failed" || status === "cancelled") return "border-red-500/25 bg-red-500/5";
  return "border-amber-500/25 bg-amber-500/5";
}

function buildMissionOutcome(plan: MissionPlan): MissionOutcome | null {
  if (!TERMINAL_PLAN_STATUSES.has(plan.status)) return null;

  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  const counts = { completed: 0, failed: 0, blocked: 0, cancelled: 0 };
  const highlights: OutcomeHighlight[] = [];

  for (const state of plan.taskStates) {
    if (state.status === "completed") counts.completed += 1;
    if (state.status === "failed") counts.failed += 1;
    if (state.status === "blocked") counts.blocked += 1;
    if (state.status === "cancelled") counts.cancelled += 1;

    const detail = state.error ?? state.resultSummary;
    if (!detail || highlights.length >= OUTCOME_HIGHLIGHT_LIMIT) continue;
    const task = tasks.get(state.id);
    highlights.push({
      id: state.id,
      title: task?.title ?? "Work item",
      detail,
      status: state.status,
    });
  }

  return {
    status: plan.status,
    ...counts,
    total: plan.tasks.length,
    highlights,
  };
}

function buildMissionProgressSummary(plan: MissionPlan): MissionProgressSummary | null {
  if (TERMINAL_PLAN_STATUSES.has(plan.status)) return null;

  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  const states = plan.taskStates.length > 0
    ? plan.taskStates
    : plan.tasks.map((task) => ({ id: task.id, status: "pending", assignedTo: task.assignedTo }));
  const completed = states.filter((state) => state.status === "completed").length;
  const activeStates = states.filter((state) => ACTIVE_TASK_STATUSES.has(state.status));
  const attentionStates = states.filter((state) => ATTENTION_TASK_STATUSES.has(state.status));
  const waitingStates = states.filter((state) => state.status === "pending");
  const focusStates = attentionStates.length > 0 ? attentionStates : activeStates.length > 0 ? activeStates : waitingStates;
  const highlights = focusStates.slice(0, PROGRESS_HIGHLIGHT_LIMIT).map((state) => {
    const task = tasks.get(state.id);
    return {
      id: state.id,
      title: task?.title ?? "Work item",
      detail: state.error ?? state.resultSummary ?? task?.description ?? "Waiting for the next runtime update.",
      status: state.status,
    };
  });

  if (attentionStates.length > 0) {
    return {
      headline: `${attentionStates.length} work item${attentionStates.length === 1 ? "" : "s"} need attention.`,
      detail: "Chef is blocked on unresolved work before the Mission can move forward.",
      completed,
      active: activeStates.length,
      waiting: waitingStates.length,
      attention: attentionStates.length,
      highlights,
    };
  }

  if (activeStates.length > 0) {
    const workers = new Set(activeStates.map((state) => state.assignedTo).filter(Boolean));
    return {
      headline: `Chef is working on ${activeStates.length} item${activeStates.length === 1 ? "" : "s"}.`,
      detail: workers.size > 0
        ? `${workers.size} worker${workers.size === 1 ? " is" : "s are"} active right now.`
        : "The current plan has active work in progress.",
      completed,
      active: activeStates.length,
      waiting: waitingStates.length,
      attention: 0,
      highlights,
    };
  }

  if (waitingStates.length > 0) {
    return {
      headline: "Chef is preparing the next work item.",
      detail: `${waitingStates.length} planned item${waitingStates.length === 1 ? " is" : "s are"} still queued.`,
      completed,
      active: 0,
      waiting: waitingStates.length,
      attention: 0,
      highlights,
    };
  }

  return {
    headline: "Chef is waiting for the next runtime update.",
    detail: "No active, queued, or blocked work is currently projected for this plan.",
    completed,
    active: 0,
    waiting: 0,
    attention: 0,
    highlights: [],
  };
}

export function MissionTimelineFeature({ missionId, mode }: Props) {
  const [events, setEvents] = useState<UiRuntimeEvent[]>([]);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [planProjection, setPlanProjection] = useState<MissionPlanProjection | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const refreshTimeline = async () => {
      try {
        const response = await fetch(`/api/missions/${encodeURIComponent(missionId)}/timeline`);
        const body = await response.json() as TimelineResponse;
        if (!response.ok || !body.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (!active) return;
        setEvents(body.data ?? []);
        setTimelineError(null);
      } catch (cause) {
        if (!active) return;
        setTimelineError(cause instanceof Error ? cause.message : "Mission history is unavailable");
      }
    };

    const refreshPlan = async () => {
      try {
        const response = await fetch(`/api/missions/${encodeURIComponent(missionId)}/plans`);
        const body = await response.json() as MissionPlanResponse;
        if (!response.ok || !body.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (!active) return;
        setPlanProjection(body.data ?? null);
        setPlanError(null);
      } catch (cause) {
        if (!active) return;
        setPlanError(cause instanceof Error ? cause.message : "Mission plan is unavailable");
      }
    };

    const refresh = () => {
      void refreshTimeline();
      void refreshPlan();
    };

    refresh();
    const interval = window.setInterval(refresh, 2500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [missionId]);

  const visibleEvents = useMemo(() => events.slice(-8).reverse(), [events]);
  const currentPlan = useMemo(() => {
    if (!planProjection) return null;
    return planProjection.plans.find((plan) => plan.isCurrent)
      ?? planProjection.plans.find((plan) => plan.id === planProjection.currentPlanId)
      ?? null;
  }, [planProjection]);

  const visiblePlanTasks = useMemo(() => {
    if (!currentPlan) return [];
    const states = new Map(currentPlan.taskStates.map((state) => [state.id, state]));
    return currentPlan.tasks.slice(0, PLAN_TASK_LIMIT).map((task) => ({
      task,
      runtimeTaskId: currentPlan.taskIds.includes(task.id) ? task.id : undefined,
      state: states.get(task.id),
    }));
  }, [currentPlan]);

  const outcome = useMemo(() => currentPlan ? buildMissionOutcome(currentPlan) : null, [currentPlan]);
  const progressSummary = useMemo(() => currentPlan ? buildMissionProgressSummary(currentPlan) : null, [currentPlan]);

  return (
    <>
      {progressSummary && (
        <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3 xl:col-span-2" aria-label="Mission progress summary">
          <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8b949e]">What Chef is doing now</h3>
              <p className="mt-0.5 text-[11px] font-medium text-[#c9d1d9]">{progressSummary.headline}</p>
              <p className="mt-0.5 text-[10px] text-[#6e7681]">{progressSummary.detail}</p>
            </div>
            <div className="flex flex-wrap gap-1.5" aria-label="Mission progress counts">
              <span className="rounded-full border border-green-500/20 bg-green-500/5 px-2 py-0.5 text-[9px] text-green-200">{progressSummary.completed} done</span>
              {progressSummary.active > 0 && <span className="rounded-full border border-cyan-500/20 bg-cyan-500/5 px-2 py-0.5 text-[9px] text-cyan-200">{progressSummary.active} active</span>}
              {progressSummary.waiting > 0 && <span className="rounded-full border border-[#30363d] bg-[#161b22]/60 px-2 py-0.5 text-[9px] text-[#8b949e]">{progressSummary.waiting} queued</span>}
              {progressSummary.attention > 0 && <span className="rounded-full border border-amber-500/20 bg-amber-500/5 px-2 py-0.5 text-[9px] text-amber-200">{progressSummary.attention} attention</span>}
            </div>
          </div>

          {progressSummary.highlights.length > 0 && (
            <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
              {progressSummary.highlights.map((highlight) => (
                <div key={highlight.id} className={`min-w-0 rounded-md border px-2.5 py-2 ${planTaskTone(highlight.status)}`}>
                  <div className="flex items-start justify-between gap-2">
                    <strong className="truncate text-[10px]" title={highlight.title}>{highlight.title}</strong>
                    <span className="shrink-0 text-[9px] opacity-75">{planTaskStatusLabel(highlight.status)}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[9px] leading-4 opacity-75" title={highlight.detail}>{highlight.detail}</p>
                </div>
              ))}
            </div>
          )}
          {mode === "power" && <p className="mt-2 text-[9px] text-[#484f58]">Summary derived from the current durable plan and task state. plan:{currentPlan?.id.slice(0, 8)}</p>}
        </div>
      )}

      {outcome && (
        <div className={`rounded-xl border p-3 xl:col-span-2 ${outcomeTone(outcome.status)}`} aria-label="Mission outcome summary">
          <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8b949e]">Mission outcome</h3>
              <p className="mt-0.5 text-[11px] font-medium text-[#c9d1d9]">
                {outcome.status === "completed" ? "Chef finished this Mission." : outcome.status === "failed" ? "This Mission finished with unresolved failures." : "This Mission was cancelled before completion."}
              </p>
            </div>
            <span className="rounded-full border border-[#30363d] bg-[#161b22]/80 px-2 py-0.5 text-[9px] capitalize text-[#8b949e]">{outcome.status}</span>
          </div>

          <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Mission outcome counts">
            <span className="rounded-full border border-green-500/20 bg-green-500/5 px-2 py-0.5 text-[9px] text-green-200">{outcome.completed} done</span>
            {outcome.failed > 0 && <span className="rounded-full border border-red-500/20 bg-red-500/5 px-2 py-0.5 text-[9px] text-red-200">{outcome.failed} failed</span>}
            {outcome.blocked > 0 && <span className="rounded-full border border-amber-500/20 bg-amber-500/5 px-2 py-0.5 text-[9px] text-amber-200">{outcome.blocked} blocked</span>}
            {outcome.cancelled > 0 && <span className="rounded-full border border-red-500/20 bg-red-500/5 px-2 py-0.5 text-[9px] text-red-200">{outcome.cancelled} cancelled</span>}
            <span className="rounded-full border border-[#30363d] bg-[#161b22]/60 px-2 py-0.5 text-[9px] text-[#8b949e]">{outcome.total} planned</span>
          </div>

          {outcome.highlights.length > 0 ? (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {outcome.highlights.map((highlight) => (
                <div key={highlight.id} className="min-w-0 rounded-md border border-[#30363d]/70 bg-[#0d1117]/55 px-2.5 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <strong className="truncate text-[10px] text-[#c9d1d9]" title={highlight.title}>{highlight.title}</strong>
                    <span className="shrink-0 text-[9px] capitalize text-[#8b949e]">{planTaskStatusLabel(highlight.status)}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[9px] leading-4 text-[#8b949e]" title={highlight.detail}>{highlight.detail}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-[#6e7681]">No task result summaries were recorded for this finished plan.</p>
          )}
          {mode === "power" && <p className="mt-2 text-[9px] text-[#484f58]">Summary derived from durable plan and task state. plan:{currentPlan?.id.slice(0, 8)}</p>}
        </div>
      )}

      <div className="rounded-xl border border-[#30363d] bg-[#010409]/55 p-3 xl:col-span-2" aria-label="Mission plan">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8b949e]">Current plan</h3>
            <p className="mt-0.5 text-[10px] text-[#6e7681]">The work Chef intends to execute for this Mission.</p>
          </div>
          {mode === "power" && planProjection && (
            <span className="shrink-0 text-[10px] text-[#484f58]">{planProjection.plans.length} plan{planProjection.plans.length === 1 ? "" : "s"} recorded</span>
          )}
        </div>

        {planError ? (
          <p className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-2 text-[10px] text-amber-200">
            Mission plan is temporarily unavailable. {mode === "power" ? planError : ""}
          </p>
        ) : !currentPlan ? (
          <p className="text-[10px] text-[#6e7681]">Chef has not created a durable plan for this Mission yet.</p>
        ) : (
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium text-[#c9d1d9]">{currentPlan.goal}</span>
              <span className="rounded-full border border-[#30363d] bg-[#161b22] px-2 py-0.5 text-[9px] capitalize text-[#8b949e]">{currentPlan.status}</span>
              {mode === "power" && <span className="text-[9px] text-[#484f58]">plan:{currentPlan.id.slice(0, 8)}</span>}
            </div>

            {visiblePlanTasks.length === 0 ? (
              <p className="text-[10px] text-[#6e7681]">This plan has no task steps yet.</p>
            ) : (
              <ol className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                {visiblePlanTasks.map(({ task, runtimeTaskId, state }, index) => {
                  const status = state?.status ?? "pending";
                  const detail = state?.error ?? state?.resultSummary ?? task.description;
                  return (
                    <li key={task.id} className={`min-w-0 rounded-md border px-2.5 py-2 ${planTaskTone(status)}`}>
                      <div className="flex items-start gap-2">
                        <span className="mt-0.5 shrink-0 text-[9px] opacity-60">{index + 1}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <span className="truncate text-[10px] font-medium" title={task.title}>{task.title}</span>
                            <span className="shrink-0 text-[9px] opacity-75">{planTaskStatusLabel(status)}</span>
                          </div>
                          {detail && <p className="mt-1 line-clamp-2 text-[9px] leading-4 opacity-75" title={detail}>{detail}</p>}
                          {mode === "power" && (
                            <p className="mt-1 truncate text-[9px] opacity-50" title={`${runtimeTaskId ?? task.id} · ${state?.assignedTo ?? task.assignedTo ?? "unassigned"}`}>
                              {runtimeTaskId ? `task:${runtimeTaskId.slice(0, 8)}` : `step:${task.id}`} · {state?.assignedTo ?? task.assignedTo ?? "unassigned"}
                            </p>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}

            {currentPlan.tasks.length > PLAN_TASK_LIMIT && (
              <p className="mt-2 text-[9px] text-[#6e7681]">Showing {PLAN_TASK_LIMIT} of {currentPlan.tasks.length} plan steps.</p>
            )}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-[#30363d] bg-[#010409]/55 p-3 xl:col-span-2" aria-label="Mission timeline">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8b949e]">Mission timeline</h3>
            <p className="mt-0.5 text-[10px] text-[#6e7681]">Meaningful Mission activity, newest first.</p>
          </div>
          <span className="text-[10px] text-[#484f58]">{events.length} events</span>
        </div>

        {timelineError ? (
          <p className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-2 text-[10px] text-amber-200">
            Mission history is temporarily unavailable. {mode === "power" ? timelineError : ""}
          </p>
        ) : visibleEvents.length === 0 ? (
          <p className="text-[10px] text-[#6e7681]">Mission activity will appear here as Chef and the team work.</p>
        ) : (
          <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
            {visibleEvents.map((event) => {
              const detail = eventDetail(event);
              return (
                <div key={event.id} className="min-w-0 rounded-md border border-[#21262d] bg-[#0d1117] px-2.5 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate text-[10px] font-medium text-[#c9d1d9]" title={friendlyEventLabel(event)}>{friendlyEventLabel(event)}</span>
                    <time className="shrink-0 text-[9px] text-[#484f58]" dateTime={new Date(event.timestamp).toISOString()}>
                      {new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </time>
                  </div>
                  {detail && <p className="mt-1 line-clamp-2 text-[9px] leading-4 text-[#8b949e]" title={detail}>{detail}</p>}
                  {mode === "power" && (
                    <p className="mt-1 truncate text-[9px] text-[#484f58]" title={`${event.type} · ${event.source.type}:${event.source.id}`}>
                      #{event.seq} · {event.type} · {event.source.type}:{event.source.id}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
