import type { UiRuntimeEvent } from "./types";

export type MissionProgressTone = "neutral" | "active" | "attention" | "success";
export type MissionHomeState = "ready" | "working" | "attention" | "done";

export interface MissionProgressItem {
  id: string;
  eventType: string;
  timestamp: number;
  text: string;
  tone: MissionProgressTone;
}

type Payload = Record<string, unknown>;

const HEARTBEAT_AFTER_MS = 10_000;

function objectPayload(event: UiRuntimeEvent): Payload {
  return event.payload && typeof event.payload === "object" ? event.payload as Payload : {};
}

function stringValue(payload: Payload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(payload: Payload, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function belongsToMission(event: UiRuntimeEvent, missionId: string, taskIds: Set<string>): boolean {
  const payload = objectPayload(event);
  const payloadMissionId = stringValue(payload, "missionId");
  const payloadTaskId = stringValue(payload, "taskId");
  const payloadTaskIds = stringArray(payload, "taskIds");

  return (event.source.type === "mission" && event.source.id === missionId)
    || event.correlationId === missionId
    || payloadMissionId === missionId
    || (event.taskId !== undefined && taskIds.has(event.taskId))
    || (payloadTaskId !== undefined && taskIds.has(payloadTaskId))
    || payloadTaskIds.some((taskId) => taskIds.has(taskId));
}

function scopeMissionEvents(
  events: UiRuntimeEvent[],
  missionId: string,
  taskIds: Iterable<string>,
): { ownedTaskIds: Set<string>; scoped: UiRuntimeEvent[] } {
  const ownedTaskIds = new Set(taskIds);
  const seedScoped = events.filter((event) => belongsToMission(event, missionId, ownedTaskIds));
  for (const event of seedScoped) {
    const taskId = stringValue(objectPayload(event), "taskId");
    if (taskId) ownedTaskIds.add(taskId);
    for (const taskId of stringArray(objectPayload(event), "taskIds")) ownedTaskIds.add(taskId);
  }

  return {
    ownedTaskIds,
    scoped: events
      .filter((event) => belongsToMission(event, missionId, ownedTaskIds))
      .sort((a, b) => b.seq - a.seq),
  };
}

function activeHeartbeatLabel(status: string | undefined): string | null {
  if (status === "planning") return "Chef is still planning";
  if (status === "verifying") return "Chef is still verifying";
  if (status === "active") return "Chef is still working";
  return null;
}

function inferredHeartbeatLabel(scoped: UiRuntimeEvent[]): string | null {
  const latestPlanningEvent = scoped.find((event) => event.type === "orchestrator.plan.started");
  const latestWorkerEvent = scoped.find((event) =>
    event.type === "task.assigned"
    || event.type === "task.running"
    || event.type === "task.completed"
    || event.type === "task.failed"
    || event.type === "task.blocked"
    || event.type === "task.cancelled"
    || event.type === "session.data"
    || event.type === "session.crashed"
  );
  if (latestPlanningEvent && (!latestWorkerEvent || latestPlanningEvent.seq > latestWorkerEvent.seq)) {
    return "Chef is still planning";
  }
  if (!latestWorkerEvent) return null;
  if (latestWorkerEvent.type === "task.assigned" || latestWorkerEvent.type === "task.running" || latestWorkerEvent.type === "session.data") {
    return "Chef is still working";
  }
  return null;
}

function allOwnedTasksCompleted(scoped: UiRuntimeEvent[], taskIds: Set<string>): boolean {
  if (taskIds.size === 0) return false;
  const latestTaskEvent = new Map<string, string>();

  for (const event of scoped) {
    if (!event.taskId || !taskIds.has(event.taskId) || latestTaskEvent.has(event.taskId)) continue;
    if (!event.type.startsWith("task.")) continue;
    latestTaskEvent.set(event.taskId, event.type);
  }

  return [...taskIds].every((taskId) => latestTaskEvent.get(taskId) === "task.completed");
}

function blocksHeartbeat(event: UiRuntimeEvent): boolean {
  return event.type === "approval.resolved"
    || event.type === "task.failed"
    || event.type === "task.blocked"
    || event.type === "task.cancelled"
    || event.type === "session.crashed"
    || event.type === "node.failed"
    || event.type === "orchestrator.plan.none"
    || event.type === "orchestrator.plan.error"
    || event.type === "orchestrator.plan.interrupted"
    || event.type === "approval.requested";
}

function resumesHeartbeat(event: UiRuntimeEvent): boolean {
  if (event.type === "task.assigned" || event.type === "task.running") return true;
  if (event.type !== "mission.status") return false;
  const status = stringValue(objectPayload(event), "status");
  return status === "planning" || status === "active" || status === "verifying";
}

function taskIdForEvent(event: UiRuntimeEvent): string | undefined {
  return event.taskId ?? stringValue(objectPayload(event), "taskId");
}

function recoveryClearsBlocker(recovery: UiRuntimeEvent, blocker: UiRuntimeEvent): boolean {
  if (blocker.type === "approval.requested") {
    return recovery.type === "approval.resolved" && recovery.source.id === blocker.source.id;
  }
  if (blocker.type === "approval.resolved") {
    const blockedTaskId = taskIdForEvent(blocker);
    if (recovery.type === "mission.status") return resumesHeartbeat(recovery);
    return blockedTaskId !== undefined
      && taskIdForEvent(recovery) === blockedTaskId
      && (recovery.type === "task.assigned" || recovery.type === "task.running");
  }
  if (
    blocker.type === "task.failed"
    || blocker.type === "task.blocked"
    || blocker.type === "task.cancelled"
    || blocker.type === "session.crashed"
  ) {
    const blockedTaskId = taskIdForEvent(blocker);
    return blockedTaskId !== undefined
      && taskIdForEvent(recovery) === blockedTaskId
      && (recovery.type === "task.assigned" || recovery.type === "task.running");
  }
  return resumesHeartbeat(recovery);
}

export function deriveMissionHomeState(input: {
  submitting: boolean;
  needsAttention: boolean;
  working: boolean;
  done: boolean;
}): MissionHomeState {
  if (input.submitting) return "working";
  if (input.needsAttention) return "attention";
  if (input.working) return "working";
  if (input.done) return "done";
  return "ready";
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
    case "mission.timeout": {
      const timeoutMs = numberValue(payload, "timeoutMs");
      if (timeoutMs !== undefined) {
        const seconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
        text = `Mission timed out after ${seconds} second${seconds === 1 ? "" : "s"}.`;
      } else {
        text = "Mission timed out before it could finish.";
      }
      tone = "attention";
      break;
    }
    case "task.assigned": {
      text = "Chef assigned a worker to a work step.";
      tone = "active";
      break;
    }
    case "task.running": {
      const retryCount = numberValue(payload, "retryCount") ?? 0;
      text = retryCount > 0
        ? `Chef is retrying a work step (retry ${retryCount}).`
        : "A worker started a work step.";
      tone = "active";
      break;
    }
    case "task.failed": {
      const error = stringValue(payload, "error");
      text = error ? `A worker step failed: ${error}` : "A worker step failed and needs recovery.";
      tone = "attention";
      break;
    }
    case "task.blocked": {
      const reason = stringValue(payload, "reason") ?? stringValue(payload, "error");
      text = reason ? `A work step is blocked: ${reason}` : "A work step is blocked and needs attention.";
      tone = "attention";
      break;
    }
    case "task.cancelled": {
      const reason = stringValue(payload, "reason") ?? stringValue(payload, "error");
      text = reason ? `A work step was cancelled: ${reason}` : "A work step was cancelled and is no longer running.";
      tone = "attention";
      break;
    }
    case "task.completed": {
      const summary = stringValue(payload, "resultSummary");
      text = summary ? `A work step finished: ${summary}` : "A work step finished.";
      tone = "success";
      break;
    }
    case "session.data": {
      text = "A worker is actively producing output.";
      tone = "active";
      break;
    }
    case "session.crashed": {
      const reason = stringValue(payload, "reason");
      text = reason ? `A worker session stopped unexpectedly: ${reason}` : "A worker session stopped unexpectedly; Chef needs to recover it.";
      tone = "attention";
      break;
    }
    case "orchestrator.plan.started": {
      text = "Chef is deciding how to approach this Mission.";
      tone = "active";
      break;
    }
    case "orchestrator.plan.proposed": {
      const routingMode = stringValue(payload, "routingMode");
      const count = stringArray(payload, "taskIds").length;
      if (routingMode === "single-worker") {
        text = "Chef chose one worker because this Mission fits one straightforward step.";
      } else if (routingMode === "planner") {
        text = count > 1
          ? `Chef used a coordinated plan because this Mission has ${count} steps.`
          : count === 1
            ? "Chef used planning because this Mission did not fit the bounded one-worker shortcut."
            : "Chef is using planning for this Mission; accepted steps are not available yet.";
      } else {
        text = count > 0
          ? `Chef prepared a plan with ${count} step${count === 1 ? "" : "s"}.`
          : "Chef prepared a Mission plan.";
      }
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
    case "orchestrator.plan.interrupted": {
      const status = stringValue(payload, "status");
      text = status
        ? `Mission execution was interrupted (${status}).`
        : "Mission execution was interrupted and needs attention.";
      tone = "attention";
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
    case "orchestrator.plan.none": {
      text = "Chef could not build a plan for this Mission.";
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

export function deriveMissionHeartbeat(
  events: UiRuntimeEvent[],
  missionId: string,
  taskIds: Iterable<string>,
  now = Date.now(),
  thresholdMs = HEARTBEAT_AFTER_MS,
): MissionProgressItem | null {
  const { ownedTaskIds, scoped } = scopeMissionEvents(events, missionId, taskIds);
  const latest = scoped[0];
  if (!latest) return null;

  const latestMissionStatus = scoped.find((event) => event.type === "mission.status");
  const latestTimeout = scoped.find((event) => event.type === "mission.timeout");
  if (latestTimeout && (!latestMissionStatus || latestTimeout.seq >= latestMissionStatus.seq)) return null;

  for (const blocker of scoped.filter(blocksHeartbeat)) {
    const clearingRecovery = scoped.find((event) =>
      event.seq > blocker.seq && recoveryClearsBlocker(event, blocker)
    );
    if (!clearingRecovery) return null;
  }

  const status = latestMissionStatus ? stringValue(objectPayload(latestMissionStatus), "status") : undefined;
  const label = status === "active" && allOwnedTasksCompleted(scoped, ownedTaskIds)
    ? "Chef is still verifying"
    : activeHeartbeatLabel(status) ?? (status === undefined ? inferredHeartbeatLabel(scoped) : null);
  if (!label) return null;

  const silentForMs = Math.max(0, now - latest.timestamp);
  if (silentForMs < thresholdMs) return null;
  const silentForSeconds = Math.max(1, Math.floor(silentForMs / 1_000));

  return {
    id: `heartbeat:${missionId}`,
    eventType: "mission.heartbeat",
    timestamp: now,
    text: `${label}. Last runtime activity was ${silentForSeconds} seconds ago.`,
    tone: "active",
  };
}

export function summarizeMissionProgressForMission(
  events: UiRuntimeEvent[],
  missionId: string,
  taskIds: Iterable<string>,
  limit = 3,
  now = Date.now(),
): MissionProgressItem[] {
  const { ownedTaskIds, scoped } = scopeMissionEvents(events, missionId, taskIds);
  const seenText = new Set<string>();
  const recent: MissionProgressItem[] = [];
  const heartbeat = deriveMissionHeartbeat(events, missionId, ownedTaskIds, now);

  if (heartbeat && limit > 0) {
    recent.push(heartbeat);
    seenText.add(heartbeat.text);
  }

  for (const event of scoped) {
    const item = summarizeMissionProgressEvent(event);
    if (!item || seenText.has(item.text)) continue;
    seenText.add(item.text);
    recent.push(item);
    if (recent.length === limit) break;
  }

  return recent;
}
