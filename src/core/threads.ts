import type { Timestamp, WorkspaceId } from "./types.ts";

/** Durable conversation/work-stream identity within one workspace. */
export type ThreadId = string;

export type ThreadStatus = "active" | "archived";

/**
 * A Thread is the durable continuity boundary between a Project and Missions.
 * Worker Session remains reserved for runtime execution.
 */
export interface Thread {
  id: ThreadId;
  workspaceId: WorkspaceId;
  title: string;
  status: ThreadStatus;
  summary?: string;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
