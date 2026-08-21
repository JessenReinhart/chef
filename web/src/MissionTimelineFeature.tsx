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

export function MissionTimelineFeature({ missionId, mode }: Props) {
  const [events, setEvents] = useState<UiRuntimeEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const refresh = async () => {
      try {
        const response = await fetch(`/api/missions/${encodeURIComponent(missionId)}/timeline`);
        const body = await response.json() as TimelineResponse;
        if (!response.ok || !body.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (!active) return;
        setEvents(body.data ?? []);
        setError(null);
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Mission history is unavailable");
      }
    };

    void refresh();
    const interval = window.setInterval(() => void refresh(), 2500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [missionId]);

  const visibleEvents = useMemo(() => events.slice(-8).reverse(), [events]);

  return (
    <div className="rounded-xl border border-[#30363d] bg-[#010409]/55 p-3 xl:col-span-2" aria-label="Mission timeline">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8b949e]">Mission timeline</h3>
          <p className="mt-0.5 text-[10px] text-[#6e7681]">Meaningful Mission activity, newest first.</p>
        </div>
        <span className="text-[10px] text-[#484f58]">{events.length} events</span>
      </div>

      {error ? (
        <p className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-2 text-[10px] text-amber-200">
          Mission history is temporarily unavailable. {mode === "power" ? error : ""}
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
  );
}
