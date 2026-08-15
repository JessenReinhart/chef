/**
 * Chef P0 — UI-independent node contracts (spec §12).
 *
 * The node registry is the shared contract for all workflows (Simple Mode,
 * Power Mode, templates, chat-generated plans). It must be UI-independent,
 * typed, and executable through the existing runtime.
 */

import type {
  Artifact,
  ContextReference,
  EntityRef,
  Harness,
  RuntimeEvent,
  SessionId,
  TaskId,
  WorkspaceId,
} from "./types.ts";
import type { Approval, ApprovalDecision, ApprovalStatus } from "./approvals.ts";

export type {
  Artifact,
  ContextReference,
  EntityRef,
  Harness,
  RuntimeEvent,
  SessionId,
  TaskId,
  WorkspaceId,
} from "./types.ts";
export type { Approval, ApprovalDecision, ApprovalStatus } from "./approvals.ts";

export type NodeCategory = "agent" | "tool" | "control" | "workflow" | "human";
export type NodeStatus =
  | "idle"
  | "ready"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface PortDefinition {
  id: string;
  label: string;
  type: "data" | "control" | "conditional" | "error" | "approval";
  required: boolean;
  description?: string;
}

export interface ConfigSchema<TConfig = unknown> {
  validate(config: unknown): TConfig;
  defaults(): Partial<TConfig>;
}

export interface NodeDefinition<TConfig = unknown> {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;
  inputs: readonly PortDefinition[];
  outputs: readonly PortDefinition[];
  config: ConfigSchema<TConfig>;
  execute(ctx: NodeExecutionContext<TConfig>): Promise<NodeExecutionResult>;
}

export interface NodeExecutionContext<TConfig = unknown> {
  taskId: TaskId;
  workspaceId: WorkspaceId;
  config: TConfig;
  inputs: Record<string, unknown>;
  artifacts: Artifact[];
  contextRefs: ContextReference[];
  harness: Harness;
  sessionId: SessionId;
  runtime: {
    emitEvent: (event: RuntimeEvent) => void;
    createArtifact: (artifact: Artifact) => Promise<Artifact>;
    requestApproval: (approval: Approval) => Promise<ApprovalDecision>;
  };
}

export interface NodeExecutionResult {
  status: NodeStatus;
  outputs: Record<string, unknown>;
  artifacts: Artifact[];
  events: RuntimeEvent[];
  nextNodeHints?: string[];
}