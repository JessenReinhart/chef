import { now } from "../core/ids.ts";
import type {
  Task,
  RuntimeEvent,
  Artifact,
  WorkspaceId,
  TaskId,
  SessionId,
  Session,
  AgentId,
  EntityRef,
  ContextReference,
  Approval,
  ApprovalDecision,
} from "../core/types.ts";
import type { Repository, SessionInput } from "../persistence/database.ts";
import type { HarnessEvent, SpawnOptions } from "../harness/generic.ts";
import type { SidebandEnvelope } from "../harness/sideband.ts";
import { TaskMachine } from "./task-machine.ts";

// ---------------------------------------------------------------------------
// Scheduler options, harness abstraction & registry
// ---------------------------------------------------------------------------

export interface SchedulerOptions {
  maxConcurrency?: number;
  /** Maximum retries per task (failed/blocked → running). Default 2. */
  maxRetries?: number;
  /** Called synchronously after every persisted RuntimeEvent. */
  onEvent?: (event: RuntimeEvent) => void;
}

export type TaskSpawnOptions = SpawnOptions & { taskPrompt?: string };
export interface TaskLaunch { command: string; args: string[]; }

/**
 * Minimal structural subset of a harness the scheduler drives. Any concrete
 * harness (e.g. GenericTerminalHarness) satisfies this by shape. The harness
 * is created and registered by the orchestrator/main runtime keyed by agent.
 */
export interface HarnessLike {
  readonly id: string;
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  /** True only when the adapter has a bounded one-shot Mission invocation. */
  readonly taskCapable?: boolean;
  taskLaunch?(prompt: string): TaskLaunch;
  spawn(options?: TaskSpawnOptions): Promise<{ id: string; pid?: number }>;
  events(sessionId: string): AsyncIterable<HarnessEvent>;
  send(sessionId: string, input: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  terminate(sessionId: string): Promise<void>;
  forget(sessionId: string): Promise<void>;
  /** Write context references into a session's inbox (runtime -> process). */
  writeContextRefs(sessionId: string, contextRefs: ContextReference[]): Promise<string>;
  /** Write a peer message envelope into a session's inbox (message_peer). */
  writeMessage(sessionId: string, from: string, text: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * Harness registry — keyed by agent id (task.assignedTo).
 * Populated at startup by the orchestrator/main runtime.
 */
export interface HarnessRegistry {
  get(agentId: AgentId): HarnessLike | undefined;
  set(agentId: AgentId, harness: HarnessLike): void;
  values(): Iterable<HarnessLike>;
}

/** Receives each successfully spawned session before dispatch scans again. */
export type SessionDispatchOwner = (session: Session) => void;

function runtimeDebugEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.CHEF_RUNTIME_DEBUG ?? "").toLowerCase());
}

function debugPreview(text: string, limit = 800): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function runtimeDebug(event: string, details: Record<string, unknown>): void {
  if (!runtimeDebugEnabled()) return;
  console.error(`[chef:runtime] ${event} ${JSON.stringify(details)}`);
}

function missionTaskPrompt(task: Task): string {
  return [
    "You are a Chef worker executing one bounded Mission task in the current project.",
    "Complete the task, use the tools available to you, and exit when the task is finished.",
    "Do not wait for additional chat input unless the task itself explicitly requires it.",
    "",
    `Task: ${task.title}`,
    task.description,
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  readonly #repo: Repository;
  readonly #registry: HarnessRegistry;
  readonly #maxConcurrency: number;
  readonly #maxRetries: number;
  readonly #onEvent: ((event: RuntimeEvent) => void) | undefined;

  /** sessionId → { taskId, agentId } for running sessions. */
  readonly #sessions = new Map<SessionId, { taskId: TaskId; agentId: AgentId }>();
  readonly #sessionStartedAt = new Map<SessionId, number>();
  readonly #sessionOutputTail = new Map<SessionId, string>();

  constructor(
    repository: Repository,
    harnessRegistry: HarnessRegistry,
    opts: SchedulerOptions = {},
  ) {
    this.#repo = repository;
    this.#registry = harnessRegistry;
    this.#maxConcurrency = opts.maxConcurrency ?? 2;
    this.#maxRetries = opts.maxRetries ?? 2;
    this.#onEvent = opts.onEvent;
  }

  // -------------------------------------------------------------------------
  // Startup recovery
  // -------------------------------------------------------------------------

  /**
   * Startup recovery: mark orphan sessions crashed and orphan running tasks
   * blocked so a restart leaves durable state consistent with no live PTYs.
   */
  async recoverOnStartup(workspaceId: WorkspaceId): Promise<void> {
    const snapshot = this.#repo.getWorkspaceSnapshot(workspaceId);

    this.#repo.transaction(() => {
      for (const session of snapshot.sessions) {
        if (session.status === "running" || session.status === "spawning") {
          this.#repo.updateSession(session.id, {
            status: "crashed",
            endedAt: now(),
          });
          this.#appendEvent(workspaceId, {
            type: "session.crashed",
            payload: { sessionId: session.id, reason: "orphan on startup" },
            taskId: session.taskId,
            sessionId: session.id,
          });
        }
      }

      for (const task of snapshot.tasks) {
        if (task.status === "running") {
          this.#repo.updateTaskStatus(task.id, "blocked", "running");
          this.#appendEvent(workspaceId, {
            type: "task.blocked",
            payload: { from: "running", to: "blocked", reason: "orphan on startup" },
            taskId: task.id,
          });
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /**
   * Scan for runnable tasks and dispatch up to maxConcurrency.
   * Returns the number of tasks dispatched.
   */
  async dispatchPending(
    workspaceId: WorkspaceId,
    allowedTaskIds?: readonly TaskId[],
    onSessionDispatched?: SessionDispatchOwner,
  ): Promise<number> {
    let dispatched = 0;
    const allowed = allowedTaskIds ? new Set(allowedTaskIds) : null;

    while (true) {
      const snapshot = this.#repo.getWorkspaceSnapshot(workspaceId);
      const runningCount = snapshot.tasks.filter(t => t.status === "running").length;
      const available = this.#maxConcurrency - runningCount;
      if (available <= 0) break;

      const completedIds = new Set(
        snapshot.tasks.filter(t => t.status === "completed").map(t => t.id),
      );
      const approvalsById = new Map(snapshot.approvals.map((a) => [a.id, a]));
      const gateHeld = (t: Task): boolean =>
        t.approvalId !== undefined && approvalsById.get(t.approvalId)?.status !== "accepted";

      // Request outstanding human gates first so pending-approval tasks hold
      // at blocked and emit approval.requested (spec §11.3).
      for (const held of snapshot.tasks.filter(t =>
        (!allowed || allowed.has(t.id)) && gateHeld(t) && t.dependencies.every(dep => completedIds.has(dep)),
      )) {
        await this.#requestApproval(workspaceId, held);
      }

      const runnable = snapshot.tasks
        .filter(t => !allowed || allowed.has(t.id))
        .filter(t => (t.status === "pending" || t.status === "assigned") && t.assignedTo != null)
        .filter(t => !gateHeld(t))
        .filter(t => t.dependencies.every(dep => completedIds.has(dep)))
        .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
      if (runnable.length === 0) break;

      const session = await this.#dispatchOne(workspaceId, runnable[0]);
      if (!session) break;
      onSessionDispatched?.(session);
      dispatched++;
    }

    return dispatched;
  }
  /**
   * Dispatch a single task: persist the transition (pending→assigned→running,
   * or failed/blocked→running on retry) plus the spawning session record, all
   * atomically, then spawn the harness process and return. The orchestrator
   * owns consuming the session event stream via handleSessionEvent.
   */
  async #dispatchOne(workspaceId: WorkspaceId, task: Task): Promise<Session | null> {
    let harness: HarnessLike | undefined;
    let taskPrompt: string | undefined;
    const session = this.#repo.transaction(() => {
      const current = this.#repo.getTask(task.id);
      if (!current || !["pending", "assigned", "failed", "blocked"].includes(current.status)) {
        return null;
      }

      const agentId = current.assignedTo;
      if (!agentId) {
        throw new Error(`Task ${current.id} has no assigned agent`);
      }
      harness = this.#registry.get(agentId);
      if (!harness) {
        throw new Error(`No harness registered for agent ${agentId}`);
      }
      if (current.missionId && harness.taskCapable === false) {
        throw new Error(`Agent ${agentId} is interactive-only and cannot execute Mission tasks`);
      }
      if (this.#repo.countLiveSessions(workspaceId) >= this.#maxConcurrency) return null;

      let dispatchTask = current;
      if (dispatchTask.status === "pending") {
        TaskMachine.validateTransition(dispatchTask.status, "assigned");
        const { event } = TaskMachine.transition(dispatchTask, "assigned", {
          assignedTo: agentId,
        });
        this.#repo.updateTask(dispatchTask.id, { status: "assigned", assignedTo: agentId });
        this.#appendEvent(workspaceId, event);
        dispatchTask = this.#repo.getTask(dispatchTask.id)!;
      }

      if (dispatchTask.status === "failed" || dispatchTask.status === "blocked") {
        if (dispatchTask.retryCount >= this.#maxRetries) {
          throw new Error(
            `Task ${dispatchTask.id} exceeds retry budget (${dispatchTask.retryCount}/${this.#maxRetries})`,
          );
        }
        TaskMachine.validateTransition(dispatchTask.status, "running");
        const { event: retryEvt } = TaskMachine.transition(dispatchTask, "running", {
          retryCount: dispatchTask.retryCount + 1,
          error: undefined,
        });
        this.#repo.updateTask(dispatchTask.id, {
          status: "running",
          retryCount: dispatchTask.retryCount + 1,
          error: undefined,
        });
        this.#appendEvent(workspaceId, retryEvt);
        dispatchTask = this.#repo.getTask(dispatchTask.id)!;
      }

      if (dispatchTask.status === "assigned") {
        const { event: runEvt } = TaskMachine.transition(dispatchTask, "running");
        this.#repo.updateTask(dispatchTask.id, { status: "running" });
        this.#appendEvent(workspaceId, runEvt);
      }

      taskPrompt = dispatchTask.missionId && harness.taskCapable === true
        ? missionTaskPrompt(dispatchTask)
        : undefined;
      const launch = taskPrompt !== undefined
        ? harness.taskLaunch?.(taskPrompt)
        : undefined;
      if (taskPrompt !== undefined && !launch) {
        throw new Error(`Agent ${agentId} declares task capability without a task launch contract`);
      }

      const sessionInput: SessionInput = {
        workspaceId,
        harnessId: harness.id,
        agentId,
        taskId: dispatchTask.id,
        status: "spawning",
        command: launch?.command ?? harness.command,
        args: launch?.args ?? harness.args,
        cwd: harness.cwd,
        cols: 120,
        rows: 40,
      };
      runtimeDebug("task.routed", {
        taskId: dispatchTask.id,
        missionId: dispatchTask.missionId,
        worker: agentId,
        command: sessionInput.command,
        args: sessionInput.args,
      });
      return this.#repo.insertSession(sessionInput);
    });

    if (!session || !harness) return null;

    this.#sessions.set(session.id, { taskId: session.taskId, agentId: session.agentId });
    this.#sessionStartedAt.set(session.id, now());
    this.#sessionOutputTail.set(session.id, "");
    const freshTask = this.#repo.getTask(task.id)!;

    try {
      runtimeDebug("session.spawn", {
        taskId: freshTask.id,
        sessionId: session.id,
        worker: session.agentId,
        command: session.command,
        args: session.args,
      });
      const spawned = await harness.spawn({
        sessionId: session.id,
        cols: 120,
        rows: 40,
        taskPrompt,
      });
      this.#repo.updateSession(session.id, { status: "running", pid: spawned.pid });

      if (freshTask.contextRefs.length > 0) {
        await harness.writeContextRefs(session.id, freshTask.contextRefs);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      runtimeDebug("session.spawn_failed", {
        taskId: freshTask.id,
        sessionId: session.id,
        worker: session.agentId,
        error: message,
      });
      this.#repo.transaction(() => {
        this.#repo.updateSession(session.id, { status: "crashed", endedAt: now() });
        const currentTask = this.#repo.getTask(task.id)!;
        if (currentTask.status !== "running") return;
        const { event: failEvt } = TaskMachine.transition(currentTask, "failed", {
          error: `spawn failed: ${message}`,
        });
        this.#repo.updateTask(task.id, {
          status: "failed",
          error: `spawn failed: ${message}`,
        });
        this.#appendEvent(workspaceId, failEvt);
      });
      this.#sessions.delete(session.id);
      this.#sessionStartedAt.delete(session.id);
      this.#sessionOutputTail.delete(session.id);
      return null;
    }

    return session;
  }

  // -------------------------------------------------------------------------
  // Harness event consumption
  // -------------------------------------------------------------------------

  /**
   * Process a single harness event. Called by the orchestrator's session
   * consumption loop and externally for manual event injection (tests).
   */
  async handleSessionEvent(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    event: HarnessEvent,
  ): Promise<void> {
    const tracking = this.#sessions.get(sessionId);
    if (!tracking) {
      runtimeDebug("session.event_untracked", { event: event.type, sessionId });
      return;
    }
    const { taskId, agentId } = tracking;

    if (event.type === "data") {
      const payload = event.data;
      const previous = this.#sessionOutputTail.get(sessionId) ?? "";
      this.#sessionOutputTail.set(sessionId, `${previous}${payload}`.slice(-4000));
      runtimeDebug("session.data", {
        taskId,
        sessionId,
        worker: agentId,
        preview: debugPreview(payload, 300),
      });
      this.#repo.transaction(() => {
        this.#appendEvent(workspaceId, {
          type: "session.data",
          payload: { encoding: "utf8", data: payload },
          taskId,
          sessionId,
        });
      });
      return;
    }

    if (event.type === "structured") {
      runtimeDebug("session.structured", { taskId, sessionId, worker: agentId });
      await this.#handleStructured(workspaceId, sessionId, taskId, event.payload);
      return;
    }

    if (event.type === "exit" || event.type === "crash") {
      const startedAt = this.#sessionStartedAt.get(sessionId);
      const outputTail = this.#sessionOutputTail.get(sessionId) ?? "";
      runtimeDebug(`session.${event.type}`, {
        taskId,
        sessionId,
        worker: agentId,
        exitCode: event.exitCode,
        durationMs: startedAt === undefined ? undefined : Math.max(0, now() - startedAt),
        outputPreview: debugPreview(outputTail),
      });
      this.#repo.transaction(() => {
        // CAS the session from a live state: a session already marked
        // terminated (cancelTask) or completed must not be overwritten by a
        // late exit/crash event from the same PTY teardown.
        const status = event.type === "exit" ? "completed" : "crashed";
        const claimed = this.#repo.casSessionStatus(sessionId, ["spawning", "running"], status, now());
        if (!claimed) return;
        this.#repo.updateSession(sessionId, { status, endedAt: now(), exitCode: event.exitCode });

        const task = this.#repo.getTask(taskId)!;
        if (task.status !== "running") return; // e.g. already completed by structured event

        if (event.type === "exit") {
          TaskMachine.validateTransition(task.status, "completed");
          const { event: doneEvt } = TaskMachine.transition(task, "completed", {
            resultSummary: `exited with code ${event.exitCode}`,
          });
          this.#repo.updateTask(taskId, {
            status: "completed",
            resultSummary: `exited with code ${event.exitCode}`,
          });
          this.#appendEvent(workspaceId, doneEvt);
          runtimeDebug("task.completed", { taskId, worker: agentId, sessionId });
        } else {
          TaskMachine.validateTransition(task.status, "failed");
          const { event: failEvt } = TaskMachine.transition(task, "failed", {
            error: `crashed with exit code ${event.exitCode}`,
          });
          this.#repo.updateTask(taskId, {
            status: "failed",
            error: `crashed with exit code ${event.exitCode}`,
          });
          this.#appendEvent(workspaceId, failEvt);
          runtimeDebug("task.failed", { taskId, worker: agentId, sessionId, exitCode: event.exitCode });
        }
      });
      this.#sessions.delete(sessionId);
      this.#sessionStartedAt.delete(sessionId);
      this.#sessionOutputTail.delete(sessionId);
    }
  }

  /**
   * Handle structured sideband events from a harness process: persist
   * artifacts written to the outbox and complete the owning task.
   */
  async #handleStructured(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    taskId: TaskId,
    payload: unknown,
  ): Promise<void> {
    const envelope = payload as SidebandEnvelope | undefined;
    if (!envelope || typeof envelope !== "object") return;

    const inner = (envelope.payload ?? {}) as Record<string, unknown>;

    this.#repo.transaction(() => {
      const artifactId = (inner.id as string) || envelope.id;
      const artifactType = (inner.type as Artifact["type"]) || "result";

      this.#repo.insertArtifact({
        workspaceId,
        type: artifactType,
        name: (inner.name as string) || "result",
        uri: (inner.uri as string) || `sideband://${sessionId}/${artifactId}`,
        version: 1,
        createdBy: taskId,
        taskId,
        sessionId,
        metadata: (inner.metadata as Record<string, unknown>) ?? {},
      });

      const task = this.#repo.getTask(taskId)!;
      if (task.status !== "running") return;
      TaskMachine.validateTransition(task.status, "completed");
      const { event: doneEvt } = TaskMachine.transition(task, "completed", {
        resultSummary: `artifact: ${(inner.name as string) || artifactType}`,
      });
      this.#repo.updateTask(taskId, {
        status: "completed",
        resultSummary: `artifact: ${(inner.name as string) || artifactType}`,
      });
      this.#appendEvent(workspaceId, doneEvt);
    });
  }

  /** Send user input to a live worker PTY and persist the interaction event. */
  async send(workspaceId: WorkspaceId, sessionId: SessionId, input: string): Promise<void> {
    const tracking = this.#sessions.get(sessionId);
    if (!tracking) throw new Error(`No active session: ${sessionId}`);
    const harness = this.#registry.get(tracking.agentId);
    if (!harness) throw new Error(`No harness registered for agent ${tracking.agentId}`);
    await harness.send(sessionId, input);
    this.#appendEvent(workspaceId, {
      type: "user.input",
      payload: { input },
      taskId: tracking.taskId,
      sessionId,
      source: { type: "user", id: "ui" },
    });
  }

  /**
   * Write a peer-to-peer message envelope into a live session's inbox
   * (October-style message_peer over canvas edges). The harness must be
   * registered and the session active; the envelope is persisted so the
   * receiving process can consume it from its sideband inbox. Emits a
   * session.message event for SSE visibility.
   */
  async sendPeerMessage(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    fromAgentId: AgentId,
    text: string,
  ): Promise<void> {
    const tracking = this.#sessions.get(sessionId);
    if (!tracking) throw new Error(`No active session: ${sessionId}`);
    const harness = this.#registry.get(tracking.agentId);
    if (!harness) throw new Error(`No harness registered for agent ${tracking.agentId}`);
    await harness.writeMessage(sessionId, fromAgentId, text);
    this.#appendEvent(workspaceId, {
      type: "session.message",
      payload: { from: fromAgentId, text },
      taskId: tracking.taskId,
      sessionId,
      source: { type: "agent", id: fromAgentId },
    });
  }

  /** Interrupt a live worker PTY and persist the interaction event. */
  async interrupt(workspaceId: WorkspaceId, sessionId: SessionId): Promise<void> {
    const tracking = this.#sessions.get(sessionId);
    if (!tracking) throw new Error(`No active session: ${sessionId}`);
    const harness = this.#registry.get(tracking.agentId);
    if (!harness) throw new Error(`No harness registered for agent ${tracking.agentId}`);
    await harness.interrupt(sessionId);
    this.#appendEvent(workspaceId, {
      type: "user.interrupt",
      payload: {},
      taskId: tracking.taskId,
      sessionId,
      source: { type: "user", id: "ui" },
    });
  }

  /** Resize a live worker PTY and persist the interaction event. */
  async resize(workspaceId: WorkspaceId, sessionId: SessionId, cols: number, rows: number): Promise<void> {
    const tracking = this.#sessions.get(sessionId);
    if (!tracking) throw new Error(`No active session: ${sessionId}`);
    const harness = this.#registry.get(tracking.agentId);
    if (!harness) throw new Error(`No harness registered for agent ${tracking.agentId}`);
    await harness.resize(sessionId, cols, rows);
    this.#appendEvent(workspaceId, {
      type: "user.resize",
      payload: { cols, rows },
      taskId: tracking.taskId,
      sessionId,
      source: { type: "user", id: "ui" },
    });
  }

  // -------------------------------------------------------------------------
  // Cancel & retry
  // -------------------------------------------------------------------------

  async cancelTask(workspaceId: WorkspaceId, taskId: TaskId): Promise<void> {
    const task = this.#repo.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    // 1. Request PTY termination for every live session of the task.
    const targets: Array<{ sessionId: string; harness: HarnessLike }> = [];
    for (const [sessionId, tracking] of this.#sessions) {
      if (tracking.taskId !== taskId) continue;
      const harness = this.#registry.get(tracking.agentId);
      if (harness) targets.push({ sessionId, harness });
    }
    await Promise.all(targets.map(({ sessionId, harness }) => harness.terminate(sessionId).catch(() => {})));

    // 2. Atomically: CAS the task from its CURRENT status to cancelled, CAS
    //    every live session to terminated, and append the cancellation event.
    //    A task that completed/failed while terminate awaited is left as-is.
    this.#repo.transaction(() => {
      const current = this.#repo.getTask(taskId);
      if (!current) throw new Error(`Task ${taskId} not found`);
      if (current.status === "cancelled") return;
      TaskMachine.validateTransition(current.status, "cancelled");
      const claimed = this.#repo.casTaskStatus(taskId, current.status, "cancelled");
      if (!claimed) return;
      for (const { sessionId } of targets) {
        this.#repo.casSessionStatus(sessionId, ["spawning", "running"], "terminated", now());
        this.#sessions.delete(sessionId);
        this.#sessionStartedAt.delete(sessionId);
        this.#sessionOutputTail.delete(sessionId);
      }
      const { event } = TaskMachine.transition(current, "cancelled");
      this.#appendEvent(workspaceId, event);
    });
  }

  // -------------------------------------------------------------------------
  // Human approval gate (spec §11.3)
  // -------------------------------------------------------------------------

  /**
   * Hold a task behind a pending human approval. The first encounter
   * persists the approval row (idempotently) and transitions the task
   * pending → blocked with an approval.requested event.
   */
  async #requestApproval(workspaceId: WorkspaceId, task: Task): Promise<void> {
    const approvalId = task.approvalId;
    if (!approvalId) return;

    this.#repo.transaction(() => {
      const current = this.#repo.getTask(task.id);
      if (!current) return;
      const approval = this.#repo.getApproval(approvalId);
      if (approval && approval.status !== "pending") return;

      if (!approval) {
        // Standalone path: the orchestrator normally pre-creates the row.
        this.#repo.insertApproval({
          id: approvalId,
          workspaceId,
          taskId: task.id,
          status: "pending",
          requester: current.assignedTo ?? "orchestrator",
          reason: `Task ${task.id} (${task.title}) requires human approval`,
        });
      }

      // Once blocked, this durable gate has already been announced. Repeated
      // Automation polling must not duplicate approval.requested history.
      if (current.status !== "pending") return;
      TaskMachine.validateTransition(current.status, "blocked");
      const { event } = TaskMachine.transition(current, "blocked", {
        error: "awaiting human approval",
      });
      this.#repo.updateTask(task.id, { status: "blocked", error: "awaiting human approval" });
      this.#appendEvent(workspaceId, event);

      this.#appendEvent(workspaceId, {
        type: "approval.requested",
        payload: { approvalId, requester: current.assignedTo ?? "orchestrator", reason: `Task ${task.id} (${task.title}) requires human approval` },
        taskId: task.id,
        source: { type: "runtime", id: "approval-manager" },
      });
    });
  }

  /**
   * Resolve a pending approval. Accepted: blocked → assigned so the normal
   * dispatch loop spawns the session. Rejected: blocked → cancelled. Always
   * persists an approval.resolved event; re-resolution is a no-op.
   */
  async resolveApproval(
    workspaceId: WorkspaceId,
    approvalId: string,
    decision: ApprovalDecision,
    approver: string,
  ): Promise<Approval> {
    return this.#repo.transaction(() => {
      const approval = this.#repo.getApproval(approvalId);
      if (!approval) throw new Error(`Approval not found: ${approvalId}`);
      if (approval.status !== "pending") return approval;

      const resolved = this.#repo.resolveApproval(approvalId, decision, approver);
      const task = this.#repo.getTask(approval.taskId);
      if (task && task.status === "blocked") {
        const to = decision === "accepted" ? "assigned" : "cancelled";
        TaskMachine.validateTransition(task.status, to);
        const { event } = TaskMachine.transition(task, to, {
          error: decision === "rejected" ? "rejected by human approval" : undefined,
        });
        this.#repo.updateTask(task.id, { status: to, error: decision === "rejected" ? "rejected by human approval" : undefined });
        this.#appendEvent(workspaceId, event);
      }

      this.#appendEvent(workspaceId, {
        type: "approval.resolved",
        payload: { approvalId, decision, approver, taskId: approval.taskId },
        taskId: approval.taskId,
        source: { type: "user", id: approver },
      });
      return resolved;
    });
  }


  /** Retry a failed/blocked task within the bounded retry budget. */
  async retryTask(workspaceId: WorkspaceId, taskId: TaskId): Promise<void> {
    const task = this.#repo.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== "failed" && task.status !== "blocked") {
      throw new Error(`Task ${taskId} is not retryable from status ${task.status}`);
    }
    if (task.retryCount >= this.#maxRetries) {
      throw new Error(
        `Task ${taskId} exceeds retry budget (${task.retryCount}/${this.#maxRetries})`,
      );
    }

    // #dispatchOne performs the failed/blocked → running transition and spawn.
    await this.#dispatchOne(workspaceId, task);
  }

  // -------------------------------------------------------------------------
  // Event helpers
  // -------------------------------------------------------------------------

  #appendEvent(
    workspaceId: WorkspaceId,
    eventSpec: {
      type: string;
      payload: unknown;
      taskId?: TaskId;
      sessionId?: SessionId;
      source?: EntityRef;
    },
  ): RuntimeEvent {
    const event = this.#repo.appendEvent({
      workspaceId,
      source: eventSpec.source ?? { type: "runtime", id: "scheduler" },
      type: eventSpec.type,
      payload: eventSpec.payload,
      taskId: eventSpec.taskId,
      sessionId: eventSpec.sessionId,
    });
    if (this.#onEvent) this.#onEvent(event);
    return event;
  }
}
