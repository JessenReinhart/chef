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
  Automation,
  AutomationGraphEdge,
  AutomationId,
  AutomationRun,
  AutomationRunId,
  AutomationRunStatus,
  AutomationStatus,
  CanvasEdge,
  CanvasEdgeType,
  CanvasNode,
  ContextReference,
  ContextZone,
  Decision,
  DecisionStatus,
  EntityId,
  EntityRef,
  Mission,
  MissionId,
  MissionStatus,
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
  missionId?: MissionId;
  automationId?: AutomationId;
  automationRunId?: AutomationRunId;
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
  missionId?: MissionId;
  status: PlanStatus;
  tasks: PlanTask[];
  taskIds: TaskId[];
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface MissionInput {
  id?: MissionId;
  workspaceId: WorkspaceId;
  goal: string;
  status?: MissionStatus;
  taskIds?: TaskId[];
  planId?: PlanId;
  createdBy?: EntityId;
  metadata?: Record<string, unknown>;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  completedAt?: Timestamp;
}

export interface AutomationInput {
  id?: AutomationId;
  workspaceId: WorkspaceId;
  name: string;
  description?: string;
  status?: AutomationStatus;
  nodeIds?: string[];
  edges?: AutomationGraphEdge[];
  trigger?: Record<string, unknown>;
  currentRunId?: AutomationRunId;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface ContextZoneInput {
  id?: string;
  workspaceId: WorkspaceId;
  name: string;
  bounds: ContextZone["bounds"];
  contextRefs?: ContextReference[];
  memberNodeIds?: string[];
  policy?: Record<string, unknown>;
}

export interface ContextZoneRefAssignment {
  zoneId: string;
  taskId: TaskId;
  contextRefs: ContextReference[];
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
    missionId: (row.mission_id as string | null) ?? undefined,
    automationId: (row.automation_id as string | null) ?? undefined,
    automationRunId: (row.automation_run_id as string | null) ?? undefined,
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
    missionId: (row.mission_id as string | null) ?? undefined,
    status: row.status as PlanStatus,
    tasks: readJson(row.tasks_json as string, [] as PlanTask[]),
    taskIds: readJson(row.task_ids_json as string, [] as TaskId[]),
    createdAt: row.created_at as number,
    updatedAt: (row.updated_at as number | null) ?? undefined,
  };
}

function mapMission(row: Row): Mission {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    goal: row.goal as string,
    status: row.status as MissionStatus,
    taskIds: readJson(row.task_ids_json as string, [] as TaskId[]),
    planId: (row.plan_id as string | null) ?? undefined,
    createdBy: row.created_by as string,
    metadata: readJson(row.metadata_json as string, {}),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    completedAt: (row.completed_at as number | null) ?? undefined,
  };
}

function mapAutomation(row: Row): Automation {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    description: row.description as string,
    status: row.status as AutomationStatus,
    nodeIds: readJson(row.node_ids_json as string, [] as string[]),
    edges: readJson(row.edges_json as string, [] as AutomationGraphEdge[]),
    trigger: readJson(row.trigger_json as string, {}),
    currentRunId: (row.current_run_id as string | null) ?? undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function mapAutomationRun(row: Row): AutomationRun {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    automationId: row.automation_id as string,
    status: row.status as AutomationRunStatus,
    taskIds: readJson(row.task_ids_json as string, [] as TaskId[]),
    startedAt: row.started_at as number,
    endedAt: (row.ended_at as number | null) ?? undefined,
    error: (row.error as string | null) ?? undefined,
  };
}

function mapContextZone(row: Row, memberNodeIds: string[]): ContextZone {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    bounds: readJson(row.bounds_json as string, { x: 0, y: 0, width: 0, height: 0 }),
    contextRefs: readJson(row.context_refs_json as string, [] as ContextReference[]),
    memberNodeIds,
    policy: readJson(row.policy_json as string, {}),
    updatedAt: row.updated_at as number,
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
  liveStatus: CanvasNode["liveStatus"];
  config: Record<string, unknown>;
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
  type: CanvasEdgeType;
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
    liveStatus: (row.live_status == null ? "offline" : String(row.live_status)) as CanvasNode["liveStatus"],
    config: readJson(row.config_json as string | null, {}),
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
    type: row.edge_type == null ? "context" : String(row.edge_type) as CanvasEdgeType,
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
    liveStatus: rec.liveStatus,
    config: rec.config,
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
    type: rec.type,
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
    this.db.exec("PRAGMA foreign_keys = ON");
    this.#prepareLegacySchema();
    this.db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  }

  /** Add columns needed by the current idempotent schema before its indexes run. */
  #prepareLegacySchema(): void {
    const tableExists = (table: string): boolean => Boolean(
      this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table),
    );
    const hasColumn = (table: string, column: string): boolean => {
      if (!tableExists(table)) return false;
      return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((entry) => entry.name === column);
    };
    const ensureColumn = (table: string, column: string, definition: string): void => {
      if (!tableExists(table)) return;
      if (!hasColumn(table, column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    ensureColumn("tasks", "mission_id", "TEXT");
    ensureColumn("tasks", "automation_id", "TEXT");
    ensureColumn("tasks", "automation_run_id", "TEXT");
    ensureColumn("plans", "mission_id", "TEXT");
    // Recover a database left between the old non-transactional rename/copy/drop
    // steps. New migrations are transactional, but this repair path makes an
    // interrupted v0.2 preview database reopenable as well.
    if (tableExists("canvas_edges_legacy_v01") && !tableExists("canvas_edges")) {
      this.db.exec("ALTER TABLE canvas_edges_legacy_v01 RENAME TO canvas_edges");
    }
    if (tableExists("canvas_edges_legacy_v01") && tableExists("canvas_edges")) {
      if (!hasColumn("canvas_edges", "edge_type")) {
        throw new Error("Cannot recover canvas edge migration: both tables use the legacy schema");
      }
      this.transaction(() => {
        this.db.exec(`
          INSERT OR IGNORE INTO canvas_edges
            (id, workspace_id, source, target, source_handle, target_handle, edge_type, updated_at)
          SELECT id, workspace_id, source, target, source_handle, target_handle, 'context', updated_at
          FROM canvas_edges_legacy_v01;
          DROP TABLE canvas_edges_legacy_v01;
        `);
      });
    }
    if (tableExists("canvas_edges") && !hasColumn("canvas_edges", "edge_type")) {
      // v0.1 constrained one edge per node pair. Rebuild so distinct semantic
      // relationships can coexist without changing any persisted v0.1 ids.
      this.transaction(() => {
        this.db.exec(`
          DROP INDEX IF EXISTS idx_canvas_edges_workspace;
          ALTER TABLE canvas_edges RENAME TO canvas_edges_legacy_v01;
          CREATE TABLE canvas_edges (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            source TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
            target TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
            source_handle TEXT,
            target_handle TEXT,
            edge_type TEXT NOT NULL DEFAULT 'context',
            updated_at INTEGER NOT NULL,
            UNIQUE(source, target, edge_type)
          );
          INSERT INTO canvas_edges (id, workspace_id, source, target, source_handle, target_handle, edge_type, updated_at)
            SELECT id, workspace_id, source, target, source_handle, target_handle, 'context', updated_at FROM canvas_edges_legacy_v01;
          DROP TABLE canvas_edges_legacy_v01;
          CREATE INDEX idx_canvas_edges_workspace ON canvas_edges(workspace_id);
        `);
      });
    }
    if (tableExists("canvas_edges")) {
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_edges_typed_unique ON canvas_edges(source, target, edge_type)`);
    }
    ensureColumn("canvas_nodes", "live_status", "TEXT NOT NULL DEFAULT 'offline'");
    ensureColumn("canvas_nodes", "config_json", "TEXT NOT NULL DEFAULT '{}'");
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
           id, workspace_id, goal, mission_id, status, tasks_json, task_ids_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.goal,
        input.missionId ?? null,
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
  }

  // -------------------------------------------------------------------------
  // Missions & automations (living workspace v0.2)
  // -------------------------------------------------------------------------

  insertMission(input: MissionInput): Mission {
    const id = input.id ?? randomUUID();
    const ts = now();
    this.db.prepare(
      `INSERT INTO missions
       (id, workspace_id, goal, status, task_ids_json, plan_id, created_by, metadata_json, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.workspaceId, input.goal, input.status ?? "planning", toJson(input.taskIds ?? []),
      input.planId ?? null, input.createdBy ?? "user", toJson(input.metadata ?? {}), input.createdAt ?? ts,
      input.updatedAt ?? ts, input.completedAt ?? null);
    return this.getMission(id)!;
  }

  getMission(id: MissionId): Mission | null {
    const row = this.db.prepare(`SELECT * FROM missions WHERE id = ?`).get(id) as Row | undefined;
    return row ? mapMission(row) : null;
  }

  listMissions(workspaceId: WorkspaceId): Mission[] {
    return (this.db.prepare(`SELECT * FROM missions WHERE workspace_id = ? ORDER BY created_at, id`).all(workspaceId) as Row[]).map(mapMission);
  }

  updateMission(id: MissionId, patch: { goal?: string; status?: MissionStatus; taskIds?: TaskId[]; planId?: PlanId; metadata?: Record<string, unknown> }): Mission {
    const current = this.getMission(id);
    if (!current) throw new Error(`Mission not found: ${id}`);
    const nextStatus = patch.status ?? current.status;
    const terminalStatuses = new Set<MissionStatus>(["completed", "cancelled", "failed"]);
    const transitions: Record<MissionStatus, readonly MissionStatus[]> = {
      planning: ["planning", "active", "paused", "cancelled", "failed"],
      active: ["active", "planning", "paused", "waiting_for_approval", "blocked", "verifying", "completed", "cancelled", "failed"],
      paused: ["paused", "planning", "active", "cancelled"],
      waiting_for_approval: ["waiting_for_approval", "active", "paused", "blocked", "cancelled", "failed"],
      blocked: ["blocked", "planning", "active", "paused", "cancelled", "failed"],
      verifying: ["verifying", "active", "paused", "completed", "cancelled", "failed"],
      completed: ["completed"],
      cancelled: ["cancelled"],
      failed: ["failed"],
    };
    if (terminalStatuses.has(current.status) && Object.keys(patch).length > 0) {
      throw new Error(`Mission ${id} is terminal (${current.status})`);
    }
    if (!transitions[current.status].includes(nextStatus)) {
      throw new Error(`Invalid Mission transition: ${current.status} -> ${nextStatus}`);
    }
    const terminal = nextStatus === "completed" || nextStatus === "cancelled" || nextStatus === "failed";
    const result = this.db.prepare(
      `UPDATE missions SET goal = ?, status = ?, task_ids_json = ?, plan_id = ?, metadata_json = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND status = ?`,
    ).run(patch.goal?.trim() || current.goal, nextStatus, toJson(patch.taskIds ?? current.taskIds), patch.planId ?? current.planId ?? null,
      toJson(patch.metadata ?? current.metadata), now(), terminal ? now() : null, id, current.status);
    if (result.changes !== 1) throw new Error(`Mission ${id} changed concurrently`);
    return this.getMission(id)!;
  }

  insertAutomation(input: AutomationInput): Automation {
    const id = input.id ?? randomUUID();
    const ts = now();
    const nodes = [...new Set(input.nodeIds ?? [])];
    for (const edge of input.edges ?? []) {
      if (!nodes.includes(edge.source) || !nodes.includes(edge.target)) throw new Error(`automation edge references missing node: ${edge.source}->${edge.target}`);
    }
    this.db.prepare(
      `INSERT INTO automations
       (id, workspace_id, name, description, status, node_ids_json, edges_json, trigger_json, current_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.workspaceId, input.name, input.description ?? "", input.status ?? "idle", toJson(nodes),
      toJson(input.edges ?? []), toJson(input.trigger ?? {}), input.currentRunId ?? null, input.createdAt ?? ts, input.updatedAt ?? ts);
    return this.getAutomation(id)!;
  }

  getAutomation(id: AutomationId): Automation | null {
    const row = this.db.prepare(`SELECT * FROM automations WHERE id = ?`).get(id) as Row | undefined;
    return row ? mapAutomation(row) : null;
  }

  listAutomations(workspaceId: WorkspaceId): Automation[] {
    return (this.db.prepare(`SELECT * FROM automations WHERE workspace_id = ? ORDER BY created_at, id`).all(workspaceId) as Row[]).map(mapAutomation);
  }

  listAutomationRuns(automationId: AutomationId): AutomationRun[] {
    return (this.db.prepare(`SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at, id`).all(automationId) as Row[]).map(mapAutomationRun);
  }

  getAutomationRun(id: AutomationRunId): AutomationRun | null {
    const row = this.db.prepare(`SELECT * FROM automation_runs WHERE id = ?`).get(id) as Row | undefined;
    return row ? mapAutomationRun(row) : null;
  }

  /** Finish a naturally terminal Automation run and release its definition. */
  finalizeAutomationRun(
    id: AutomationRunId,
    status: Extract<AutomationRunStatus, "completed" | "failed">,
    error?: string,
  ): AutomationRun {
    return this.transaction(() => {
      const current = this.getAutomationRun(id);
      if (!current) throw new Error(`Automation run not found: ${id}`);
      if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") return current;
      const ts = now();
      this.db.prepare(
        `UPDATE automation_runs SET status = ?, ended_at = ?, error = ?
         WHERE id = ? AND status IN ('queued', 'running', 'waiting')`,
      ).run(status, ts, error ?? null, id);
      this.db.prepare(
        `UPDATE automations SET status = 'idle', current_run_id = NULL, updated_at = ?
         WHERE id = ? AND current_run_id = ?`,
      ).run(ts, current.automationId, id);
      return this.getAutomationRun(id)!;
    });
  }

  /** Persist a non-terminal Automation run phase without releasing ownership. */
  updateAutomationRunStatus(
    id: AutomationRunId,
    status: Extract<AutomationRunStatus, "queued" | "running" | "waiting">,
  ): AutomationRun {
    const current = this.getAutomationRun(id);
    if (!current) throw new Error(`Automation run not found: ${id}`);
    if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") return current;
    if (current.status === status) return current;
    const result = this.db.prepare(
      `UPDATE automation_runs SET status = ? WHERE id = ? AND status IN ('queued', 'running', 'waiting')`,
    ).run(status, id);
    if (result.changes !== 1) throw new Error(`Automation run ${id} changed concurrently`);
    return this.getAutomationRun(id)!;
  }

  runAutomation(id: AutomationId): AutomationRun {
    return this.transaction(() => {
      const automation = this.getAutomation(id);
      if (!automation) throw new Error(`Automation not found: ${id}`);
      if (automation.status === "disabled") throw new Error(`Automation is disabled: ${id}`);
      if (automation.status === "running") throw new Error(`Automation is already running: ${id}`);
      const runId = randomUUID();
      const ts = now();
      const taskIdByNode = new Map(automation.nodeIds.map((nodeId) => [nodeId, randomUUID()]));
      const canvasNodes = new Map(this.listCanvasNodes(automation.workspaceId).map((node) => [node.id, node]));
      const taskIds: TaskId[] = [];
      this.db.prepare(
        `INSERT INTO automation_runs (id, workspace_id, automation_id, status, task_ids_json, started_at)
         VALUES (?, ?, ?, 'running', '[]', ?)`,
      ).run(runId, automation.workspaceId, id, ts);
      for (const nodeId of automation.nodeIds) {
        const canvasNode = canvasNodes.get(nodeId);
        const sourceTask = canvasNode?.taskId ? this.getTask(canvasNode.taskId) : null;
        const inboundEdges = automation.edges.filter((edge) => edge.target === nodeId);
        const dependencies = inboundEdges
          .filter((edge) => edge.target === nodeId && (edge.type === "dependency" || edge.type === "control" || edge.type === "approval"))
          .map((edge) => taskIdByNode.get(edge.source))
          .filter((taskId) => taskId !== undefined);
        const taskId = taskIdByNode.get(nodeId)!;
        const approvalSources = inboundEdges.filter((edge) => edge.type === "approval").map((edge) => edge.source);
        const approvalId = approvalSources.length > 0 ? randomUUID() : undefined;
        if (approvalId) {
          this.insertApproval({
            id: approvalId,
            workspaceId: automation.workspaceId,
            taskId,
            status: "pending",
            requester: `automation:${automation.id}`,
            reason: `Automation ${automation.name} requires approval before ${canvasNode?.label ?? nodeId} (after ${approvalSources.join(", ")})`,
          });
        }
        this.insertTask({
          id: taskId,
          workspaceId: automation.workspaceId,
          title: canvasNode?.label ?? sourceTask?.title ?? nodeId,
          description: sourceTask?.description ?? `Automation step ${nodeId}`,
          status: "pending",
          assignedTo: sourceTask?.assignedTo ?? canvasNode?.harnessId ?? undefined,
          dependencies,
          contextRefs: sourceTask?.contextRefs ?? [],
          priority: sourceTask?.priority ?? 0,
          workflowNodeId: nodeId,
          automationId: automation.id,
          automationRunId: runId,
          approvalId,
        });
        taskIds.push(taskId);
      }
      this.db.prepare(`UPDATE automation_runs SET task_ids_json = ? WHERE id = ?`).run(toJson(taskIds), runId);
      this.db.prepare(`UPDATE automations SET status = 'running', current_run_id = ?, updated_at = ? WHERE id = ?`).run(runId, ts, id);
      return mapAutomationRun(this.db.prepare(`SELECT * FROM automation_runs WHERE id = ?`).get(runId) as Row);
    });
  }

stopAutomation(id: AutomationId): AutomationRun {
    return this.transaction(() => {
      const automation = this.getAutomation(id);
      if (!automation?.currentRunId || automation.status !== "running") throw new Error(`Automation is not running: ${id}`);
      const ts = now();
      const run = this.db.prepare(`SELECT * FROM automation_runs WHERE id = ?`).get(automation.currentRunId) as Row;
      const taskIds = mapAutomationRun(run).taskIds;
      for (const taskId of taskIds) {
        this.db.prepare(`UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('pending', 'assigned', 'running', 'blocked')`).run(ts, taskId);
      }
      // Resolve any pending approval gates owned by the stopped run so the UI
      // does not surface a stale actionable approval. Re-rejecting an
      // already-resolved approval is a no-op.
      const taskParams = taskIds.map(() => "?").join(",");
      this.db.prepare(
        `UPDATE approvals SET status = 'rejected', approver = 'automation-stop', resolved_at = ?
         WHERE task_id IN (${taskParams}) AND status = 'pending'`,
      ).run(ts, ...taskIds);
      this.db.prepare(`UPDATE automation_runs SET status = 'cancelled', ended_at = ? WHERE id = ? AND status IN ('queued', 'running', 'waiting')`).run(ts, automation.currentRunId);
      this.db.prepare(`UPDATE automations SET status = 'stopped', current_run_id = NULL, updated_at = ? WHERE id = ?`).run(ts, id);
      return mapAutomationRun(this.db.prepare(`SELECT * FROM automation_runs WHERE id = ?`).get(automation.currentRunId) as Row);
    });
  }

  upsertContextZone(input: ContextZoneInput): ContextZone {
    const id = input.id ?? randomUUID();
    const ts = now();
    const current = this.getContextZone(id);
    if (current && current.workspaceId !== input.workspaceId) {
      throw new Error(`Context zone ${id} belongs to a different workspace`);
    }
    const memberNodeIds = input.memberNodeIds === undefined
      ? undefined
      : [...new Set(input.memberNodeIds)].sort();
    for (const nodeId of memberNodeIds ?? []) {
      const member = this.db.prepare(`SELECT workspace_id FROM canvas_nodes WHERE id = ?`).get(nodeId) as { workspace_id: string } | undefined;
      if (!member || member.workspace_id !== input.workspaceId) {
        throw new Error(`Context zone member is not a canvas node in workspace ${input.workspaceId}: ${nodeId}`);
      }
    }
    this.transaction(() => {
      this.db.prepare(
        `INSERT INTO context_zones (id, workspace_id, name, bounds_json, context_refs_json, policy_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, bounds_json = excluded.bounds_json,
           context_refs_json = excluded.context_refs_json, policy_json = excluded.policy_json, updated_at = excluded.updated_at`,
      ).run(id, input.workspaceId, input.name, toJson(input.bounds), toJson(input.contextRefs ?? []), toJson(input.policy ?? {}), ts);
      if (memberNodeIds !== undefined) {
        this.db.prepare(`DELETE FROM context_zone_members WHERE zone_id = ?`).run(id);
        const insert = this.db.prepare(`INSERT INTO context_zone_members (zone_id, node_id) VALUES (?, ?)`);
        for (const nodeId of memberNodeIds) insert.run(id, nodeId);
      }
    });
    return this.getContextZone(id)!;
  }

  getContextZone(id: string): ContextZone | null {
    const row = this.db.prepare(`SELECT * FROM context_zones WHERE id = ?`).get(id) as Row | undefined;
    if (!row) return null;
    const members = (this.db.prepare(`SELECT node_id FROM context_zone_members WHERE zone_id = ? ORDER BY node_id`).all(id) as Array<{ node_id: string }>).map((entry) => entry.node_id);
    return mapContextZone(row, members);
  }

  listContextZones(workspaceId: WorkspaceId): ContextZone[] {
    const rows = this.db.prepare(`SELECT * FROM context_zones WHERE workspace_id = ? ORDER BY id`).all(workspaceId) as Row[];
    return rows.map((row) => this.getContextZone(row.id as string)!);
  }

  deleteContextZone(id: string): boolean {
    return this.transaction(() => {
      const owned = this.db.prepare(
        `SELECT task_id, ref_key FROM context_zone_task_refs WHERE zone_id = ?`,
      ).all(id) as Array<{ task_id: string; ref_key: string }>;
      const deleted = this.db.prepare(`DELETE FROM context_zones WHERE id = ?`).run(id).changes > 0;
      if (!deleted) return false;
      const keysByTask = new Map<string, Set<string>>();
      for (const row of owned) {
        const keys = keysByTask.get(row.task_id) ?? new Set<string>();
        keys.add(row.ref_key);
        keysByTask.set(row.task_id, keys);
      }
      for (const [taskId, removedKeys] of keysByTask) {
        const stillOwned = new Set(
          (this.db.prepare(`SELECT ref_key FROM context_zone_task_refs WHERE task_id = ?`).all(taskId) as Array<{ ref_key: string }>).map((row) => row.ref_key),
        );
        const task = this.getTask(taskId);
        if (!task) continue;
        const contextRefs = task.contextRefs.filter((ref) => {
          const key = `${ref.type}:${ref.id}`;
          return !removedKeys.has(key) || stillOwned.has(key);
        });
        this.db.prepare(`UPDATE tasks SET context_refs_json = ?, updated_at = ? WHERE id = ?`).run(toJson(contextRefs), now(), taskId);
      }
      return true;
    });
  }

  /**
   * Reconcile Context Zone-derived refs while retaining non-zone task context.
   * Provenance rows are authoritative: only refs previously inserted by this
   * method are eligible for removal.
   */
  syncContextZoneRefs(workspaceId: WorkspaceId, assignments: ContextZoneRefAssignment[]): void {
    const zones = new Map(this.listContextZones(workspaceId).map((zone) => [zone.id, zone]));
    const desiredByTask = new Map<string, Map<string, { ref: ContextReference; zoneIds: Set<string> }>>();
    for (const assignment of assignments) {
      if (!zones.has(assignment.zoneId)) throw new Error(`Context zone not found in workspace: ${assignment.zoneId}`);
      const task = this.getTask(assignment.taskId);
      if (!task || task.workspaceId !== workspaceId) throw new Error(`Context zone task not found in workspace: ${assignment.taskId}`);
      const refs = desiredByTask.get(assignment.taskId) ?? new Map<string, { ref: ContextReference; zoneIds: Set<string> }>();
      for (const ref of assignment.contextRefs) {
        const key = `${ref.type}:${ref.id}`;
        const desired = refs.get(key) ?? { ref, zoneIds: new Set<string>() };
        desired.zoneIds.add(assignment.zoneId);
        refs.set(key, desired);
      }
      desiredByTask.set(assignment.taskId, refs);
    }

    this.transaction(() => {
      const priorRows = this.db.prepare(
        `SELECT p.zone_id, p.task_id, p.ref_key
         FROM context_zone_task_refs p
         JOIN tasks t ON t.id = p.task_id
         WHERE t.workspace_id = ?`,
      ).all(workspaceId) as Array<{ zone_id: string; task_id: string; ref_key: string }>;
      const priorKeysByTask = new Map<string, Set<string>>();
      for (const row of priorRows) {
        const keys = priorKeysByTask.get(row.task_id) ?? new Set<string>();
        keys.add(row.ref_key);
        priorKeysByTask.set(row.task_id, keys);
      }
      const affectedTaskIds = new Set([...priorKeysByTask.keys(), ...desiredByTask.keys()]);
      this.db.prepare(
        `DELETE FROM context_zone_task_refs
         WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id = ?)`,
      ).run(workspaceId);
      const insertOwnership = this.db.prepare(
        `INSERT INTO context_zone_task_refs (zone_id, task_id, ref_key, ref_json) VALUES (?, ?, ?, ?)`,
      );

      for (const taskId of affectedTaskIds) {
        const task = this.getTask(taskId);
        if (!task || task.workspaceId !== workspaceId) continue;
        const priorKeys = priorKeysByTask.get(taskId) ?? new Set<string>();
        const baseRefs = new Map<string, ContextReference>();
        for (const ref of task.contextRefs) {
          const key = `${ref.type}:${ref.id}`;
          if (!priorKeys.has(key)) baseRefs.set(key, ref);
        }
        const desiredRefs = desiredByTask.get(taskId) ?? new Map<string, { ref: ContextReference; zoneIds: Set<string> }>();
        const nextRefs = new Map(baseRefs);
        for (const [key, desired] of desiredRefs) {
          if (!nextRefs.has(key)) {
            nextRefs.set(key, desired.ref);
            for (const zoneId of [...desired.zoneIds].sort()) {
              insertOwnership.run(zoneId, taskId, key, toJson(desired.ref));
            }
          }
        }
        this.db.prepare(`UPDATE tasks SET context_refs_json = ?, updated_at = ? WHERE id = ?`)
          .run(toJson([...nextRefs.values()]), now(), taskId);
      }
    });
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
      const missions = (
        this.db.prepare(`SELECT * FROM missions WHERE workspace_id = ? ORDER BY created_at, id`).all(workspaceId) as Row[]
      ).map(mapMission);
      const automations = (
        this.db.prepare(`SELECT * FROM automations WHERE workspace_id = ? ORDER BY created_at, id`).all(workspaceId) as Row[]
      ).map(mapAutomation);
      const automationRuns = (
        this.db.prepare(`SELECT * FROM automation_runs WHERE workspace_id = ? ORDER BY started_at, id`).all(workspaceId) as Row[]
      ).map(mapAutomationRun);
      const contextZoneRows = this.db.prepare(`SELECT * FROM context_zones WHERE workspace_id = ? ORDER BY id`).all(workspaceId) as Row[];
      const contextZones = contextZoneRows.map((row) => {
        const members = (this.db.prepare(`SELECT node_id FROM context_zone_members WHERE zone_id = ? ORDER BY node_id`).all(row.id as string) as Array<{ node_id: string }>).map((entry) => entry.node_id);
        return mapContextZone(row, members);
      });
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
        missions,
        automations,
        automationRuns,
        contextZones,
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
           mission_id, automation_id, automation_run_id, approval_id, context_refs_json, priority,
           workflow_node_id, retry_count, error, result_summary, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.title,
        input.description,
        input.status,
        input.assignedTo ?? null,
        input.parentTaskId ?? null,
        input.missionId ?? null,
        input.automationId ?? null,
        input.automationRunId ?? null,
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
      missionId: patch.missionId !== undefined ? patch.missionId : current.missionId,
      automationId: patch.automationId !== undefined ? patch.automationId : current.automationId,
      automationRunId: patch.automationRunId !== undefined ? patch.automationRunId : current.automationRunId,
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
           title = ?, description = ?, status = ?, assigned_to = ?, parent_task_id = ?,
           mission_id = ?, automation_id = ?, automation_run_id = ?, approval_id = ?,
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
        next.missionId ?? null,
        next.automationId ?? null,
        next.automationRunId ?? null,
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
    this.transaction(() => {
      // This API is an authoritative write by a non-zone source (currently
      // canvas-edge context). Relinquish zone ownership first so a later zone
      // removal can never erase a ref that this source now supplies as well.
      this.db.prepare(`DELETE FROM context_zone_task_refs WHERE task_id = ?`).run(id);
      this.db
        .prepare(`UPDATE tasks SET context_refs_json = ?, updated_at = ? WHERE id = ?`)
        .run(toJson(contextRefs), now(), id);
    });
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

  insertDecision(input: Decision): Decision {
    this.db.prepare(
      `INSERT INTO decisions (id, workspace_id, type, summary, payload_json, made_by, timestamp, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.workspaceId,
      input.type,
      input.summary,
      toJson(input.payload),
      input.madeBy,
      input.timestamp,
      input.status,
    );
    return this.getDecision(input.id)!;
  }

  getDecision(id: string): Decision | null {
    const row = this.db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as Row | undefined;
    return row ? mapDecision(row) : null;
  }

  listDecisions(workspaceId: WorkspaceId): Decision[] {
    return (this.db.prepare(`SELECT * FROM decisions WHERE workspace_id = ? ORDER BY timestamp, id`).all(workspaceId) as Row[]).map(mapDecision);
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
    liveStatus?: CanvasNode["liveStatus"];
    config?: Record<string, unknown>;
    position?: { x: number; y: number };
  }): void {
    const existingRow = this.db.prepare(`SELECT * FROM canvas_nodes WHERE id = ?`).get(rec.id) as Row | undefined;
    const existing = existingRow ? mapCanvasNode(existingRow) : null;
    if (existing && existing.workspaceId !== rec.workspaceId) {
      throw new Error(`Canvas node ${rec.id} belongs to a different workspace`);
    }
    this.db
      .prepare(
        `INSERT INTO canvas_nodes
           (id, workspace_id, task_id, label, node_type, kind, harness_id, live_status, config_json, position_x, position_y, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           task_id = excluded.task_id,
           label = excluded.label,
           node_type = excluded.node_type,
           kind = excluded.kind,
           harness_id = excluded.harness_id,
           live_status = excluded.live_status,
           config_json = excluded.config_json,
           position_x = excluded.position_x,
           position_y = excluded.position_y,
           updated_at = excluded.updated_at`,
      )
      .run(
        rec.id,
        rec.workspaceId,
        rec.taskId !== undefined ? rec.taskId : existing?.taskId ?? null,
        rec.label ?? existing?.label ?? rec.id,
        rec.nodeType ?? existing?.nodeType ?? "blueprint",
        rec.kind ?? existing?.kind ?? "agent",
        rec.harnessId !== undefined ? rec.harnessId : existing?.harnessId ?? null,
        rec.liveStatus ?? existing?.liveStatus ?? "offline",
        toJson(rec.config ?? existing?.config ?? {}),
        rec.position?.x ?? existing?.positionX ?? 0,
        rec.position?.y ?? existing?.positionY ?? 0,
        now(),
      );
  }

  upsertCanvasEdge(rec: {
    workspaceId: WorkspaceId;
    source: string;
    target: string;
    type?: CanvasEdgeType;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO canvas_edges
           (id, workspace_id, source, target, source_handle, target_handle, edge_type, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, target, edge_type) DO UPDATE SET
           source_handle = excluded.source_handle,
           target_handle = excluded.target_handle,
           updated_at = excluded.updated_at`,
      )
      .run(
        rec.type && rec.type !== "context" ? `${rec.source}->${rec.target}:${rec.type}` : `${rec.source}->${rec.target}`,
        rec.workspaceId,
        rec.source,
        rec.target,
        rec.sourceHandle ?? null,
        rec.targetHandle ?? null,
        rec.type ?? "context",
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
