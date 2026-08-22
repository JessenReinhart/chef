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

  return (
    <>
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
