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