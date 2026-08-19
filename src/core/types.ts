/**
 * Chef P0 — core runtime contracts.
 *
 * Type-only module: everything here is erased by Node's native type
 * stripping (`--experimental-strip-types`, Node >= 24). Only type aliases
 * and interfaces — no enums, namespaces, or parameter properties.
 *
 * Field names follow `AI_Engineering_OS_Specification_v0.1.pdf` reconciled
 * with the canonical contracts issued by the lead architect.
 */

import type { Approval, ApprovalDecision, ApprovalStatus } from "./approvals.ts";

export type { Approval, ApprovalDecision, ApprovalStatus };

// ---------------------------------------------------------------------------
// Identifier & time aliases
// ---------------------------------------------------------------------------

/** Identifier for any runtime entity (agent, task, artifact, ...). */
export type EntityId = string;

/** Logical worker identity capable of receiving tasks and producing results. */
export type AgentId = string;

export type WorkspaceId = string;
export type TaskId = string;
export type ApprovalId = string;
export type SessionId = string;
export type ArtifactId = string;
export type MessageId = string;
export type EventId = string;
export type PlanId = string;
export type MissionId = string;
export type AutomationId = string;
export type AutomationRunId = string;
export type ChannelId = string;

export type HarnessId = string;

/** Epoch milliseconds. */
export type Timestamp = number;

/** Typed reference to a runtime entity (used where provenance matters). */
export interface EntityRef {
  type: string;
  id: EntityId;
}

// ---------------------------------------------------------------------------
// Context (spec 8.3)
// ---------------------------------------------------------------------------

export type ContextReferenceType =
  | "artifact"
  | "event"
  | "message"
  | "task"
  | "decision"
  | "file";

export interface ContextReference {
  type: ContextReferenceType;
  id: EntityId;
  relevance?: number;
}

// ---------------------------------------------------------------------------
// Messages (spec 7.1)
// ---------------------------------------------------------------------------

export type AgentMessageType =
  | "message"
  | "task"
  | "request"
  | "response"
  | "result"
  | "question"
  | "status"
  | "escalation"
  | "artifact"
  | "approval";

export interface AgentMessage {
  id: MessageId;
  workspaceId: WorkspaceId;
  from: AgentId;
  to?: AgentId;
  channel?: ChannelId;
  type: AgentMessageType;
  payload: unknown;
  replyTo?: MessageId;
  contextRefs?: ContextReference[];
  correlationId?: string;
  timestamp: Timestamp;
}

// ---------------------------------------------------------------------------
// Events (spec 7.2) — immutable, append-only
// ---------------------------------------------------------------------------

export interface RuntimeEvent {
  id: EventId;
  workspaceId: WorkspaceId;
  /** Monotonic, workspace-scoped sequence number assigned by the runtime. */
  seq: number;
  timestamp: Timestamp;
  source: EntityRef;
  type: string;
  payload: unknown;
  taskId?: TaskId;
  sessionId?: SessionId;
  correlationId?: string;
}

// ---------------------------------------------------------------------------
// Tasks (spec 9.1)
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "pending"
  | "assigned"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface Task {
  id: TaskId;
  workspaceId: WorkspaceId;
  title: string;
  description: string;
  status: TaskStatus;
  assignedTo?: AgentId;
  parentTaskId?: TaskId;
  /** Owning goal-oriented mission, when this task was created from human intent. */
  missionId?: MissionId;
  /** Owning reusable automation definition/run, when automation-created. */
  automationId?: AutomationId;
  automationRunId?: AutomationRunId;
  dependencies: TaskId[];
  contextRefs: ContextReference[];
  priority: number;
  workflowNodeId?: string;
  approvalId?: ApprovalId;
  retryCount: number;
  error?: string;
  resultSummary?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Sessions (canonical)
// ---------------------------------------------------------------------------

export type SessionStatus =
  | "spawning"
  | "running"
  | "completed"
  | "crashed"
  | "terminated";

export interface Session {
  id: SessionId;
  workspaceId: WorkspaceId;
  harnessId: HarnessId;
  agentId: AgentId;
  taskId: TaskId;
  pid: number;
  status: SessionStatus;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  startedAt: Timestamp;
  endedAt?: Timestamp;
  exitCode?: number;
}

/** Backwards-compatible alias for the canonical `Session` record. */
export type SessionRecord = Session;

// ---------------------------------------------------------------------------
// Harness (spec 6.1)
// ---------------------------------------------------------------------------

export interface SpawnConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  shell?: boolean;
  workspaceId: WorkspaceId;
}

/** Sideband adapter events emitted by a harness (canonical discriminated union). */
export type HarnessEvent =
  | { type: "data"; data: string }
  | { type: "exit"; exitCode: number }
  | { type: "crash"; exitCode: number }
  | { type: "structured"; payload: unknown };

/** Live session handle returned by `Harness.spawn`. */
export interface HarnessSession {
  id: SessionId;
  harnessId: HarnessId;
  status: SessionStatus;
  pid?: number;
  startedAt: Timestamp;
}

export interface Harness {
  id: HarnessId;
  type: string;
  name: string;
  detect(): Promise<boolean>;
  spawn(config: SpawnConfig): Promise<HarnessSession>;
  send(sessionId: SessionId, input: string): Promise<void>;
  resize(sessionId: SessionId, cols: number, rows: number): Promise<void>;
  interrupt(sessionId: SessionId): Promise<void>;
  terminate(sessionId: SessionId): Promise<void>;
  kill(sessionId: SessionId): Promise<void>;
  events(sessionId: SessionId): AsyncIterable<HarnessEvent>;
}

// ---------------------------------------------------------------------------
// Artifacts (spec 10.1)
// ---------------------------------------------------------------------------

export type ArtifactType =
  | "file"
  | "document"
  | "code"
  | "image"
  | "research"
  | "result";

export interface Artifact {
  id: ArtifactId;
  workspaceId: WorkspaceId;
  type: ArtifactType;
  name: string;
  uri: string;
  version: number;
  createdBy: EntityId;
  taskId?: TaskId;
  sessionId?: SessionId;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Decisions (spec 10.3) & decision provider (canonical)
// ---------------------------------------------------------------------------

export type DecisionStatus = "proposed" | "accepted" | "rejected";

export interface Decision {
  id: EntityId;
  workspaceId: WorkspaceId;
  type: string;
  summary: string;
  payload: unknown;
  madeBy: EntityId;
  timestamp: Timestamp;
  status: DecisionStatus;
}

export interface PlanProposalContext {
  workspaceId: WorkspaceId;
  goal: string;
  contextRefs?: ContextReference[];
  events?: RuntimeEvent[];
}

export interface PlanTaskOutcome {
  taskId: TaskId;
  status: TaskStatus;
  resultSummary?: string;
  error?: string;
}

export interface DecisionProvider {
  readonly name: string;
  proposePlan(input: PlanProposalContext): Promise<Plan | null>;
  evaluate(taskResult: PlanTaskOutcome): Promise<Decision>;
}

// ---------------------------------------------------------------------------
// Plans (spec 5.4) & orchestrator (canonical)
// ---------------------------------------------------------------------------

export type PlanStatus =
  | "draft"
  | "proposed"
  | "approved"
  | "executing"
  | "completed"
  | "failed";

export interface PlanTask {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  priority: number;
  assignedTo?: AgentId;
  /** Durable approval request id: the task holds until the human resolves it. */
  approvalId?: ApprovalId;
}

export interface Plan {
  id: PlanId;
  workspaceId: WorkspaceId;
  goal: string;
  missionId?: MissionId;
  status: PlanStatus;
  tasks: PlanTask[];
  taskIds: TaskId[];
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

// ---------------------------------------------------------------------------
// Missions & Automations (product/runtime spec v0.2)
// ---------------------------------------------------------------------------

export type MissionStatus =
  | "planning"
  | "active"
  | "paused"
  | "waiting_for_approval"
  | "blocked"
  | "verifying"
  | "completed"
  | "cancelled"
  | "failed";

/** Durable goal-oriented work created from human intent. */
export interface Mission {
  id: MissionId;
  workspaceId: WorkspaceId;
  goal: string;
  status: MissionStatus;
  taskIds: TaskId[];
  planId?: PlanId;
  createdBy: EntityId;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  completedAt?: Timestamp;
}

export type AutomationStatus = "idle" | "running" | "stopped" | "disabled";
export type AutomationRunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface AutomationGraphEdge {
  source: string;
  target: string;
  type: "dependency" | "control" | "error" | "approval";
}

/** Reusable executable graph. Run/Stop is scoped to this object, never the workspace. */
export interface Automation {
  id: AutomationId;
  workspaceId: WorkspaceId;
  name: string;
  description: string;
  status: AutomationStatus;
  nodeIds: string[];
  edges: AutomationGraphEdge[];
  trigger: Record<string, unknown>;
  currentRunId?: AutomationRunId;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AutomationRun {
  id: AutomationRunId;
  workspaceId: WorkspaceId;
  automationId: AutomationId;
  status: AutomationRunStatus;
  taskIds: TaskId[];
  startedAt: Timestamp;
  endedAt?: Timestamp;
  error?: string;
}

export interface OrchestratorResult {
  workspaceId: WorkspaceId;
  taskIds: TaskId[];
  report: string;
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Canvas graph (spec 5.4) — durable orchestrator-owned blueprint graph
// ---------------------------------------------------------------------------

export type CanvasNodeType = "blueprint" | "proxy";
export type CanvasNodeKind = "agent" | "tool" | "data" | "approval" | "system";
export type CanvasNodeLiveStatus = "offline" | "starting" | "idle" | "working" | "waiting" | "blocked" | "needs_input" | "failed";
export type CanvasEdgeType =
  | "communication"
  | "context"
  | "delegation"
  | "dependency"
  | "control"
  | "error"
  | "approval";

/** Durable blueprint canvas node exposed via runtime API. */
export interface CanvasNode {
  id: string;
  workspaceId: WorkspaceId;
  taskId: string | null;
  label: string;
  nodeType: CanvasNodeType;
  kind: CanvasNodeKind;
  harnessId: string | null;
  liveStatus: CanvasNodeLiveStatus;
  config: Record<string, unknown>;
  position: { x: number; y: number };
  updatedAt: Timestamp;
}

/** Durable blueprint canvas edge. */
export interface CanvasEdge {
  id: string;
  workspaceId: WorkspaceId;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  /** Only dependency/control/approval edges imply ordering. */
  type: CanvasEdgeType;
  updatedAt: Timestamp;
}

export interface CanvasNodeInput {
  id: string;
  taskId?: string | null;
  label: string;
  nodeType?: CanvasNodeType;
  kind?: CanvasNodeKind;
  harnessId?: string | null;
  liveStatus?: CanvasNodeLiveStatus;
  config?: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface CanvasPatch {
  upsertNodes?: CanvasNodeInput[];
  upsertEdges?: Array<{ source: string; target: string; type?: CanvasEdgeType; sourceHandle?: string | null; targetHandle?: string | null }>;
  deleteEdges?: Array<{ source: string; target: string; type?: CanvasEdgeType }>;
  deleteNodes?: string[];
  arrange?: { mode: "columns" | "snake" | "radial" };
}

export interface CanvasPatchResult {
  ok: boolean;
  error?: string;
  nodes?: CanvasNode[];
  edges?: CanvasEdge[];
}

export interface ContextZoneBounds { x: number; y: number; width: number; height: number; }
export interface ContextZone {
  id: string;
  workspaceId: WorkspaceId;
  name: string;
  bounds: ContextZoneBounds;
  contextRefs: ContextReference[];
  /** Explicit persisted membership; moving geometry never mutates this list. */
  memberNodeIds: string[];
  policy: Record<string, unknown>;
  updatedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Workspace state (spec 5.4 inspectState)
// ---------------------------------------------------------------------------

export interface WorkspaceSnapshot {
  workspaceId: WorkspaceId;
  tasks: Task[];
  sessions: Session[];
  artifacts: Artifact[];
  decisions: Decision[];
  events: RuntimeEvent[];
  plans: Plan[];
  missions: Mission[];
  automations: Automation[];
  automationRuns: AutomationRun[];
  approvals: Approval[];
  canvasNodes: CanvasNode[];
  canvasEdges: CanvasEdge[];
  contextZones: ContextZone[];
  generatedAt: Timestamp;
}
