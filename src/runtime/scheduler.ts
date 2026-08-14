import { now } from "../core/ids.ts";
import type {
  Task,
  RuntimeEvent,
  Artifact,
  WorkspaceId,
  TaskId,
  SessionId,
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
  spawn(opts: { sessionId?: string; cols?: number; rows?: number }): Promise<{ id: string; pid: number }>;
  writeContextRefs(sessionId: string, refs: ContextReference[]): Promise<string>;
  events(sessionId: string): AsyncIterable<HarnessEvent>;
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
    const snapshot = this.#repo.getWorkspaceSnapshot(workspaceId);
    const completedIds = new Set(
      snapshot.tasks.filter(t => t.status === "completed").map(t => t.id),
    );

    const runningCount = snapshot.tasks.filter(t => t.status === "running").length;
    const available = this.#maxConcurrency - runningCount;
    if (available <= 0) return 0;


    // Runnable: pending or assigned with an agent and all deps completed,
    // sorted by descending priority then ascending createdAt. Tasks without
    // an assigned agent wait for the orchestrator — never auto-assigned here.
    const runnable = snapshot.tasks
      .filter(t => (t.status === "pending" || t.status === "assigned") && t.assignedTo != null)
      .filter(t => t.dependencies.every(dep => completedIds.has(dep)))
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);

    let dispatched = 0;
    for (const task of runnable) {
      if (dispatched >= available) break;
      await this.#dispatchOne(workspaceId, task);
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
  async #dispatchOne(workspaceId: WorkspaceId, task: Task): Promise<void> {
    const agentId = task.assignedTo;
    if (!agentId) {
      throw new Error(`Task ${task.id} has no assigned agent`);
    }
    const harness = this.#registry.get(agentId);
    if (!harness) {
      throw new Error(`No harness registered for agent ${agentId}`);
    }

    this.#repo.transaction(() => {
      let current = task;

      // pending → assigned (agent chosen by the orchestrator)
      if (current.status === "pending") {
        TaskMachine.validateTransition(current.status, "assigned");
        const { event } = TaskMachine.transition(current, "assigned", {
          assignedTo: agentId,
        });
        this.#repo.updateTask(current.id, { status: "assigned", assignedTo: agentId });
        this.#appendEvent(workspaceId, event);
        current = this.#repo.getTask(current.id)!;
      }

      // failed/blocked → running (bounded retry)
      if (current.status === "failed" || current.status === "blocked") {
        if (current.retryCount >= this.#maxRetries) {
          throw new Error(
            `Task ${current.id} exceeds retry budget (${current.retryCount}/${this.#maxRetries})`,
          );
        }
        TaskMachine.validateTransition(current.status, "running");
        const { event: retryEvt } = TaskMachine.transition(current, "running", {
          retryCount: current.retryCount + 1,
          error: undefined,
        });
        this.#repo.updateTask(current.id, {
          status: "running",
          retryCount: current.retryCount + 1,
          error: undefined,
        });
        this.#appendEvent(workspaceId, retryEvt);
        current = this.#repo.getTask(current.id)!;
      }

      // assigned → running (skip if already transitioned from failed/blocked)
      if (current.status === "assigned") {
        const { event: runEvt } = TaskMachine.transition(current, "running");
        this.#repo.updateTask(current.id, { status: "running" });
        this.#appendEvent(workspaceId, runEvt);
      }

      // Session record persisted BEFORE spawn.
      const sessionInput: SessionInput = {
        workspaceId,
        harnessId: harness.id,
        agentId,
        taskId: task.id,
        status: "spawning",
        command: harness.command,
        args: harness.args,
        cwd: harness.cwd,
        cols: 120,
        rows: 40,
      };
      this.#repo.insertSession(sessionInput);

    });

    // Fetch the persisted session id, then spawn and wire async lifecycle.
    const session = this.#repo
      .listSessions(workspaceId)
      .findLast(s => s.taskId === task.id && s.status === "spawning");
    if (!session) {
      throw new Error(`Session for task ${task.id} not found after insert`);
    }

    this.#sessions.set(session.id, { taskId: task.id, agentId });

    try {
      const spawned = await harness.spawn({
        sessionId: session.id,
        cols: 120,
        rows: 40,
      });
      this.#repo.updateSession(session.id, { status: "running", pid: spawned.pid });

      // Inject task context refs into sideband inbox (after spawn).
      if (task.contextRefs.length > 0) {
        await harness.writeContextRefs(session.id, task.contextRefs);
      }


    } catch (err: unknown) {
      // Spawn failure — mark session crashed, task failed.
      const message = err instanceof Error ? err.message : String(err);
      this.#repo.transaction(() => {
        this.#repo.updateSession(session.id, { status: "crashed", endedAt: now() });
        const currentTask = this.#repo.getTask(task.id)!;
        if (currentTask.status !== "running") return;
        const { event: failEvt } = TaskMachine.transition(currentTask, "failed", {
          error: `spawn failed: ${message}`,
          retryCount: currentTask.retryCount + 1,
        });
        this.#repo.updateTask(task.id, {
          status: "failed",
          error: `spawn failed: ${message}`,
          retryCount: currentTask.retryCount + 1,
        });
        this.#appendEvent(workspaceId, failEvt);
      });
      this.#sessions.delete(session.id);
    }
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

    if (event.type === "data") return; // terminal output — no transition

    if (event.type === "structured") {
      await this.#handleStructured(workspaceId, sessionId, taskId, event.payload);
      return;
    }

    if (event.type === "exit" || event.type === "crash") {
      this.#repo.transaction(() => {
        this.#repo.updateSession(sessionId, {
          status: event.type === "exit" ? "completed" : "crashed",
          endedAt: now(),
          exitCode: event.exitCode,
        });

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
          TaskMachine.validateTransition(task.status, "failed");
          const { event: failEvt } = TaskMachine.transition(task, "failed", {
            error: `crashed with exit code ${event.exitCode}`,
            retryCount: task.retryCount + 1,
          });
          this.#repo.updateTask(taskId, {
            status: "failed",
            error: `crashed with exit code ${event.exitCode}`,
            retryCount: task.retryCount + 1,
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

  // -------------------------------------------------------------------------
  // Cancel & retry
  // -------------------------------------------------------------------------

  async cancelTask(workspaceId: WorkspaceId, taskId: TaskId): Promise<void> {
    const task = this.#repo.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    for (const [sessionId, tracking] of this.#sessions) {
      if (tracking.taskId === taskId) {
        const harness = this.#registry.get(tracking.agentId);
        if (harness) {
          await harness.terminate(sessionId).catch(() => {});
        }
        break;
      }
    }

    TaskMachine.validateTransition(task.status, "cancelled");
    const { event } = TaskMachine.transition(task, "cancelled");
    this.#repo.updateTask(taskId, { status: "cancelled" });
    this.#appendEvent(workspaceId, event);
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
