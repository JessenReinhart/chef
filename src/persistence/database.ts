/**
 * Chef P0 — SQLite persistence layer.
 *
 * Implements the canonical contracts issued by the lead architect, backed by
 * `node:sqlite` (DatabaseSync). The schema is applied idempotently from
 * `schema.sql` on construction. The Repository is the ONLY writer to the
 * database — the Runtime and Orchestrator mutate state exclusively through
 * the methods exposed here.
 *
 * State changes and event appends are composable via `transaction()` so a
 * caller can atomically persist a transition (e.g. task status update) and
 * its corresponding runtime event.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import type {
  AgentMessage,
  AgentMessageType,
  Approval,
  ApprovalDecision,
  ApprovalStatus,
  Artifact,
  ArtifactType,
  CanvasEdge,
  CanvasNode,
  ContextReference,
  Decision,
  DecisionStatus,
  EntityId,
  EntityRef,
  Plan,
  PlanId,
  PlanStatus,
  PlanTask,
  RuntimeEvent,
  Session,
  SessionStatus,
  Task,
  TaskId,
  TaskStatus,
  Timestamp,
  WorkspaceId,
  WorkspaceSnapshot,
} from "../core/types.ts";

// ---------------------------------------------------------------------------
// Persistence entity types
//
// `Workspace`, `Project`, `Agent`, and `Harness` are not yet declared in
// `core/types.ts`. They are defined here, local to the persistence layer, so
// this module stays within its file scope. They mirror the spec tables
// (spec 15.1) and the canonical workspace/project/agent/harness contracts.
// ---------------------------------------------------------------------------

export interface Workspace {
  id: WorkspaceId;
  name: string;
  rootPath?: string;
  settings: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Project {
  id: EntityId;
  workspaceId: WorkspaceId;
  name: string;
  rootPath: string;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Agent {
  id: EntityId;
  workspaceId: WorkspaceId;
  name: string;
  role?: string;
  config: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Harness {
  id: EntityId;
  workspaceId: WorkspaceId;
  type: string;
  name: string;
  config: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** UI workflow template (spec §13: node canvas templates). */
export interface Template {
  id: EntityId;
  workspaceId: WorkspaceId;
  name: string;
  description: string;
  /** Serialized canvas nodes: [{ id, type, title, position }] */
  nodes: unknown[];
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Input shapes (ids and timestamps are optional; auto-generated when omitted)
// ---------------------------------------------------------------------------

export interface WorkspaceInput {
  id?: WorkspaceId;
  name: string;
  rootPath?: string;
  settings?: Record<string, unknown>;
}
export interface ProjectInput {
  id?: EntityId;
  workspaceId: WorkspaceId;
  name: string;
  rootPath: string;
  metadata?: Record<string, unknown>;
}

export interface AgentInput {
  id?: EntityId;
  workspaceId: WorkspaceId;
  name: string;
  role?: string;
  config?: Record<string, unknown>;
}

export interface HarnessInput {
  id?: EntityId;
  workspaceId: WorkspaceId;
  type: string;
  name: string;
  config?: Record<string, unknown>;
}

export interface TemplateInput {
  id?: EntityId;
  workspaceId: WorkspaceId;
  name: string;
  description?: string;
  nodes?: unknown[];
  metadata?: Record<string, unknown>;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface TaskInput {
  id?: TaskId;
  workspaceId: WorkspaceId;
  title: string;
  description: string;
  status: TaskStatus;
  assignedTo?: EntityId;
  parentTaskId?: TaskId;
  approvalId?: string;
  dependencies?: TaskId[];
  contextRefs?: ContextReference[];
  priority?: number;
  workflowNodeId?: string;
  retryCount?: number;
  error?: string;
  resultSummary?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface ApprovalInput {
  id?: string;
  workspaceId: WorkspaceId;
  taskId: TaskId;
  status: ApprovalStatus;
  requester: string;
  approver?: string;
  reason: string;
  createdAt?: Timestamp;
  resolvedAt?: Timestamp;
}

export interface SessionInput {
  id?: string;
  workspaceId: WorkspaceId;
  harnessId: EntityId;
  agentId: EntityId;
  taskId: TaskId;
  pid?: number;
  status: SessionStatus;
  command: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
  startedAt?: Timestamp;
  endedAt?: Timestamp;
  exitCode?: number;
}

export interface EventInput {
  id?: string;
  workspaceId: WorkspaceId;
  seq?: number; // ignored — always assigned by the repository
  timestamp?: Timestamp;
  source: EntityRef;
  type: string;
  payload?: unknown;
  taskId?: TaskId;
  sessionId?: string;
  correlationId?: string;
}

export interface MessageInput {
  id?: string;
  workspaceId: WorkspaceId;
  from: EntityId;
  to?: EntityId;
  channel?: string;
  type: AgentMessageType;
  payload: unknown;
  replyTo?: string;
  contextRefs?: ContextReference[];
  correlationId?: string;
  timestamp?: Timestamp;
}

export interface ArtifactInput {
  id?: string;
  workspaceId: WorkspaceId;
  type: ArtifactType;
  name: string;
  uri: string;
  version?: number;
  createdBy: EntityId;
  taskId?: TaskId;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}
export interface PlanInput {
  id?: PlanId;
  workspaceId: WorkspaceId;
  goal: string;
  status: PlanStatus;
  tasks: PlanTask[];
  taskIds: TaskId[];
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCHEMA_PATH = fileURLToPath(new URL("./schema.sql", import.meta.url));

function now(): Timestamp {
  return Date.now();
}

function readJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === "") return fallback;
  return JSON.parse(raw) as T;
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

// ---------------------------------------------------------------------------
// Row mappers (SQLite row -> typed entity)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function mapWorkspace(row: Row): Workspace {
  return {
    id: row.id as string,
    name: row.name as string,
    rootPath: (row.root_path as string | null) ?? undefined,
    settings: readJson(row.settings_json as string, {}),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function mapProject(row: Row): Project {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    rootPath: row.root_path as string,
    metadata: readJson(row.metadata_json as string, {}),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function mapAgent(row: Row): Agent {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    role: (row.role as string | null) ?? undefined,
    config: readJson(row.config_json as string, {}),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function mapHarness(row: Row): Harness {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    type: row.type as string,
    name: row.name as string,
    config: readJson(row.config_json as string, {}),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function mapTemplate(row: Row): Template {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    description: row.description as string,
    nodes: readJson(row.nodes_json as string, [] as unknown[]),
    metadata: readJson(row.metadata_json as string, {}),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function mapTask(row: Row): Task {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    title: row.title as string,
    description: row.description as string,
    status: row.status as TaskStatus,
    assignedTo: (row.assigned_to as string | null) ?? undefined,
    parentTaskId: (row.parent_task_id as string | null) ?? undefined,
    approvalId: (row.approval_id as string | null) ?? undefined,
    dependencies: [], // resolved relationally by callers (getTask, snapshot)
    contextRefs: readJson(row.context_refs_json as string, [] as ContextReference[]),
    priority: row.priority as number,
    workflowNodeId: (row.workflow_node_id as string | null) ?? undefined,
    retryCount: row.retry_count as number,
    error: (row.error as string | null) ?? undefined,
    resultSummary: (row.result_summary as string | null) ?? undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function mapApproval(row: Row): Approval {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    taskId: row.task_id as string,
    status: row.status as ApprovalStatus,
    requester: row.requester as string,
    approver: (row.approver as string | null) ?? undefined,
    reason: row.reason as string,
    createdAt: row.created_at as number,
    resolvedAt: (row.resolved_at as number | null) ?? undefined,
  };
}

function mapSession(row: Row): Session {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    harnessId: row.harness_id as string,
    agentId: row.agent_id as string,
    taskId: row.task_id as string,
    pid: row.pid as number,
    status: row.status as SessionStatus,
    command: row.command as string,
    args: readJson(row.args_json as string, [] as string[]),
    cwd: row.cwd as string,
    cols: row.cols as number,
    rows: row.rows as number,
    startedAt: row.started_at as number,
    endedAt: (row.ended_at as number | null) ?? undefined,
    exitCode: (row.exit_code as number | null) ?? undefined,
  };
}

function mapMessage(row: Row): AgentMessage {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    from: row.from_agent as string,
    to: (row.to_agent as string | null) ?? undefined,
    channel: (row.channel as string | null) ?? undefined,
    type: row.type as AgentMessageType,
    payload: readJson(row.payload_json as string, undefined),
    replyTo: (row.reply_to as string | null) ?? undefined,
    contextRefs: readJson(row.context_refs_json as string, [] as ContextReference[]),
    correlationId: (row.correlation_id as string | null) ?? undefined,
    timestamp: row.timestamp as number,
  };
}

function mapEvent(row: Row): RuntimeEvent {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    seq: row.seq as number,
    timestamp: row.timestamp as number,
    source: { type: row.source_type as string, id: row.source_id as string },
    type: row.type as string,
    payload: readJson(row.payload_json as string, undefined),
    taskId: (row.task_id as string | null) ?? undefined,
    sessionId: (row.session_id as string | null) ?? undefined,
    correlationId: (row.correlation_id as string | null) ?? undefined,
  };
}

function mapArtifact(row: Row): Artifact {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    type: row.type as ArtifactType,
    name: row.name as string,
    uri: row.uri as string,
    version: row.version as number,
    createdBy: row.created_by as string,
    taskId: (row.task_id as string | null) ?? undefined,
    sessionId: (row.session_id as string | null) ?? undefined,
    metadata: readJson(row.metadata_json as string, {}),
  };
}

function mapDecision(row: Row): Decision {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    type: row.type as string,
    summary: row.summary as string,
    payload: readJson(row.payload_json as string, undefined),
    madeBy: row.made_by as string,
    timestamp: row.timestamp as number,
    status: row.status as DecisionStatus,
  };
}

function mapPlan(row: Row): Plan {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    goal: row.goal as string,
    status: row.status as PlanStatus,
    tasks: readJson(row.tasks_json as string, [] as PlanTask[]),
    taskIds: readJson(row.task_ids_json as string, [] as TaskId[]),
    createdAt: row.created_at as number,
    updatedAt: (row.updated_at as number | null) ?? undefined,
  };
}

/** Durable blueprint canvas node (spec §5.4 nodes). */
export interface CanvasNodeRecord {
  id: string;
  workspaceId: WorkspaceId;
  taskId: string | null;
  label: string;
  nodeType: "blueprint" | "proxy";
  kind: string;
  harnessId: string | null;
  positionX: number;
  positionY: number;
  updatedAt: Timestamp;
}

/** Durable blueprint canvas edge (spec §5.4 edges). */
export interface CanvasEdgeRecord {
  id: string;
  workspaceId: WorkspaceId;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  updatedAt: Timestamp;
}

function mapCanvasNode(row: Row): CanvasNodeRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    taskId: row.task_id == null ? null : String(row.task_id),
    label: String(row.label),
    nodeType: row.node_type === "proxy" ? "proxy" : "blueprint",
    kind: String(row.kind),
    harnessId: row.harness_id == null ? null : String(row.harness_id),
    positionX: Number(row.position_x),
    positionY: Number(row.position_y),
    updatedAt: Number(row.updated_at),
  };
}

function mapCanvasEdge(row: Row): CanvasEdgeRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    source: String(row.source),
    target: String(row.target),
    sourceHandle: row.source_handle == null ? null : String(row.source_handle),
    targetHandle: row.target_handle == null ? null : String(row.target_handle),
    updatedAt: Number(row.updated_at),
  };
}

function mapCanvasNodeRecord(rec: CanvasNodeRecord): CanvasNode {
  return {
    id: rec.id,
    workspaceId: rec.workspaceId,
    taskId: rec.taskId,
    label: rec.label,
    nodeType: rec.nodeType,
    kind: rec.kind as CanvasNode["kind"],
    harnessId: rec.harnessId,
    position: { x: rec.positionX, y: rec.positionY },
    updatedAt: rec.updatedAt,
  };
}

function mapCanvasEdgeRecord(rec: CanvasEdgeRecord): CanvasEdge {
  return {
    id: rec.id,
    workspaceId: rec.workspaceId,
    source: rec.source,
    target: rec.target,
    sourceHandle: rec.sourceHandle,
    targetHandle: rec.targetHandle,
    updatedAt: rec.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class Repository {
  readonly db: DatabaseSync;

  /** Opens (or creates) the SQLite database at `dbPath` and applies the
   *  schema idempotently. Parent directories are created on demand. */
  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  /** Runs `fn` inside a single SQLite transaction, committing on success and
   *  rolling back on throw. State changes and event appends composed within
   *  `fn` are therefore atomic. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Workspace & identity
  // -------------------------------------------------------------------------

  createWorkspace(input: WorkspaceInput | string): Workspace {
    const resolved: WorkspaceInput =
      typeof input === "string" ? { name: input } : input;
    const id = resolved.id ?? randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, root_path, settings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        resolved.name,
        resolved.rootPath ?? null,
        toJson(resolved.settings ?? {}),
        ts,
        ts,
      );
    return this.getWorkspace(id)!;
  }

  /** Returns the id of the single workspace seeded into this database,
   *  or `null` when none exists. Useful for a single-workspace runtime. */
  getWorkspaceId(): WorkspaceId | null {
    const row = this.db
      .prepare(`SELECT id FROM workspaces ORDER BY rowid LIMIT 1`)
      .get() as { id: WorkspaceId } | undefined;
    return row?.id ?? null;
  }

  getWorkspace(id: WorkspaceId): Workspace | null {
    const row = this.db
      .prepare(`SELECT * FROM workspaces WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? mapWorkspace(row) : null;
  }

  insertProject(input: ProjectInput): Project {
    const id = input.id ?? randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO projects (id, workspace_id, name, root_path, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.name,
        input.rootPath,
        toJson(input.metadata ?? {}),
        ts,
        ts,
      );
    return this.getProject(id)!;
  }

  getProject(id: EntityId): Project | null {
    const row = this.db
      .prepare(`SELECT * FROM projects WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? mapProject(row) : null;
  }

  listProjects(workspaceId: WorkspaceId): Project[] {
    return (
      this.db
        .prepare(`SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at`)
        .all(workspaceId) as Row[]
    ).map(mapProject);
  }

  seedAgent(input: AgentInput): Agent {
    const id = input.id ?? randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO agents (id, workspace_id, name, role, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.workspaceId, input.name, input.role ?? null, toJson(input.config ?? {}), ts, ts);
    const row = this.db
      .prepare(`SELECT * FROM agents WHERE id = ?`)
      .get(id) as Row;
    return mapAgent(row);
  }

  seedHarness(input: HarnessInput): Harness {
    const id = input.id ?? randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO harnesses (id, workspace_id, type, name, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.workspaceId, input.type, input.name, toJson(input.config ?? {}), ts, ts);
    const row = this.db
      .prepare(`SELECT * FROM harnesses WHERE id = ?`)
      .get(id) as Row;
    return mapHarness(row);
  }

  // -------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------

  insertPlan(input: PlanInput): Plan {
    const id = input.id ?? randomUUID();
    const ts = now();
    const createdAt = input.createdAt ?? ts;
    const updatedAt = input.updatedAt ?? ts;
    this.db
      .prepare(
        `INSERT INTO plans (
           id, workspace_id, goal, status, tasks_json, task_ids_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.goal,
        input.status,
        toJson(input.tasks),
        toJson(input.taskIds),
        createdAt,
        updatedAt,
      );
    return this.getPlan(id)!;
  }

  getPlan(id: PlanId): Plan | null {
    const row = this.db.prepare(`SELECT * FROM plans WHERE id = ?`).get(id) as Row | undefined;
    return row ? mapPlan(row) : null;
  }

  listPlans(workspaceId: WorkspaceId): Plan[] {
    return (
      this.db
        .prepare(`SELECT * FROM plans WHERE workspace_id = ? ORDER BY created_at, id`)
        .all(workspaceId) as Row[]
    ).map(mapPlan);
  }

  updatePlanStatus(id: PlanId, status: PlanStatus): Plan {
    const current = this.getPlan(id);
    if (!current) throw new Error(`Plan not found: ${id}`);
    this.db
      .prepare(`UPDATE plans SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, now(), id);
    return this.getPlan(id)!;
    return this.getPlan(id)!;
  }

  getWorkspaceSnapshot(workspaceId: WorkspaceId): WorkspaceSnapshot {
    // All five collection reads happen inside one read transaction so a
    // snapshot is a single consistent cut even when another process shares
    // the database file (multi-connection deployments).
    this.db.exec("BEGIN");
    try {
      const tasks = (
        this.db.prepare(`SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at, id`).all(workspaceId) as Row[]
      ).map((row) => this.withTaskDependencies(mapTask(row)));
      const sessions = (
        this.db.prepare(`SELECT * FROM sessions WHERE workspace_id = ? ORDER BY started_at, id`).all(workspaceId) as Row[]
      ).map(mapSession);
      const artifacts = (
        this.db.prepare(`SELECT * FROM artifacts WHERE workspace_id = ? ORDER BY rowid`).all(workspaceId) as Row[]
      ).map(mapArtifact);
      const decisions = (
        this.db.prepare(`SELECT * FROM decisions WHERE workspace_id = ? ORDER BY timestamp, id`).all(workspaceId) as Row[]
      ).map(mapDecision);
      const events = (
        this.db.prepare(`SELECT * FROM events WHERE workspace_id = ? ORDER BY seq`).all(workspaceId) as Row[]
      ).map(mapEvent);
      const plans = (
        this.db.prepare(`SELECT * FROM plans WHERE workspace_id = ? ORDER BY created_at, id`).all(workspaceId) as Row[]
      ).map(mapPlan);
      const approvals = (
        this.db.prepare(`SELECT * FROM approvals WHERE workspace_id = ? ORDER BY created_at, id`).all(workspaceId) as Row[]
      ).map(mapApproval);
      const canvasNodes = (
        this.db.prepare(`SELECT * FROM canvas_nodes WHERE workspace_id = ? ORDER BY id`).all(workspaceId) as Row[]
      ).map(mapCanvasNode);
      const canvasEdges = (
        this.db.prepare(`SELECT * FROM canvas_edges WHERE workspace_id = ? ORDER BY id`).all(workspaceId) as Row[]
      ).map(mapCanvasEdge);




      const snapshot = {
        workspaceId,
        tasks,
        sessions,
        artifacts,
        decisions,
        events,
        plans,
        approvals,
        canvasNodes: canvasNodes.map(mapCanvasNodeRecord),
        canvasEdges: canvasEdges.map(mapCanvasEdgeRecord),
        generatedAt: now(),
      };
      this.db.exec("COMMIT");
      return snapshot;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  insertTask(input: TaskInput): Task {
    const id = input.id ?? randomUUID();
    const ts = now();
    const createdAt = input.createdAt ?? ts;
    const updatedAt = input.updatedAt ?? ts;
    this.db
      .prepare(
        `INSERT INTO tasks (
           id, workspace_id, title, description, status, assigned_to, parent_task_id,
           approval_id, context_refs_json, priority, workflow_node_id, retry_count, error,
           result_summary, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.title,
        input.description,
        input.status,
        input.assignedTo ?? null,
        input.parentTaskId ?? null,
        input.approvalId ?? null,
        toJson(input.contextRefs ?? []),
        input.priority ?? 0,
        input.workflowNodeId ?? null,
        input.retryCount ?? 0,
        input.error ?? null,
        input.resultSummary ?? null,
        createdAt,
        updatedAt,
      );

    const dependencies = input.dependencies ?? [];
    if (dependencies.length > 0) {
      const stmt = this.db.prepare(
        `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`,
      );
      for (const dep of dependencies) {
        stmt.run(id, dep);
      }
    }

    return this.getTask(id)!;
  }

  updateTask(id: TaskId, patch: Partial<TaskInput>): Task {
    const current = this.getTask(id);
    if (!current) {
      throw new Error(`Task not found: ${id}`);
    }

    const next = {
      title: patch.title ?? current.title,
      description: patch.description ?? current.description,
      status: patch.status ?? current.status,
      assignedTo: patch.assignedTo !== undefined ? patch.assignedTo : current.assignedTo,
      parentTaskId: patch.parentTaskId !== undefined ? patch.parentTaskId : current.parentTaskId,
      priority: patch.priority ?? current.priority,
      workflowNodeId: patch.workflowNodeId !== undefined ? patch.workflowNodeId : current.workflowNodeId,
      approvalId: patch.approvalId !== undefined ? patch.approvalId : current.approvalId,
      retryCount: patch.retryCount ?? current.retryCount,
      error: patch.error !== undefined ? patch.error : current.error,
      resultSummary: patch.resultSummary !== undefined ? patch.resultSummary : current.resultSummary,
    };

    const updatedAt = patch.updatedAt ?? now();
    this.db
      .prepare(
        `UPDATE tasks SET
           title = ?, description = ?, status = ?, assigned_to = ?, parent_task_id = ?, approval_id = ?,
           priority = ?, workflow_node_id = ?, retry_count = ?, error = ?,
           result_summary = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.title,
        next.description,
        next.status,
        next.assignedTo ?? null,
        next.parentTaskId ?? null,
        next.approvalId ?? null,
        next.priority,
        next.workflowNodeId ?? null,
        next.retryCount,
        next.error ?? null,
        next.resultSummary ?? null,
        updatedAt,
        id,
      );

    // Reconcile dependencies when the patch explicitly provides them.
    if (patch.dependencies !== undefined) {
      this.db.prepare(`DELETE FROM task_dependencies WHERE task_id = ?`).run(id);
      const stmt = this.db.prepare(
        `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`,
      );
      for (const dep of patch.dependencies) {
        stmt.run(id, dep);
      }
    }

    return this.getTask(id)!;
  }

  /** Replace a task's resolved context references (canvas-edge derived). */
  updateTaskContextRefs(id: TaskId, contextRefs: ContextReference[]): Task {
    const current = this.getTask(id);
    if (!current) {
      throw new Error(`Task not found: ${id}`);
    }
    this.db
      .prepare(`UPDATE tasks SET context_refs_json = ?, updated_at = ? WHERE id = ?`)
      .run(toJson(contextRefs), now(), id);
    return this.getTask(id)!;
  }

  getTask(id: TaskId): Task | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Row | undefined;
    if (!row) return null;
    return this.withTaskDependencies(mapTask(row));
  }

  private withTaskDependencies(task: Task): Task {
    const deps = this.db
      .prepare(`SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY rowid`)
      .all(task.id) as Array<{ depends_on_task_id: TaskId }>;
    return { ...task, dependencies: deps.map((d) => d.depends_on_task_id) };
  }


  /** Alias matching Main's integration seam (`createChef` -> `createTask`). */
  createTask(input: TaskInput): Task {
    return this.insertTask(input);
  }
  listTasks(workspaceId: WorkspaceId): Task[] {
    return (
      this.db.prepare(`SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at`).all(workspaceId) as Row[]
    ).map((row) => this.withTaskDependencies(mapTask(row)));
  }

  /** Convenience: update only status (used by scheduler compare-and-set). */
  updateTaskStatus(id: TaskId, status: TaskStatus, expectedStatus?: TaskStatus): Task {
    if (expectedStatus !== undefined) {
      const current = this.getTask(id);
      if (!current || current.status !== expectedStatus) {
        throw new Error(`Task status mismatch: expected ${expectedStatus}, got ${current?.status}`);
      }
    }
    return this.updateTask(id, { status, updatedAt: now() });
  }

  /** Optimistic status CAS: rows updated only when the current status matches. */
  casTaskStatus(id: TaskId, expectedStatus: TaskStatus, status: TaskStatus): boolean {
    const result = this.db
      .prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?`)
      .run(status, now(), id, expectedStatus);
    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------

  insertApproval(input: ApprovalInput): Approval {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? now();
    this.db
      .prepare(
        `INSERT INTO approvals (
           id, workspace_id, task_id, status, requester, approver, reason,
           created_at, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.taskId,
        input.status,
        input.requester,
        input.approver ?? null,
        input.reason,
        createdAt,
        input.resolvedAt ?? null,
      );
    return this.getApproval(id)!;
  }

  getApproval(id: string): Approval | null {
    const row = this.db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as Row | undefined;
    return row ? mapApproval(row) : null;
  }

  listApprovals(workspaceId: WorkspaceId): Approval[] {
    return (
      this.db.prepare(`SELECT * FROM approvals WHERE workspace_id = ? ORDER BY created_at, id`).all(workspaceId) as Row[]
    ).map(mapApproval);
  }

  /** Resolve a pending approval; re-resolving an already-resolved approval is a no-op. */
  resolveApproval(id: string, decision: ApprovalDecision, approver: string): Approval {
    const current = this.getApproval(id);
    if (!current) {
      throw new Error(`Approval not found: ${id}`);
    }
    if (current.status !== "pending") {
      return current;
    }
    const resolvedAt = now();
    this.db
      .prepare(
        `UPDATE approvals SET status = ?, approver = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(decision, approver, resolvedAt, id);
    return this.getApproval(id)!;
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  insertSession(input: SessionInput): Session {
    const id = input.id ?? randomUUID();
    const startedAt = input.startedAt ?? now();
    this.db
      .prepare(
        `INSERT INTO sessions (
           id, workspace_id, harness_id, agent_id, task_id, pid, status, command,
           args_json, cwd, cols, rows, started_at, ended_at, exit_code
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.harnessId,
        input.agentId,
        input.taskId,
        input.pid ?? 0,
        input.status,
        input.command,
        toJson(input.args ?? []),
        input.cwd ?? "",
        input.cols ?? 80,
        input.rows ?? 24,
        startedAt,
        input.endedAt ?? null,
        input.exitCode ?? null,
      );
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Row;
    return mapSession(row);
  }

  updateSession(id: string, patch: Partial<SessionInput>): Session {
    const current = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(id) as Row | undefined;
    if (!current) {
      throw new Error(`Session not found: ${id}`);
    }

    const next = {
      status: patch.status ?? (current.status as SessionStatus),
      pid: patch.pid ?? (current.pid as number),
      command: patch.command ?? (current.command as string),
      args: patch.args ?? readJson(current.args_json as string, [] as string[]),
      cwd: patch.cwd ?? (current.cwd as string),
      cols: patch.cols ?? (current.cols as number),
      rows: patch.rows ?? (current.rows as number),
      endedAt: patch.endedAt !== undefined ? patch.endedAt : (current.ended_at as number | null),
      exitCode: patch.exitCode !== undefined ? patch.exitCode : (current.exit_code as number | null),
    };

    this.db
      .prepare(
        `UPDATE sessions SET
           status = ?, pid = ?, command = ?, args_json = ?, cwd = ?, cols = ?,
           rows = ?, ended_at = ?, exit_code = ?
         WHERE id = ?`,
      )
      .run(
        next.status,
        next.pid,
        next.command,
        toJson(next.args),
        next.cwd,
        next.cols,
        next.rows,
        next.endedAt ?? null,
        next.exitCode ?? null,
        id,
      );

    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Row;
    return mapSession(row);
  }

  /** Optimistic session status CAS for lifecycle race resolution. */
  casSessionStatus(id: string, expected: SessionStatus[], status: SessionStatus, endedAt = now()): boolean {
    if (expected.length === 0) return false;
    const placeholders = expected.map(() => "?").join(", ");
    const result = this.db
      .prepare(`UPDATE sessions SET status = ?, ended_at = ? WHERE id = ? AND status IN (${placeholders})`)
      .run(status, endedAt, id, ...expected);
    return result.changes > 0;
  }

  /** Alias matching Main's integration seam (`createChef` -> `createSession`). */
  createSession(input: SessionInput): Session {
    return this.insertSession(input);
  }

  listSessions(workspaceId: WorkspaceId): Session[] {
    return (
      this.db.prepare(`SELECT * FROM sessions WHERE workspace_id = ? ORDER BY started_at`).all(workspaceId) as Row[]
    ).map(mapSession);
  }
  /** Counts sessions that still consume scheduler concurrency capacity. */
  countLiveSessions(workspaceId: WorkspaceId): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM sessions
         WHERE workspace_id = ? AND status IN ('spawning', 'running')`,
      )
      .get(workspaceId) as { count: number };
    return row.count;
  }

  // -------------------------------------------------------------------------
  // Events (immutable, append-only)
  // -------------------------------------------------------------------------

  // SQLite serializes writers; this single statement computes the per-workspace next seq atomically, and UNIQUE(workspace_id, seq) guards duplicates. AUTOINCREMENT cannot provide per-workspace sequences.
  appendEvent(input: EventInput): RuntimeEvent {
    const id = input.id ?? randomUUID();
    const timestamp = input.timestamp ?? now();
    const row = this.db
      .prepare(
        `INSERT INTO events (
           id, workspace_id, seq, timestamp, source_type, source_id, type,
           payload_json, task_id, session_id, correlation_id
         )
         SELECT ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?
         FROM events
         WHERE workspace_id = ?
         RETURNING seq`,
      )
      .get(
        id,
        input.workspaceId,
        timestamp,
        input.source.type,
        input.source.id,
        input.type,
        toJson(input.payload),
        input.taskId ?? null,
        input.sessionId ?? null,
        input.correlationId ?? null,
        input.workspaceId,
      ) as { seq: number };
    const seq = row.seq;
    return {
      id,
      workspaceId: input.workspaceId,
      seq,
      timestamp,
      source: input.source,
      type: input.type,
      payload: input.payload,
      taskId: input.taskId,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
    };
  }

  listEvents(
    workspaceId: WorkspaceId,
    sinceSeqOrOptions?: number | { afterSeq?: number; limit?: number },
  ): RuntimeEvent[] {
    const options =
      typeof sinceSeqOrOptions === "number"
        ? { afterSeq: sinceSeqOrOptions }
        : sinceSeqOrOptions;
    const afterSeq = options?.afterSeq;
    const limit = options?.limit;
    const rows = (
      afterSeq != null
        ? this.db
            .prepare(`SELECT * FROM events WHERE workspace_id = ? AND seq > ? ORDER BY seq`)
            .all(workspaceId, afterSeq)
        : this.db
            .prepare(`SELECT * FROM events WHERE workspace_id = ? ORDER BY seq`)
            .all(workspaceId)
    ) as Row[];
    const sliced = limit != null ? rows.slice(0, limit) : rows;
    return sliced.map(mapEvent);
  }
  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  insertMessage(input: MessageInput): AgentMessage {
    const id = input.id ?? randomUUID();
    const timestamp = input.timestamp ?? now();
    this.db
      .prepare(
        `INSERT INTO messages (
           id, workspace_id, from_agent, to_agent, channel, type, payload_json,
           reply_to, context_refs_json, correlation_id, timestamp
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.from,
        input.to ?? null,
        input.channel ?? null,
        input.type,
        toJson(input.payload),
        input.replyTo ?? null,
        toJson(input.contextRefs ?? []),
        input.correlationId ?? null,
        timestamp,
      );
    return {
      id,
      workspaceId: input.workspaceId,
      from: input.from,
      to: input.to,
      channel: input.channel,
      type: input.type,
      payload: input.payload,
      replyTo: input.replyTo,
      contextRefs: input.contextRefs,
      correlationId: input.correlationId,
      timestamp,
    };
  }

  listMessages(
    workspaceId: WorkspaceId,
    channel?: string,
  ): AgentMessage[] {
    if (channel != null) {
      return (
        this.db
          .prepare(`SELECT * FROM messages WHERE workspace_id = ? AND channel = ? ORDER BY timestamp`)
          .all(workspaceId, channel) as Row[]
      ).map(mapMessage);
    }
    return (
      this.db.prepare(`SELECT * FROM messages WHERE workspace_id = ? ORDER BY timestamp`).all(workspaceId) as Row[]
    ).map(mapMessage);
  }

  // -------------------------------------------------------------------------
  // Artifacts
  // -------------------------------------------------------------------------

  insertArtifact(input: ArtifactInput): Artifact {
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO artifacts (
           id, workspace_id, type, name, uri, version, created_by, task_id,
           session_id, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.type,
        input.name,
        input.uri,
        input.version ?? 1,
        input.createdBy,
        input.taskId ?? null,
        input.sessionId ?? null,
        toJson(input.metadata ?? {}),
      );
    return this.getArtifact(id)!;
  }

  getArtifact(id: string): Artifact | null {
    const row = this.db
      .prepare(`SELECT * FROM artifacts WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? mapArtifact(row) : null;
  }

  listArtifacts(workspaceId: WorkspaceId): Artifact[] {
    return (
      this.db.prepare(`SELECT * FROM artifacts WHERE workspace_id = ? ORDER BY rowid`).all(workspaceId) as Row[]
    ).map(mapArtifact);
  }

  // -------------------------------------------------------------------------
  // Templates (UI workflow templates)
  // -------------------------------------------------------------------------

  insertTemplate(input: TemplateInput): Template {
    const id = input.id ?? randomUUID();
    const ts = now();
    const createdAt = input.createdAt ?? ts;
    const updatedAt = input.updatedAt ?? ts;
    this.db
      .prepare(
        `INSERT INTO templates (
           id, workspace_id, name, description, nodes_json, metadata_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.name,
        input.description ?? "",
        toJson(input.nodes ?? []),
        toJson(input.metadata ?? {}),
        createdAt,
        updatedAt,
      );
    return this.getTemplate(id)!;
  }

  getTemplate(id: EntityId): Template | null {
    const row = this.db
      .prepare(`SELECT * FROM templates WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? mapTemplate(row) : null;
  }

  listTemplates(workspaceId: WorkspaceId): Template[] {
    return (
      this.db
        .prepare(`SELECT * FROM templates WHERE workspace_id = ? ORDER BY created_at, id`)
        .all(workspaceId) as Row[]
    ).map(mapTemplate);
  }

  updateTemplate(id: EntityId, patch: Partial<TemplateInput>): Template {
    const current = this.getTemplate(id);
    if (!current) throw new Error(`Template not found: ${id}`);
    const next = {
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      nodes: patch.nodes ?? current.nodes,
      metadata: patch.metadata ?? current.metadata,
    };
    this.db
      .prepare(
        `UPDATE templates SET
           name = ?, description = ?, nodes_json = ?, metadata_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.description,
        toJson(next.nodes),
        toJson(next.metadata),
        now(),
        id,
      );
    return this.getTemplate(id)!;
  }

  deleteTemplate(id: EntityId): void {
    this.db.prepare(`DELETE FROM templates WHERE id = ?`).run(id);
  }
  // -------------------------------------------------------------------------
  // Canvas nodes & edges (spec §5.4)
  // -------------------------------------------------------------------------

  upsertCanvasNode(rec: {
    id: string;
    workspaceId: WorkspaceId;
    taskId?: string | null;
    label: string;
    nodeType?: "blueprint" | "proxy";
    kind?: string;
    harnessId?: string | null;
    position?: { x: number; y: number };
  }): void {
    this.db
      .prepare(
        `INSERT INTO canvas_nodes
           (id, workspace_id, task_id, label, node_type, kind, harness_id, position_x, position_y, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           task_id = excluded.task_id,
           label = excluded.label,
           node_type = excluded.node_type,
           kind = excluded.kind,
           harness_id = excluded.harness_id,
           position_x = excluded.position_x,
           position_y = excluded.position_y,
           updated_at = excluded.updated_at`,
      )
      .run(
        rec.id,
        rec.workspaceId,
        rec.taskId ?? null,
        rec.label,
        rec.nodeType ?? "blueprint",
        rec.kind ?? "agent",
        rec.harnessId ?? null,
        rec.position?.x ?? 0,
        rec.position?.y ?? 0,
        now(),
      );
  }

  upsertCanvasEdge(rec: {
    workspaceId: WorkspaceId;
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO canvas_edges
           (id, workspace_id, source, target, source_handle, target_handle, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, target) DO UPDATE SET
           source_handle = excluded.source_handle,
           target_handle = excluded.target_handle,
           updated_at = excluded.updated_at`,
      )
      .run(
        `${rec.source}->${rec.target}`,
        rec.workspaceId,
        rec.source,
        rec.target,
        rec.sourceHandle ?? null,
        rec.targetHandle ?? null,
        now(),
      );
  }

  deleteCanvasNode(id: string): void {
    this.db.prepare(`DELETE FROM canvas_nodes WHERE id = ?`).run(id);
  }

  deleteCanvasEdge(id: string): void {
    this.db.prepare(`DELETE FROM canvas_edges WHERE id = ?`).run(id);
  }

  listCanvasNodes(workspaceId: WorkspaceId): CanvasNodeRecord[] {
    return this.db
      .prepare(`SELECT * FROM canvas_nodes WHERE workspace_id = ? ORDER BY id`)
      .all(workspaceId)
      .map((r) => mapCanvasNode(r as Row));
  }

  listCanvasEdges(workspaceId: WorkspaceId): CanvasEdgeRecord[] {
    return this.db
      .prepare(`SELECT * FROM canvas_edges WHERE workspace_id = ? ORDER BY id`)
      .all(workspaceId)
      .map((r) => mapCanvasEdge(r as Row));
  }
}

