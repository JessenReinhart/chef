import type { UiRuntimeEvent } from "./types";

const FRIENDLY_EVENT_LABELS: Record<string, string> = {
  "mission.created": "Mission started",
  "mission.status": "Mission status changed",
  "mission.redirected": "Mission direction updated",
  "orchestrator.plan.started": "Planning started",
  "orchestrator.plan.proposed": "Execution route selected",
  "orchestrator.plan.none": "Planning ended without a plan",
  "orchestrator.plan.error": "Planning failed",
  "orchestrator.plan.interrupted": "Execution interrupted",
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

function payloadText(payload: Record<string, unknown>): string | null {
  const detail = payload.error
    ?? payload.reason
    ?? payload.message
    ?? payload.status
    ?? payload.title
    ?? payload.result;
  return typeof detail === "string" && detail.trim() ? detail.trim() : null;
}

export function missionDiagnosticLabel(event: UiRuntimeEvent): string {
  return FRIENDLY_EVENT_LABELS[event.type]
    ?? event.type
      .replace(/[._-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function missionDiagnosticDetail(event: UiRuntimeEvent): string | null {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return null;
  const payload = event.payload as Record<string, unknown>;

  if (event.type === "orchestrator.plan.started") {
    return "Decision provider call started; no worker has been selected yet.";
  }

  if (event.type === "orchestrator.plan.proposed") {
    const routingMode = payload.routingMode;
    const taskIds = Array.isArray(payload.taskIds) ? payload.taskIds : [];
    if (routingMode === "single-worker") return "Route: single worker.";
    if (routingMode === "planner") return `Route: coordinated planner${taskIds.length > 0 ? ` (${taskIds.length} steps)` : ""}.`;
  }

  if (event.type === "orchestrator.plan.none") {
    return payloadText(payload) ?? "Planning finished without selecting work, so no worker was started.";
  }

  if (event.type === "orchestrator.plan.interrupted") {
    return payloadText(payload) ?? "Execution stopped before the planned work could continue.";
  }

  return payloadText(payload);
}
