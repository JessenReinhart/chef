import type { UiRuntimeEvent } from "./types";

export type MissionProgressTone = "neutral" | "active" | "attention" | "success";

export interface MissionProgressItem {
  id: string;
  eventType: string;
  timestamp: number;
  text: string;
  tone: MissionProgressTone;
}

type Payload = Record<string, unknown>;

function objectPayload(event: UiRuntimeEvent): Payload {
  return event.payload && typeof event.payload === "object" ? event.payload as Payload : {};
}

function stringValue(payload: Payload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(payload: Payload, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function missionStatusText(status: string): MissionProgressItem["tone"] {
  if (status === "completed") return "success";
  if (status === "failed" || status === "blocked" || status === "waiting_for_approval" || status === "cancelled") return "attention";
  if (status === "active" || status === "planning" || status === "verifying") return "active";
  return "neutral";
}

/** Convert durable runtime events into a compact, human-oriented Mission update. */
export function summarizeMissionProgressEvent(event: UiRuntimeEvent): MissionProgressItem | null {
  const payload = objectPayload(event);
  let text: string | null = null;
  let tone: MissionProgressTone = "neutral";

  switch (event.type) {
    case "mission.created": {
      const goal = stringValue(payload, "goal");
      text = goal ? `Mission started: ${goal}` : "Mission started.";
      tone = "active";
      break;
    }
    case "mission.redirected": {
      const goal = stringValue(payload, "goal") ?? stringValue(payload, "newGoal");
      text = goal ? `Mission redirected: ${goal}` : "Mission direction changed.";
      tone = "active";
      break;
    }
    case "mission.status": {
      const status = stringValue(payload, "status");
      if (!status) return null;
      const labels: Record<string, string> = {
        planning: "Chef is planning the Mission.",
        active: "Mission work is active.",
        paused: "Mission paused.",
        waiting_for_approval: "Mission is waiting for approval.",
        blocked: "Mission is blocked and needs attention.",
        verifying: "Chef is verifying the result.",
        completed: "Mission completed.",
        cancelled: "Mission cancelled.",
        failed: "Mission failed and needs attention.",
      };
      text = labels[status] ?? `Mission status changed to ${status}.`;
      tone = missionStatusText(status);
      break;
    }
    case "orchestrator.plan.proposed": {
      const count = stringArray(payload, "taskIds").length;
      text = count > 0
        ? `Chef prepared a plan with ${count} step${count === 1 ? "" : "s"}.`
        : "Chef prepared a Mission plan.";
      tone = "active";
      break;
    }
    case "orchestrator.plan.executing": {
      const count = stringArray(payload, "taskIds").length;
      text = count > 0
        ? `Chef started coordinating ${count} planned step${count === 1 ? "" : "s"}.`
        : "Chef started executing the Mission plan.";
      tone = "active";
      break;
    }
    case "orchestrator.task.evaluated": {
      const summary = stringValue(payload, "summary");
      const status = stringValue(payload, "status");
      const error = stringValue(payload, "error");
      if (error) {
        text = `Verification needs attention: ${error}`;
        tone = "attention";
      } else if (summary) {
        text = `Verification update: ${summary}`;
        tone = status === "failed" ? "attention" : "success";
      } else {
        text = "Chef evaluated a completed work item.";
        tone = status === "failed" ? "attention" : "success";
      }
      break;
    }
    case "approval.requested": {
      const reason = stringValue(payload, "reason");
      text = reason ? `Approval needed: ${reason}` : "Approval needed before Chef can continue.";
      tone = "attention";
      break;
    }
    case "approval.resolved": {
      const decision = stringValue(payload, "decision");
      text = decision === "rejected" ? "Approval was denied; Chef will adjust." : "Approval resolved; Chef can continue.";
      tone = decision === "rejected" ? "attention" : "active";
      break;
    }
    case "node.failed": {
      const error = stringValue(payload, "error");
      text = error ? `A work item failed: ${error}` : "A work item failed and needs attention.";
      tone = "attention";
      break;
    }
    case "orchestrator.plan.error": {
      const error = stringValue(payload, "error");
      text = error ? `Planning failed: ${error}` : "Planning failed and needs attention.";
      tone = "attention";
      break;
    }
    default:
      return null;
  }

  return { id: event.id, eventType: event.type, timestamp: event.timestamp, text, tone };
}

export function summarizeMissionProgress(events: UiRuntimeEvent[], limit = 5): MissionProgressItem[] {
  return events
    .map(summarizeMissionProgressEvent)
    .filter((item): item is MissionProgressItem => item !== null)
    .slice(-limit);
}
