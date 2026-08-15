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
} from "../core/types.ts";
import type { Repository, SessionInput } from "../persistence/database.ts";
import type { HarnessEvent } from "../harness/generic.ts";
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
  send(sessionId: string, input: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  terminate(sessionId: string): Promise<void>;
  forget(sessionId: string): Promise<void>;
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
  async dispatchPending(workspaceId: WorkspaceId): Promise<number> {
    let dispatched = 0;

    while (true) {
      const snapshot = this.#repo.getWorkspaceSnapshot(workspaceId);
      const runningCount = snapshot.tasks.filter(t => t.status === "running").length;
      const available = this.#maxConcurrency - runningCount;
      if (available <= 0) break;

      const completedIds = new Set(
        snapshot.tasks.filter(t => t.status === "completed").map(t => t.id),
      );
      const runnable = snapshot.tasks
        .filter(t => (t.status === "pending" || t.status === "assigned") && t.assignedTo != null)
        .filter(t => t.dependencies.every(dep => completedIds.has(dep)))
        .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
      if (runnable.length === 0) break;

      const session = await this.#dispatchOne(workspaceId, runnable[0]);
      if (!session) break;
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

      const sessionInput: SessionInput = {
        workspaceId,
        harnessId: harness.id,
        agentId,
        taskId: dispatchTask.id,
        status: "spawning",
        command: harness.command,
        args: harness.args,
        cwd: harness.cwd,
        cols: 120,
        rows: 40,
      };
      return this.#repo.insertSession(sessionInput);
    });

    if (!session || !harness) return null;

    this.#sessions.set(session.id, { taskId: session.taskId, agentId: session.agentId });
    const freshTask = this.#repo.getTask(task.id)!;

    try {
      const spawned = await harness.spawn({
        sessionId: session.id,
        cols: 120,
        rows: 40,
      });
      this.#repo.updateSession(session.id, { status: "running", pid: spawned.pid });

      if (freshTask.contextRefs.length > 0) {
        await harness.writeContextRefs(session.id, freshTask.contextRefs);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.#repo.transaction(() => {
        this.#repo.updateSession(session.id, { status: "crashed", endedAt: now() });
        const currentTask = this.#repo.getTask(task.id)!;
        if (currentTask.status !== "running") return;
        const retryCount = Math.min(currentTask.retryCount + 1, this.#maxRetries + 1);
        const { event: failEvt } = TaskMachine.transition(currentTask, "failed", {
          error: `spawn failed: ${message}`,
          retryCount,
        });
        this.#repo.updateTask(task.id, {
          status: "failed",
          error: `spawn failed: ${message}`,
          retryCount,
        });
        this.#appendEvent(workspaceId, failEvt);
      });
      this.#sessions.delete(session.id);
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
      console.error(`[sched] handleSessionEvent ${event.type} NO-TRACKING session=${sessionId.slice(0,8)}`);
      return;
    }
    const { taskId } = tracking;
    console.error(`[sched] handleSessionEvent ${event.type} task=${taskId.slice(0,8)} session=${sessionId.slice(0,8)}`);

    if (event.type === "data") {
      const payload = event.data;
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
      await this.#handleStructured(workspaceId, sessionId, taskId, event.payload);
      return;
    }

    if (event.type === "exit" || event.type === "crash") {
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
        } else {
          // Bound retryCount at maxRetries+1 so the budget check in
          // retryTask/dispatch stays authoritative for re-dispatch.
          const retryCount = Math.min(task.retryCount + 1, this.#maxRetries + 1);
          TaskMachine.validateTransition(task.status, "failed");
          const { event: failEvt } = TaskMachine.transition(task, "failed", {
            error: `crashed with exit code ${event.exitCode}`,
            retryCount,
          });
          this.#repo.updateTask(taskId, {
            status: "failed",
            error: `crashed with exit code ${event.exitCode}`,
            retryCount,
          });
          this.#appendEvent(workspaceId, failEvt);
        }
      });

      this.#sessions.delete(sessionId);
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
      }
      const { event } = TaskMachine.transition(current, "cancelled");
      this.#appendEvent(workspaceId, event);
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
