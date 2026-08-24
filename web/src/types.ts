/**
 * Chef Web UI — shared type contracts.
 * Mirrors the runtime's WorkspaceSnapshot / Task / Template types
 * but stays lightweight for the projection layer.
 */

export type NodeStatus =
  | "pending"
  | "assigned"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "spawning";

export type ViewMode = "simple" | "power";

export type EdgeRelationship =
  | "communication"
  | "context"
  | "delegation"
  | "dependency"
  | "control"
  | "error"
  | "approval";

export type MissionStatus =
  | "planning"
  | "active"
  | "paused"
  | "waiting_for_approval"
  | "blocked"
  | "verifying"
  | "completed"
  | "cancelled"
  | "failed"
  | "idle";

export interface UiMission {
  id: string;
  goal: string;
  status: Exclude<MissionStatus, "idle">;
  taskIds: string[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface UiAutomation {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  status: "idle" | "running" | "stopped" | "disabled";
  nodeIds: string[];
  edges: Array<{ source: string; target: string; type: "dependency" | "control" | "error" | "approval" }>;
  currentRunId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface UiAutomationRun {
  id: string;
  automationId: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  taskIds: string[];
  startedAt: number;
  endedAt?: number;
}

export interface UiRuntimeEvent {
  id: string;
  seq: number;
  timestamp: number;
  source: { type: string; id: string };
  type: string;
  payload: unknown;
  taskId?: string;
  sessionId?: string;
  correlationId?: string;
}

export type NodeKind = "agent" | "tool" | "control" | "workflow" | "human";

export interface UiTask {
  id: string;
  title: string;
  description: string;
  status: NodeStatus;
  assignedTo?: string;
  workflowNodeId?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
  contextRefs?: ContextReference[];
}

export interface UiEdge {
  source: string;
  target: string;
}

export interface UiGraph {
  nodes: UiTask[];
  edges: UiEdge[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  taskId?: string;
  type?: string;
  metadata?: Record<string, unknown>;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    config: Record<string, unknown>;
  }>;
  metadata?: {
    category?: string;
    estimatedDuration?: string;
    tags?: string[];
  };
}

export interface ApiError {
  ok: false;
  error: string;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface HarnessInfo {
  id: string;
  name: string;
  type: string;
  available: boolean;
}

/** LLM decision-provider status — mirrors server runtime.llmStatus. */
export interface LlmStatus {
  configured: boolean;
  provider: string | null;
  model: string | null;
}

export interface NodeCatalogEntry {
  type: string;
  label: string;
  description: string;
  category: "Agents" | "Tools" | "Flow" | "Data" | "Human";
  kind: NodeKind;
  accent: string;
  harnessId?: string;
  icon?: string;
}

/** Canvas graph types — mirrors server CanvasNode/CanvasEdge from core/types.ts */
export type CanvasNodeType = "blueprint" | "proxy";
export type CanvasNodeKind = "agent" | "tool" | "data" | "approval" | "system";
export type CanvasNodeLiveStatus = "offline" | "starting" | "idle" | "working" | "waiting" | "blocked" | "needs_input" | "failed";

export interface UiCanvasNode {
  id: string;
  workspaceId: string;
  taskId: string | null;
  label: string;
  nodeType: CanvasNodeType;
  kind: CanvasNodeKind;
  harnessId: string | null;
  liveStatus?: CanvasNodeLiveStatus;
  config?: Record<string, unknown>;
  position: { x: number; y: number };
  updatedAt: number;
}

export interface UiCanvasEdge {
  id: string;
  workspaceId: string;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  /** v0.2 relationship semantics; absent records are communication links. */
  type?: EdgeRelationship;
  updatedAt: number;
}

export interface CanvasNodeInput {
  id: string;
  taskId?: string | null;
  label: string;
  nodeType?: CanvasNodeType;
  kind?: CanvasNodeKind;
  harnessId?: string | null;
  position?: { x: number; y: number };
  config?: Record<string, unknown>;
}

export interface CanvasPatch {
  upsertNodes?: CanvasNodeInput[];
  upsertEdges?: Array<{
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
    type?: EdgeRelationship;
  }>;
  deleteEdges?: Array<{ source: string; target: string; type?: EdgeRelationship }>;
  deleteNodes?: string[];
  arrange?: { mode: "columns" | "snake" | "radial" };
}

export interface CanvasPatchResult {
  ok: boolean;
  error?: string;
  nodes?: UiCanvasNode[];
  edges?: UiCanvasEdge[];
}

export interface ContextReference {
  type: string;
  id: string;
  relevance?: number;
}

export interface ContextZone {
  id: string;
  workspaceId: string;
  name: string;
  bounds: { x: number; y: number; width: number; height: number };
  contextRefs: ContextReference[];
  memberNodeIds: string[];
}

export interface ContextZoneInput {
  name: string;
  bounds: ContextZone["bounds"];
  contextRefs: ContextReference[];
  /** Explicit membership is authoritative after creation; bounds are presentation. */
  memberNodeIds: string[];
}

export interface AutomationControl {
  id: string;
  name: string;
  status: "idle" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  nodeId?: string;
}
