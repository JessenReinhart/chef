import type {
  CanvasNode,
  Mission,
  RuntimeEvent,
  Session,
  Task,
  WorkspaceSnapshot,
} from "../core/types.ts";

export type AgentPresenceStatus =
  | "offline"
  | "starting"
  | "idle"
  | "thinking"
  | "working"
  | "waiting"
  | "needs_input"
  | "waiting_for_approval"
  | "blocked"
  | "failed";

export interface AgentPresenceActivity {
  type: string;
  timestamp: number;
}

/**
 * Read-only projection for the UI. The durable source of truth remains the
 * canvas node, task, mission, session, approval, and event records.
 */
export interface AgentPresence {
  nodeId: string;
  workspaceId: string;
  name: string;
  role?: string;
  harnessId?: string;
  status: AgentPresenceStatus;
  currentTaskId?: string;
  currentObjective?: string;
  currentMissionId?: string;
  missionGoal?: string;
  currentSessionId?: string;
  sessionStatus?: Session["status"];
  needsAttention: boolean;
  lastActivity?: AgentPresenceActivity;
  updatedAt: number;
}

const TERMINAL_TASK_STATES = new Set<Task["status"]>(["completed", "cancelled"]);
const ATTENTION_STATES = new Set<AgentPresenceStatus>([
  "needs_input",
  "waiting_for_approval",
  "blocked",
  "failed",
]);

function latestByStartedAt(sessions: Session[]): Session | undefined {
  return [...sessions].sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))[0];
}

function latestRelevantEvent(
  snapshot: WorkspaceSnapshot,
  node: CanvasNode,
  task: Task | undefined,
  session: Session | undefined,
): RuntimeEvent | undefined {
  return [...snapshot.events]
    .filter((event) =>
      event.source.id === node.id
      || (node.harnessId !== null && event.source.id === node.harnessId)
      || (task !== undefined && event.taskId === task.id)
      || (session !== undefined && event.sessionId === session.id),
    )
    .sort((a, b) => b.seq - a.seq || b.timestamp - a.timestamp)[0];
}

function deriveStatus(
  node: CanvasNode,
  task: Task | undefined,
  session: Session | undefined,
  approvalPending: boolean,
): AgentPresenceStatus {
  if (approvalPending) return "waiting_for_approval";
  if (session?.status === "spawning") return "starting";
  if (session?.status === "running") return "working";

  if (task) {
    switch (task.status) {
      case "blocked":
        return "blocked";
      case "failed":
        return "failed";
      case "assigned":
        return "starting";
      case "running":
        return "working";
      case "cancelled":
        return "offline";
      case "completed":
        return "idle";
      case "pending":
        return node.liveStatus === "offline" ? "idle" : node.liveStatus;
    }
  }

  return node.liveStatus;
}

function currentMissionFor(task: Task | undefined, missions: Mission[]): Mission | undefined {
  if (!task?.missionId) return undefined;
  return missions.find((mission) => mission.id === task.missionId);
}

/**
 * Compose the persistent living-workspace records into one explainable agent
 * presence view. One durable canvas agent node always produces one presence
 * record, even when no task or process is currently alive.
 */
export function buildAgentPresence(snapshot: WorkspaceSnapshot): AgentPresence[] {
  const taskById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const pendingApprovalIds = new Set(
    snapshot.approvals.filter((approval) => approval.status === "pending").map((approval) => approval.id),
  );

  return snapshot.canvasNodes
    .filter((node) => node.kind === "agent")
    .map((node) => {
      const task = node.taskId ? taskById.get(node.taskId) : undefined;
      const taskSessions = task
        ? snapshot.sessions.filter((candidate) => candidate.taskId === task.id)
        : [];
      const session = latestByStartedAt(taskSessions);
      const mission = currentMissionFor(task, snapshot.missions);
      const approvalPending = task?.approvalId !== undefined && pendingApprovalIds.has(task.approvalId);
      const status = deriveStatus(node, task, session, approvalPending);
      const event = latestRelevantEvent(snapshot, node, task, session);
      const role = typeof node.config.role === "string" && node.config.role.trim().length > 0
        ? node.config.role.trim()
        : undefined;
      const taskIsCurrent = task !== undefined && !TERMINAL_TASK_STATES.has(task.status);
      const activeSession = session && (session.status === "spawning" || session.status === "running")
        ? session
        : undefined;

      return {
        nodeId: node.id,
        workspaceId: node.workspaceId,
        name: node.label,
        ...(role ? { role } : {}),
        ...(node.harnessId ? { harnessId: node.harnessId } : {}),
        status,
        ...(taskIsCurrent ? { currentTaskId: task.id, currentObjective: task.title } : {}),
        ...(taskIsCurrent && mission ? { currentMissionId: mission.id, missionGoal: mission.goal } : {}),
        ...(activeSession ? { currentSessionId: activeSession.id, sessionStatus: activeSession.status } : {}),
        needsAttention: ATTENTION_STATES.has(status),
        ...(event ? { lastActivity: { type: event.type, timestamp: event.timestamp } } : {}),
        updatedAt: Math.max(
          node.updatedAt,
          task?.updatedAt ?? 0,
          session?.endedAt ?? session?.startedAt ?? 0,
          event?.timestamp ?? 0,
        ),
      } satisfies AgentPresence;
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.nodeId.localeCompare(b.nodeId));
}
