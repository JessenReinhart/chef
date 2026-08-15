/**
 * Chef P0 — node execution engine (spec §12).
 *
 * Executes runnable graph nodes through runtime adapters, persists
 * events/status through the Repository, propagates data/artifacts along
 * edges, handles approval waits, cancellation, and bounded failure edges
 * (an error edge catches an upstream failure and lets its target run).
 *
 * Integrations:
 *  - Repository: task status transitions, immutable events, artifacts,
 *    approvals — all writes go through the repository transactionally.
 *  - HarnessRegistry: tool nodes (terminal) run through the PTY harness;
 *    PTY vs sideband separation is preserved (stdout/stderr come from the
 *    harness event stream only).
 *  - ContextManager: node context references resolve against repository
 *    state before execution.
 *  - Scheduler: shares the same Repository + harness registry; the engine
 *    executes graph nodes the scheduler does not dispatch as tasks.
 *
 * "Runtime state authoritative; UI is projection" — this engine is the
 * single writer for node execution state and event emission.
 */

import type {
  Approval,
  ApprovalDecision,
  Artifact,
  ContextReference,
  EntityRef,
  Harness,
  RuntimeEvent,
  SessionId,
  TaskId,
  TaskStatus,
  WorkspaceId,
} from "../core/types.ts";
import type { NodeDefinition, NodeExecutionContext, NodeExecutionResult, NodeStatus } from "../core/nodes.ts";
import type { Repository } from "../persistence/database.ts";
import { ContextManager } from "../context/context.ts";
import { nodeRegistry } from "./node-registry.ts";

// ---------------------------------------------------------------------------
// Structural subset of a harness registry the engine drives (duck-typed; the
// Scheduler.HarnessRegistry satisfies this by shape).
// ---------------------------------------------------------------------------

export interface EngineHarnessRegistry {
  get(agentId: string): Harness | undefined;
  set(agentId: string, harness: Harness): void;
  values(): Iterable<Harness>;
}

export interface NodeExecutionEngineOptions {
  /** Maximum concurrent node executions. Default 2. */
  maxConcurrency?: number;
  /** Called synchronously after every persisted RuntimeEvent. */
  onEvent?: (event: RuntimeEvent) => void;
}

// ---------------------------------------------------------------------------
// Execution model
// ---------------------------------------------------------------------------

export interface GraphNodeInstance {
  id: string;
  definition: NodeDefinition;
  config: unknown;
  status: NodeStatus;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  artifacts: Artifact[];
  events: RuntimeEvent[];
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface GraphEdgeInstance {
  id: string;
  source: string;
  target: string;
  kind: "data" | "control" | "conditional" | "error" | "approval";
  /** Port mapping for data edges: output port id on source → input port id on target. */
  sourcePort?: string;
  targetPort?: string;
}

export interface ExecutionGraph {
  nodes: Map<string, GraphNodeInstance>;
  edges: Map<string, GraphEdgeInstance>;
  adjacency: Map<string, string[]>;
  reverseAdjacency: Map<string, string[]>;
}

export interface GraphNodeSpec {
  id: string;
  type: string;
  config: unknown;
  inputs?: Record<string, unknown>;
}

export interface GraphEdgeSpec {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeInstance["kind"];
  sourcePort?: string;
  targetPort?: string;
}

export interface ExecutionResult {
  graph: ExecutionGraph;
  finalStatuses: Map<string, NodeStatus>;
  events: RuntimeEvent[];
  artifacts: Artifact[];
}

interface ApprovalWaiter {
  resolve: (decision: ApprovalDecision) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  interval: ReturnType<typeof setInterval>;
  executionId: string;
}

// ---------------------------------------------------------------------------
// Graph construction helpers
// ---------------------------------------------------------------------------

function now(): number {
  return Date.now();
}

/** Build the internal execution graph, validating types and configs. */
function buildExecutionGraph(nodes: GraphNodeSpec[], edges: GraphEdgeSpec[]): ExecutionGraph {
  const nodeInstances = new Map<string, GraphNodeInstance>();
  const edgeInstances = new Map<string, GraphEdgeInstance>();
  const adjacency = new Map<string, string[]>();
  const reverseAdjacency = new Map<string, string[]>();

  for (const spec of nodes) {
    const definition = nodeRegistry.get(spec.type);
    if (!definition) {
      throw new Error(`node-execution-engine: unknown node type '${spec.type}' for '${spec.id}'`);
    }
    const validatedConfig = nodeRegistry.validateConfig(spec.type, spec.config);
    nodeInstances.set(spec.id, {
      id: spec.id,
      definition,
      config: validatedConfig,
      status: "idle",
      inputs: { ...(spec.inputs ?? {}) },
      outputs: {},
      artifacts: [],
      events: [],
    });
    adjacency.set(spec.id, []);
    reverseAdjacency.set(spec.id, []);
  }

  for (const spec of edges) {
    const source = nodeInstances.get(spec.source);
    const target = nodeInstances.get(spec.target);
    if (!source) throw new Error(`node-execution-engine: edge '${spec.id}' has unknown source '${spec.source}'`);
    if (!target) throw new Error(`node-execution-engine: edge '${spec.id}' has unknown target '${spec.target}'`);
    const edge: GraphEdgeInstance = {
      id: spec.id,
      source: spec.source,
      target: spec.target,
      kind: spec.kind,
      sourcePort: spec.sourcePort,
      targetPort: spec.targetPort,
    };
    edgeInstances.set(spec.id, edge);
    adjacency.get(spec.source)!.push(spec.id);
    reverseAdjacency.get(spec.target)!.push(spec.id);
  }

  return { nodes: nodeInstances, edges: edgeInstances, adjacency, reverseAdjacency };
}

/** Kahn topological order over all edges; throws on cycles. */
function computeTopologicalOrder(graph: ExecutionGraph): string[] {
  const indegree = new Map<string, number>();
  const queue: string[] = [];
  const order: string[] = [];

  for (const nodeId of graph.nodes.keys()) {
    const degree = graph.reverseAdjacency.get(nodeId)?.length ?? 0;
    indegree.set(nodeId, degree);
    if (degree === 0) queue.push(nodeId);
  }

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    order.push(nodeId);
    for (const edgeId of graph.adjacency.get(nodeId) ?? []) {
      const target = graph.edges.get(edgeId)!.target;
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }

  if (order.length !== graph.nodes.size) {
    throw new Error("node-execution-engine: cycle detected in graph edges");
  }
  return order;
}

/** Collect data/control/conditional/error inputs for a node from its edges. */
function collectInputs(graph: ExecutionGraph, nodeId: string): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const edgeId of graph.reverseAdjacency.get(nodeId) ?? []) {
    const edge = graph.edges.get(edgeId)!;
    const sourceNode = graph.nodes.get(edge.source)!;
    if (sourceNode.status !== "completed") continue;
    if (edge.kind === "data" || edge.kind === "approval") {
      if (edge.sourcePort !== undefined && edge.targetPort !== undefined) {
        inputs[edge.targetPort] = sourceNode.outputs[edge.sourcePort];
      } else {
        for (const [key, value] of Object.entries(sourceNode.outputs)) {
          inputs[key] = value;
        }
      }
    } else if (edge.kind === "conditional") {
      inputs._selected = sourceNode.outputs.selected;
    } else if (edge.kind === "error") {
      inputs._error = sourceNode.error;
    }
  }
  return inputs;
}

// ---------------------------------------------------------------------------
// NodeExecutionEngine
// ---------------------------------------------------------------------------

export class NodeExecutionEngine {
  readonly #repo: Repository;
  readonly #harnessRegistry: EngineHarnessRegistry;
  readonly #contextManager: ContextManager;
  readonly #maxConcurrency: number;
  readonly #onEvent: ((event: RuntimeEvent) => void) | undefined;

  /** executionId → abort controller (engine-initiated cancellation). */
  readonly #running = new Map<string, AbortController>();
  /** approvalId → waiter; resolved by resolveApproval or an external repo write. */
  readonly #approvalWaiters = new Map<string, ApprovalWaiter>();

  constructor(
    repository: Repository,
    harnessRegistry: EngineHarnessRegistry,
    opts: NodeExecutionEngineOptions = {},
  ) {
    this.#repo = repository;
    this.#harnessRegistry = harnessRegistry;
    this.#contextManager = new ContextManager(repository);
    this.#maxConcurrency = opts.maxConcurrency ?? 2;
    this.#onEvent = opts.onEvent;
  }

  /** Cancel all running executions for a graphId. Returns the count cancelled. */
  cancel(graphId: string, reason = "cancelled"): number {
    let cancelled = 0;
    for (const [executionId, controller] of this.#running) {
      if (executionId.startsWith(`${graphId}:`)) {
        controller.abort(reason);
        cancelled++;
      }
    }
    return cancelled;
  }


  /** Resolve a pending approval created by a human node; resolves the node's
   *  requestApproval promise. Returns false when the approval is unknown. */
  resolveApproval(approvalId: string, decision: ApprovalDecision, approver = "engine"): boolean {
    const approval = this.#repo.resolveApproval(approvalId, decision, approver);
    const waiter = this.#approvalWaiters.get(approvalId);
    if (!waiter) return false;
    if (waiter.timer) clearTimeout(waiter.timer);
    clearInterval(waiter.interval);
    this.#approvalWaiters.delete(approvalId);
    waiter.resolve(approval.status === "accepted" ? "accepted" : "rejected");
    return true;
  }

  /**
   * Execute a graph. Nodes run in topological order with bounded concurrency
   * (sequential in Phase 1; concurrency is reserved). Human nodes block until
   * their approval resolves; failure propagates downstream unless an error
   * edge catches it; aborting `signal` cancels the run and updates statuses.
   */
  async executeGraph(
    workspaceId: WorkspaceId,
    graphId: string,
    nodes: GraphNodeSpec[],
    edges: GraphEdgeSpec[],
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const executionId = `${graphId}:${now()}`;
    const abortController = new AbortController();
    const combinedSignal = AbortSignal.any([
      abortController.signal,
      signal ?? new AbortController().signal,
    ]);
    this.#running.set(executionId, abortController);

    const graph = buildExecutionGraph(nodes, edges);
    const order = computeTopologicalOrder(graph);
    const finalStatuses = new Map<string, NodeStatus>();
    const allEvents: RuntimeEvent[] = [];
    const allArtifacts: Artifact[] = [];

    const persistEvent = (event: RuntimeEvent): void => {
      if (event.seq > 0) return; // already persisted
      const persisted = this.#repo.appendEvent({
        workspaceId,
        source: event.source,
        type: event.type,
        payload: event.payload,
        taskId: event.taskId,
        sessionId: event.sessionId,
        correlationId: event.correlationId,
      });
      allEvents.push(persisted);
      this.#onEvent?.(persisted);
    };

    const ensureTask = (nodeId: string, status: TaskStatus): TaskId => {
      const taskId = `${graphId}:${nodeId}` as TaskId;
      if (!this.#repo.getTask(taskId)) {
        const node = graph.nodes.get(nodeId)!;
        this.#repo.insertTask({
          id: taskId,
          workspaceId,
          title: node.definition.label,
          description: `${node.definition.type} node '${nodeId}'`,
          status,
          workflowNodeId: nodeId,
          priority: 0,
        });
      } else {
        this.#repo.updateTaskStatus(taskId, status);
      }
      return taskId;
    };

    try {
      for (const nodeId of order) {
        if (combinedSignal.aborted) {
          await this.#cancelRemaining(graph, executionId, finalStatuses, "cancelled", workspaceId, graphId);
          break;
        }

        const node = graph.nodes.get(nodeId)!;

        // Nodes already terminal (completed, failed, or propagated cancelled)
        // are skipped.
        if (node.status === "completed" || node.status === "failed" || node.status === "cancelled") {
          continue;
        }

        // An incoming error edge from a failed node catches the failure: the
        // node runs to handle it (it receives the error via _error input).
        const caughtError = Array.from(graph.reverseAdjacency.get(nodeId) ?? []).some(
          (edgeId) => {
            const edge = graph.edges.get(edgeId)!;
            if (edge.kind !== "error") return false;
            const source = graph.nodes.get(edge.source)!;
            return source.status === "failed" && source.error !== undefined;
          },
        );

        // Control/conditional predecessors must complete first. Nodes behind
        // an unselected branch stay ready and are finalized by the closing pass.
        const unreadyPredecessor = Array.from(graph.reverseAdjacency.get(nodeId) ?? []).some(
          (edgeId) => {
            const edge = graph.edges.get(edgeId)!;
            if (edge.kind !== "control" && edge.kind !== "conditional") return false;
            const source = graph.nodes.get(edge.source)!;
            return source.status !== "completed" && source.status !== "failed";
          },
        );
        if (unreadyPredecessor && !caughtError) {
          node.status = "ready";
          continue;
        }

        const taskId = ensureTask(nodeId, "running");
        node.status = "running";
        node.startedAt = now();
        persistEvent({
          id: crypto.randomUUID(),
          workspaceId,
          seq: 0,
          timestamp: now(),
          source: { type: "task", id: taskId },
          type: "node.started",
          payload: { nodeId, nodeType: node.definition.type },
          taskId,
        });

        const result = await this.#executeNode(
          workspaceId,
          graph,
          nodeId,
          taskId,
          executionId,
          combinedSignal,
          persistEvent,
          allArtifacts,
        );

        node.status = result.status;
        node.outputs = result.outputs;
        node.artifacts.push(...result.artifacts);
        node.events.push(...result.events);
        node.endedAt = now();
        finalStatuses.set(nodeId, result.status);

        // Persist the node's own emitted events (completion, approval
        // resolution, output delivery, ...) so the run is reconstructable
        // from the immutable event log.
        for (const event of result.events) {
          persistEvent(event);
        }

        if (result.status === "completed") {
          this.#repo.updateTaskStatus(taskId, "completed");
        } else if (result.status === "failed") {
          node.error = node.error ?? "node failed";
          this.#repo.updateTask(taskId, { status: "failed", error: node.error });
          await this.#propagateFailure(graph, nodeId, finalStatuses, workspaceId, graphId);
        } else if (result.status === "cancelled") {
          this.#repo.updateTaskStatus(taskId, "cancelled");
        }
      }


      // Closing pass: nodes left non-terminal (unselected branches, nodes
      // behind a failure without an error edge) are finalized.
      for (const node of graph.nodes.values()) {
        if (node.status === "idle" || node.status === "ready" || node.status === "waiting") {
          const terminal = combinedSignal.aborted ? "cancelled" : "failed";
          node.status = terminal;
          node.error = node.error ?? "not executed: upstream did not complete";
          node.endedAt = now();
          finalStatuses.set(node.id, terminal);
          const taskId = `${graphId}:${node.id}` as TaskId;
          if (this.#repo.getTask(taskId)) {
            this.#repo.updateTaskStatus(taskId, terminal);
          }
        }
      }
    } finally {
      this.#running.delete(executionId);
      // Reject any still-pending approval waiters so node execute() promises
      // settle and cannot leak.
      for (const [approvalId, waiter] of this.#approvalWaiters) {
        if (waiter.executionId !== executionId) continue;
        if (waiter.timer) clearTimeout(waiter.timer);
        clearInterval(waiter.interval);
        this.#approvalWaiters.delete(approvalId);
        waiter.reject(new Error("approval wait cancelled: graph execution ended"));
      }
    }

    return { graph, finalStatuses, events: allEvents, artifacts: allArtifacts };
  }

  async #executeNode(
    workspaceId: WorkspaceId,
    graph: ExecutionGraph,
    nodeId: string,
    taskId: TaskId,
    executionId: string,
    abortSignal: AbortSignal,
    persistEvent: (event: RuntimeEvent) => void,
    allArtifacts: Artifact[],
  ): Promise<NodeExecutionResult> {
    const node = graph.nodes.get(nodeId)!;
    const sessionId = crypto.randomUUID() as SessionId;
    const config = node.config as Record<string, unknown>;

    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      if (abortSignal.aborted) {
        reject(new Error("node cancelled"));
        return;
      }
      abortListener = () => reject(new Error("node cancelled"));
      abortSignal.addEventListener("abort", abortListener, { once: true });
    });

    const context: NodeExecutionContext = {
      taskId,
      workspaceId,
      config: node.config,
      inputs: { ...node.inputs, ...collectInputs(graph, nodeId) },
      artifacts: node.artifacts,
      contextRefs: this.#resolveContextRefs(node.inputs, workspaceId),
      harness: this.#resolveHarness(),
      sessionId,
      runtime: {
        emitEvent: (event) => {
          node.events.push(event);
        },
        createArtifact: async (artifact) => {
          const persisted = this.#repo.insertArtifact({
            workspaceId,
            type: artifact.type,
            name: artifact.name,
            uri: artifact.uri,
            version: artifact.version,
            createdBy: taskId,
            taskId,
            sessionId,
            metadata: artifact.metadata,
          });
          node.artifacts.push(persisted);
          allArtifacts.push(persisted);
          return persisted;
        },
        requestApproval: (approval) => this.#requestApproval(approval, executionId, config, taskId),
      },
    };

    try {
      const result = await Promise.race([
        node.definition.execute(context),
        aborted,
      ]);
      if (abortListener) abortSignal.removeEventListener("abort", abortListener);
      return result;
    } catch (error) {
      if (abortListener) abortSignal.removeEventListener("abort", abortListener);
      if (abortSignal.aborted) {
        node.error = "cancelled";
        persistEvent({
          id: crypto.randomUUID(),
          workspaceId,
          seq: 0,
          timestamp: now(),
          source: { type: "task", id: taskId },
          type: "node.cancelled",
          payload: { nodeId, nodeType: node.definition.type },
          taskId,
        });
        return { status: "cancelled", outputs: {}, artifacts: [], events: [] };
      }
      node.error = error instanceof Error ? error.message : String(error);
      persistEvent({
        id: crypto.randomUUID(),
        workspaceId,
        seq: 0,
        timestamp: now(),
        source: { type: "task", id: taskId },
        type: "node.failed",
        payload: { nodeId, nodeType: node.definition.type, error: node.error },
        taskId,
      });
      return { status: "failed", outputs: {}, artifacts: [], events: [] };
    }
  }

  #resolveHarness(): Harness {
    for (const harness of this.#harnessRegistry.values()) {
      return harness;
    }
    throw new Error("node-execution-engine: no harness registered for node execution");
  }

  #resolveContextRefs(inputs: Record<string, unknown>, workspaceId: WorkspaceId): ContextReference[] {
    const refs = inputs.contextRefs;
    if (!Array.isArray(refs)) return [];
    const references = refs.filter(
      (ref): ref is ContextReference =>
        typeof ref === "object" && ref !== null && typeof (ref as ContextReference).type === "string",
    );
    if (references.length === 0) return [];
    const resolved = this.#contextManager.resolve(references, workspaceId);
    return resolved.items.map((item) => item.reference);
  }

  #requestApproval(
    approval: Approval,
    executionId: string,
    config: Record<string, unknown>,
    taskId: TaskId,
  ): Promise<ApprovalDecision> {
    const inserted = this.#repo.insertApproval({
      workspaceId: approval.workspaceId,
      taskId: approval.taskId,
      status: approval.status,
      requester: approval.requester,
      reason: approval.reason,
      createdAt: approval.createdAt,
    });
    this.#repo.appendEvent({
      workspaceId: approval.workspaceId,
      source: { type: "task", id: taskId },
      type: "approval.requested",
      payload: { approvalId: inserted.id, reason: approval.reason, nodeType: "human" },
      taskId,
    });

    return new Promise<ApprovalDecision>((resolve, reject) => {
      const timeoutMs = typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : 0;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#approvalWaiters.delete(inserted.id);
              reject(new Error(`approval ${inserted.id} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      const interval = setInterval(() => {
        const current = this.#repo.getApproval(inserted.id);
        if (current && current.status !== "pending") {
          if (timer) clearTimeout(timer);
          clearInterval(interval);
          this.#approvalWaiters.delete(inserted.id);
          const decision = current.status === "accepted" ? "accepted" : "rejected";
          resolve(decision);
        }
      }, 100);
      // Never hold the process open on an unresolved approval.
      (timer as { unref?: () => void } | null)?.unref?.();
      (interval as { unref?: () => void }).unref?.();
      this.#approvalWaiters.set(inserted.id, { resolve, reject, timer, interval, executionId });
    });
  }

  /** Mark downstream nodes failed (normal edges) or ready-to-catch (error edges).
   *  Task rows are created/updated so the failure is durable. */
  async #propagateFailure(
    graph: ExecutionGraph,
    failedNodeId: string,
    finalStatuses: Map<string, NodeStatus>,
    workspaceId: WorkspaceId,
    graphId: string,
  ): Promise<void> {
    const queue = [failedNodeId];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      for (const edgeId of graph.adjacency.get(nodeId) ?? []) {
        const edge = graph.edges.get(edgeId)!;
        const target = graph.nodes.get(edge.target)!;
        if (edge.kind === "error") {
          if (target.status === "idle" || target.status === "ready") {
            target.status = "ready"; // catch: will execute when reached
            queue.push(edge.target);
          }
        } else if (
          target.status !== "completed" &&
          target.status !== "failed" &&
          target.status !== "cancelled"
        ) {
          target.status = "failed";
          target.error = `upstream failure in '${failedNodeId}'`;
          target.endedAt = now();
          finalStatuses.set(edge.target, "failed");
          const taskId = `${graphId}:${edge.target}` as TaskId;
          if (!this.#repo.getTask(taskId)) {
            this.#repo.insertTask({
              id: taskId,
              workspaceId,
              title: target.definition.label,
              description: `${target.definition.type} node '${edge.target}'`,
              status: "failed",
              workflowNodeId: edge.target,
              priority: 0,
              error: target.error,
            });
          } else {
            this.#repo.updateTask(taskId, { status: "failed", error: target.error });
          }
          queue.push(edge.target);
        }
      }
    }
  }

  /** Mark pending nodes cancelled after an abort (running nodes are torn
   *  down by the abort race in #executeNode). Task rows are created/updated
   *  so cancellation is durable. */
  async #cancelRemaining(
    graph: ExecutionGraph,
    executionId: string,
    finalStatuses: Map<string, NodeStatus>,
    reason: string,
    workspaceId: WorkspaceId,
    graphId: string,
  ): Promise<void> {
    void executionId;
    for (const node of graph.nodes.values()) {
      if (node.status === "completed" || node.status === "failed" || node.status === "cancelled") {
        continue;
      }
      node.status = "cancelled";
      node.error = reason;
      node.endedAt = now();
      finalStatuses.set(node.id, "cancelled");
      const taskId = `${graphId}:${node.id}` as TaskId;
      if (!this.#repo.getTask(taskId)) {
        this.#repo.insertTask({
          id: taskId,
          workspaceId,
          title: node.definition.label,
          description: `${node.definition.type} node '${node.id}'`,
          status: "cancelled",
          workflowNodeId: node.id,
          priority: 0,
          error: reason,
        });
      } else {
        this.#repo.updateTask(taskId, { status: "cancelled", error: reason });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Graph validation (pre-flight; LLM-proposed graphs are validated here before
// execution — "LLMs propose; runtime validates/executes").
// ---------------------------------------------------------------------------

export interface GraphValidationError {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface GraphValidationResult {
  valid: boolean;
  errors: GraphValidationError[];
}

export function validateGraph(
  nodes: GraphNodeSpec[],
  edges: GraphEdgeSpec[],
): GraphValidationResult {
  const errors: GraphValidationError[] = [];
  const nodeIds = new Set<string>();

  // Unique node ids and valid types.
  for (const n of nodes) {
    if (nodeIds.has(n.id)) {
      errors.push({ code: "DUPLICATE_NODE_ID", message: `duplicate node id '${n.id}'`, nodeId: n.id });
    }
    nodeIds.add(n.id);
    if (!nodeRegistry.get(n.type)) {
      errors.push({ code: "UNKNOWN_NODE_TYPE", message: `unknown node type '${n.type}'`, nodeId: n.id });
      continue;
    }
    try {
      nodeRegistry.validateConfig(n.type, n.config);
    } catch (error) {
      errors.push({
        code: "INVALID_CONFIG",
        message: `invalid config for '${n.id}': ${error instanceof Error ? error.message : String(error)}`,
        nodeId: n.id,
      });
    }
  }

  // Edge integrity + port matching.
  const edgeIds = new Set<string>();
  for (const e of edges) {
    if (edgeIds.has(e.id)) {
      errors.push({ code: "DUPLICATE_EDGE_ID", message: `duplicate edge id '${e.id}'`, edgeId: e.id });
    }
    edgeIds.add(e.id);
    if (!nodeIds.has(e.source)) {
      errors.push({ code: "INVALID_EDGE_SOURCE", message: `edge '${e.id}' source '${e.source}' unknown`, edgeId: e.id });
      continue;
    }
    if (!nodeIds.has(e.target)) {
      errors.push({ code: "INVALID_EDGE_TARGET", message: `edge '${e.id}' target '${e.target}' unknown`, edgeId: e.id });
      continue;
    }
    const sourceDef = nodeRegistry.get(nodes.find((n) => n.id === e.source)!.type);
    const targetDef = nodeRegistry.get(nodes.find((n) => n.id === e.target)!.type);
    if (!sourceDef || !targetDef) continue;

    if (e.kind === "approval") {
      if (!sourceDef.outputs.some((p) => p.type === "approval")) {
        errors.push({
          code: "PORT_MISMATCH",
          message: `approval edge '${e.id}' source '${e.source}' has no approval output`,
          edgeId: e.id,
        });
      }
      if (!targetDef.inputs.some((p) => p.type === "approval")) {
        errors.push({
          code: "PORT_MISMATCH",
          message: `approval edge '${e.id}' target '${e.target}' has no approval input`,
          edgeId: e.id,
        });
      }
    } else if (e.kind === "data") {
      const sourcePort = e.sourcePort
        ? sourceDef.outputs.find((p) => p.id === e.sourcePort)
        : sourceDef.outputs.find((p) => p.type === "data");
      const targetPort = e.targetPort
        ? targetDef.inputs.find((p) => p.id === e.targetPort)
        : targetDef.inputs.find((p) => p.type === "data");
      if (!sourcePort || sourcePort.type === "control") {
        errors.push({
          code: "PORT_MISMATCH",
          message: `edge '${e.id}' source '${e.source}' has no data output${e.sourcePort ? ` '${e.sourcePort}'` : ""}`,
          edgeId: e.id,
        });
      }
      if (!targetPort) {
        errors.push({
          code: "PORT_MISMATCH",
          message: `edge '${e.id}' target '${e.target}' has no ${e.targetPort ? `input '${e.targetPort}'` : "data input"}`,
          edgeId: e.id,
        });
      }
    }
  }

  // Required inputs present (explicit inputs or an incoming data edge).
  for (const n of nodes) {
    const def = nodeRegistry.get(n.type);
    if (!def) continue;
    const incomingData = edges.some((e) => e.target === n.id && (e.kind === "data" || e.kind === "approval"));
    for (const port of def.inputs) {
      if (!port.required) continue;
      const explicit = n.inputs?.[port.id] !== undefined;
      if (!explicit && !incomingData) {
        errors.push({
          code: "MISSING_REQUIRED_INPUT",
          message: `node '${n.id}' missing required input '${port.id}'`,
          nodeId: n.id,
        });
      }
    }
  }

  // Acyclic control edges.
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== "control") continue;
    const list = adjacency.get(e.source) ?? [];
    list.push(e.target);
    adjacency.set(e.source, list);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const hasCycle = (nodeId: string): boolean => {
    if (done.has(nodeId)) return false;
    if (visiting.has(nodeId)) return true;
    visiting.add(nodeId);
    for (const target of adjacency.get(nodeId) ?? []) {
      if (hasCycle(target)) return true;
    }
    visiting.delete(nodeId);
    done.add(nodeId);
    return false;
  };
  for (const n of nodes) {
    if (hasCycle(n.id)) {
      errors.push({ code: "CYCLIC_CONTROL_EDGES", message: "cycle detected in control edges" });
      break;
    }
  }

  return { valid: errors.length === 0, errors };
}
