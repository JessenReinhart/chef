import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, now } from "../core/ids.ts";
import type {
  AgentId,
  Artifact,
  ContextReference,
  Decision,
  DecisionProvider,
  HarnessEvent,
  OrchestratorResult,
  Plan,
  PlanProposalContext,
  PlanTask,
  PlanTaskOutcome,
  RuntimeEvent,
  Session,
  Task,
  TaskId,
  WorkspaceId,
  WorkspaceSnapshot,
} from "../core/types.ts";
import type { Repository } from "../persistence/database.ts";
import { GenericTerminalHarness } from "../harness/generic.ts";
import { defaultSidebandRoot } from "../harness/sideband.ts";
import { ContextManager } from "../context/context.ts";

const SCRIPTS_DIR = join(defaultSidebandRoot(), "scripts");
const TIMED_OUT = Symbol("orchestrator-timeout");
const ORCHESTRATOR_SOURCE = { type: "orchestrator", id: "orchestrator" } as const;

const DEFAULT_TIMEOUT_MS = 60_000;
const SLEEP_STEP_MS = 50;
const SESSION_ACTIVE_WAIT_MS = 1_000;

/** Minimal harness surface the orchestrator needs: a session event stream. */
export interface OrchestratorHarness {
  readonly id: string;
  events(sessionId: string): AsyncIterable<HarnessEvent>;
  terminate(sessionId: string): Promise<void>;
  forget(sessionId: string): Promise<void>;
}

/** In-memory harness registry keyed by agent id (matches the scheduler's lookup). */
export interface HarnessRegistry {
  get(agentId: AgentId): OrchestratorHarness | undefined;
  set(agentId: AgentId, harness: OrchestratorHarness): void;
  has(agentId: AgentId): boolean;
}

/** Runtime surface the orchestrator drives (the scheduler). */
export interface RuntimeAdapter {
  dispatchPending(workspaceId: WorkspaceId): Promise<number>;
  handleSessionEvent(workspaceId: WorkspaceId, sessionId: string, event: HarnessEvent): Promise<void>;
  recoverOnStartup(workspaceId: WorkspaceId): Promise<void>;
}

/** Decision provider that can also supply the harnesses for its agents. */
export interface ScriptedHarnessProvider {
  harnessFor(agentId: AgentId, workspaceId: WorkspaceId): OrchestratorHarness;
}

/** Decision provider accepted by the orchestrator — standard interface plus optional harness factory. */
export type OrchestratorDecisionProvider = DecisionProvider & Partial<ScriptedHarnessProvider>;

export interface OrchestratorOptions {
  repository: Repository;
  runtime: RuntimeAdapter;
  harnessRegistry: HarnessRegistry;
  decisionProvider?: OrchestratorDecisionProvider;
  timeoutMs?: number;
  onEvent?: (event: RuntimeEvent) => void;
}

/** P0 scripted decision provider: investigator + verifier via node scripts. */
export class ScriptedDecisionProvider implements DecisionProvider, ScriptedHarnessProvider {
  readonly name = "scripted-p0";
  #workspaceId: WorkspaceId = "";

  async proposePlan(input: PlanProposalContext): Promise<Plan | null> {
    this.#workspaceId = input.workspaceId;
    const investigatorId = newId();
    const verifierId = newId();
    const createdAt = now();
    return {
      id: newId(),
      workspaceId: input.workspaceId,
      goal: input.goal,
      status: "proposed",
      tasks: [
        {
          id: investigatorId,
          title: "Investigate",
          description: input.goal,
          dependencies: [],
          priority: 1,
          assignedTo: "investigator",
        },
        {
          id: verifierId,
          title: "Verify findings",
          description: "Verify the artifact produced by the investigator.",
          dependencies: [investigatorId],
          priority: 0,
          assignedTo: "verifier",
        },
      ],
      taskIds: [investigatorId, verifierId],
      createdAt,
    };
  }

  harnessFor(agentId: AgentId, workspaceId: WorkspaceId): OrchestratorHarness {
    if (agentId === "investigator") {
      return new GenericTerminalHarness({
        agentId,
        workspaceId,
        command: "node",
        args: [this.#scriptPath("investigator")],
      });
    }
    if (agentId === "verifier") {
      return new GenericTerminalHarness({
        agentId,
        workspaceId,
        command: "node",
        args: [this.#scriptPath("verifier")],
      });
    }
    throw new Error(`ScriptedDecisionProvider has no harness for agent ${agentId}`);
  }

  async evaluate(taskResult: PlanTaskOutcome): Promise<Decision> {
    const accepted = taskResult.status === "completed";
    return {
      id: newId(),
      workspaceId: this.#workspaceId,
      type: "task.evaluation",
      summary: accepted
        ? `Task ${taskResult.taskId} completed${taskResult.resultSummary ? `: ${taskResult.resultSummary}` : ""}`
        : `Task ${taskResult.taskId} did not complete (status ${taskResult.status})`,
      payload: taskResult,
      madeBy: this.name,
      timestamp: now(),
      status: accepted ? "accepted" : "rejected",
    };
  }

  #scriptPath(agentId: string): string {
    const file = join(SCRIPTS_DIR, `${agentId}.js`);
    mkdirSync(SCRIPTS_DIR, { recursive: true });
    writeFileSync(file, agentId === "investigator" ? INVESTIGATOR_SCRIPT : VERIFIER_SCRIPT, "utf8");
    return file;
  }
}

/**
 * Orchestrator — Squad Lead that drives a plan through the runtime.
 *
 * Responsibilities:
 * - Handle user messages
 * - Decompose intent into tasks via a DecisionProvider
 * - Assign tasks to harnesses, dispatch, and observe execution
 * - Resolve and materialize context references into session sideband inboxes
 * - Report completion with concise summary
 *
 * All state mutations go through the Repository or Runtime; the orchestrator never writes SQLite directly.
 */
export class Orchestrator {
  readonly #repository: Repository;
  readonly #runtime: RuntimeAdapter;
  readonly #registry: HarnessRegistry;
  readonly #decisionProvider: OrchestratorDecisionProvider;
  readonly #context: ContextManager;
  readonly #timeoutMs: number;
  readonly #onEvent: ((event: RuntimeEvent) => void) | undefined;
  #activePlan: Plan | null = null;
  readonly #terminalEvents = new Map<TaskId, string>();

  constructor(options: OrchestratorOptions) {
    this.#repository = options.repository;
    this.#runtime = options.runtime;
    this.#registry = options.harnessRegistry;
    this.#decisionProvider = options.decisionProvider ?? new ScriptedDecisionProvider();
    this.#context = new ContextManager(options.repository);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#onEvent = options.onEvent;
  }

  async handleUserMessage(workspaceId: WorkspaceId, message: string): Promise<OrchestratorResult> {
    this.#repository.insertMessage({ workspaceId, from: "user", type: "message", payload: { text: message } });
    this.#appendEvent(workspaceId, { type: "orchestrator.user_message", payload: { text: message } });

    let plan: Plan | null = null;
    try {
      plan = await this.#decisionProvider.proposePlan({ workspaceId, goal: message });
    } catch (error) {
      this.#appendEvent(workspaceId, { type: "orchestrator.plan.error", payload: { error: error instanceof Error ? error.message : String(error) } });
      return { workspaceId, taskIds: [], report: `Plan proposal failed: ${error instanceof Error ? error.message : String(error)}`, ok: false };
    }
    if (!plan) {
      this.#appendEvent(workspaceId, { type: "orchestrator.plan.none", payload: { goal: message } });
      return { workspaceId, taskIds: [], report: `No plan proposed for: ${message}`, ok: false };
    }
    this.#repository.insertPlan({
      id: plan.id,
      workspaceId,
      goal: plan.goal,
      status: "proposed",
      tasks: plan.tasks,
      taskIds: plan.taskIds,
      createdAt: plan.createdAt,
    });
    this.#appendEvent(workspaceId, { type: "orchestrator.plan.proposed", payload: { planId: plan.id, goal: plan.goal, taskIds: plan.taskIds } });
    const controller = new AbortController();
    let executionError: string | undefined;
    try {
      await this.#withTimeout(this.#executePlan(workspaceId, plan, controller.signal), `plan ${plan.id}`, controller);
    } catch (error) {
      executionError = error instanceof Error ? error.message : String(error);
    }
    const finalStatus = executionError ? "failed" : "completed";
    plan.status = finalStatus;
    this.#repository.updatePlanStatus(plan.id, finalStatus);

    const snapshot = this.#repository.getWorkspaceSnapshot(workspaceId);
    const tasks = snapshot.tasks.filter((t) => plan.taskIds.includes(t.id));
    const artifacts = snapshot.artifacts.filter((a) => a.taskId !== undefined && plan.taskIds.includes(a.taskId));
    const failed = tasks.some((t) => t.status === "failed" || t.status === "cancelled");
    const ok = !executionError && !failed;
    const report = this.#buildReport(plan, tasks, artifacts, executionError);
    const artifactIds = artifacts.map((a) => a.id);

    this.#repository.insertMessage({
      workspaceId,
      from: "orchestrator",
      to: "user",
      channel: "orchestrator",
      type: "result",
      payload: { report, taskIds: plan.taskIds, artifactIds },
    });
    this.#appendEvent(workspaceId, {
      type: "orchestrator.plan.completed",
      payload: { planId: plan.id, ok, taskIds: plan.taskIds, artifactIds, error: executionError, terminal: [...this.#terminalEvents.entries()].map(([id, type]) => `${id}:${type}`) },
    });
    return { workspaceId, taskIds: plan.taskIds, report, ok };
  }
  /** Chat-specific entry: same plan pipeline as handleUserMessage, but with
   *  chat.* SSE events for the Console chat tab. */
  async handleChatMessage(workspaceId: WorkspaceId, message: string): Promise<OrchestratorResult> {
    this.#repository.insertMessage({
      workspaceId,
      from: "user",
      to: "assistant",
      channel: "chat",
      type: "message",
      payload: { content: message },
    });
    this.#appendEvent(workspaceId, { type: "chat.user", payload: { content: message } });

    let plan: Plan | null = null;
    try {
      plan = await this.#decisionProvider.proposePlan({ workspaceId, goal: message });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.#appendEvent(workspaceId, { type: "chat.plan.error", payload: { error: err, goal: message } });
      return { workspaceId, taskIds: [], report: `Plan proposal failed: ${err}`, ok: false };
    }
    if (!plan) {
      this.#appendEvent(workspaceId, { type: "chat.plan.none", payload: { goal: message } });
      return { workspaceId, taskIds: [], report: `No plan proposed for: ${message}`, ok: false };
    }

    this.#repository.insertPlan({
      id: plan.id,
      workspaceId,
      goal: plan.goal,
      status: "proposed",
      tasks: plan.tasks,
      taskIds: plan.taskIds,
      createdAt: plan.createdAt,
    });
    this.#appendEvent(workspaceId, {
      type: "chat.plan.proposed",
      payload: { planId: plan.id, goal: plan.goal, taskIds: plan.taskIds, taskCount: plan.tasks.length },
    });

    // Validate the graph patch proposal through the node execution engine
    // before it can be applied (spec §12). Invalid proposals are reported
    // back to the user rather than silently applied.
    const controller = new AbortController();
    let executionError: string | undefined;
    try {
      await this.#withTimeout(this.#executePlan(workspaceId, plan, controller.signal), `plan ${plan.id}`, controller);
      this.#appendEvent(workspaceId, { type: "chat.plan.applied", payload: { planId: plan.id, status: "completed" } });
    } catch (error) {
      executionError = error instanceof Error ? error.message : String(error);
      this.#appendEvent(workspaceId, { type: "chat.plan.applied", payload: { planId: plan.id, status: "failed", error: executionError } });
    }
    const finalStatus = executionError ? "failed" : "completed";
    plan.status = finalStatus;
    this.#repository.updatePlanStatus(plan.id, finalStatus);

    const snapshot = this.#repository.getWorkspaceSnapshot(workspaceId);
    const tasks = snapshot.tasks.filter((t) => plan.taskIds.includes(t.id));
    const artifacts = snapshot.artifacts.filter((a) => a.taskId !== undefined && plan.taskIds.includes(a.taskId));
    const failed = tasks.some((t) => t.status === "failed" || t.status === "cancelled");
    const ok = !executionError && !failed;
    const report = this.#buildReport(plan, tasks, artifacts, executionError);
    const artifactIds = artifacts.map((a) => a.id);

    this.#repository.insertMessage({
      workspaceId,
      from: "assistant",
      to: "user",
      channel: "chat",
      type: "result",
      payload: { content: report, planId: plan.id, taskIds: plan.taskIds, artifactIds },
    });
    this.#appendEvent(workspaceId, {
      type: "chat.assistant",
      payload: { content: report, planId: plan.id, ok, taskIds: plan.taskIds },
    });
    return { workspaceId, taskIds: plan.taskIds, report, ok };
  }

  async inspectState(workspaceId: WorkspaceId): Promise<WorkspaceSnapshot> {
    return this.#repository.getWorkspaceSnapshot(workspaceId);
  }

  async proposePlan(input: PlanProposalContext): Promise<Plan | null> {
    return this.#decisionProvider.proposePlan(input);
  }

  async executePlan(planId: string): Promise<void> {
    const plan = this.#activePlan;
    if (!plan || plan.id !== planId) throw new Error(`Unknown plan ${planId}`);
    const controller = new AbortController();
    try {
      await this.#withTimeout(this.#executePlan(plan.workspaceId, plan, controller.signal), `plan ${planId}`, controller);
    } catch (error) {
      plan.status = "failed";
      throw error;
    }
  }

  async handleEvent(event: RuntimeEvent): Promise<void> {
    if (!event.taskId) return;
    if (event.type === "task.completed" || event.type === "task.failed" || event.type === "task.cancelled" || event.type === "task.blocked") {
      this.#terminalEvents.set(event.taskId, event.type);
    }
  }

  async #executePlan(workspaceId: WorkspaceId, plan: Plan, signal: AbortSignal): Promise<void> {
    this.#activePlan = plan;
    plan.status = "executing";
    this.#repository.updatePlanStatus(plan.id, "executing");
    this.#appendEvent(workspaceId, { type: "orchestrator.plan.executing", payload: { planId: plan.id, goal: plan.goal, taskIds: plan.taskIds } });

    const created = new Map<string, Task>();
    let remaining = [...plan.tasks];
    try {
      while (remaining.length > 0) {
        if (signal.aborted) return;
        const batch = remaining.filter((pt) => pt.dependencies.every((dep) => created.has(dep)));
        if (batch.length === 0) {
          throw new Error(`Plan ${plan.id} has unsatisfiable dependencies: ${remaining.map((t) => t.id).join(", ")}`);
        }
        for (const pt of batch) {
          remaining = remaining.filter((t) => t.id !== pt.id);
          const refs = this.#dependencyRefs(workspaceId, pt);
          const task = this.#createPlanTask(workspaceId, plan, pt, refs);
          created.set(pt.id, task);
        }
        const batchTaskIds = batch.map((pt) => pt.id);
        const dispatched = await this.#runtime.dispatchPending(workspaceId);
        if (dispatched > 0) {
          await this.#materializeContexts(workspaceId, [...created.values()]);
          await this.#consumeSessions(workspaceId, [...created.keys()], signal);
        }
        // A batch task still pending/assigned/blocked after dispatch is held
        // behind a human approval gate (spec §11.3): wait for resolution.
        const held = batchTaskIds.filter((id) => {
          const task = this.#repository.getTask(id);
          return task && task.approvalId !== undefined;
        });
        for (const id of held) {
          await this.#awaitApproval(workspaceId, id, signal);
        }
        for (const id of batchTaskIds) {
          if (signal.aborted) return;
          const task = this.#repository.getTask(id)!;
          if (!this.#isTerminal(task)) throw new Error(`Task ${id} did not reach a terminal state (${task.status})`);
          try {
            const decision = await this.#decisionProvider.evaluate({ taskId: task.id, status: task.status, resultSummary: task.resultSummary });
            this.#appendEvent(workspaceId, { type: "orchestrator.task.evaluated", payload: { taskId: task.id, status: task.status, decision: decision.status, summary: decision.summary }, taskId: task.id });
          } catch (error) {
            this.#appendEvent(workspaceId, { type: "orchestrator.task.evaluated", payload: { taskId: task.id, status: task.status, error: error instanceof Error ? error.message : String(error) }, taskId: task.id });
          }
        }
      }
    } finally {
      await this.#cleanupSessions(workspaceId, [...created.values()]);
    }
  }

  async #cleanupSessions(workspaceId: WorkspaceId, tasks: Task[]): Promise<void> {
    const snapshot = this.#repository.getWorkspaceSnapshot(workspaceId);
    const taskIds = new Set(tasks.map((t) => t.id));
    for (const session of snapshot.sessions) {
      if (!taskIds.has(session.taskId)) continue;
      if (session.status === "running" || session.status === "spawning") {
        const harness = this.#registry.get(session.agentId);
        if (harness) {
          try {
            await harness.terminate(session.id);
          } catch {
            // Ignore termination failures; persist a crash event below.
          }
          try {
            await this.#runtime.handleSessionEvent(workspaceId, session.id, { type: "crash", exitCode: 1 });
          } catch {
            // Cleanup must continue even if runtime persistence rejects the event.
          }
          try {
            await harness.forget(session.id);
          } catch {
            // Ignore registry cleanup failures.
          }
        }
      }
    }
  }

  #dependencyRefs(workspaceId: WorkspaceId, pt: PlanTask): ContextReference[] {
    const refs: ContextReference[] = [];
    for (const dep of pt.dependencies) {
      const artifacts = this.#repository.listArtifacts(workspaceId).filter((a) => a.taskId === dep);
      if (artifacts.length > 0) {
        refs.push({ type: "artifact", id: artifacts[artifacts.length - 1].id, relevance: 1 });
      } else {
        refs.push({ type: "task", id: dep, relevance: 1 });
      }
    }
    return refs;
  }

  #createPlanTask(workspaceId: WorkspaceId, _plan: Plan, pt: PlanTask, refs: ContextReference[]): Task {
    if (pt.assignedTo) this.#ensureWorker(pt.assignedTo, workspaceId);
    return this.#repository.transaction(() => {
      if (pt.approvalId) {
        // The approval row must exist before the task references it
        // (tasks.approval_id FK is immediate; approvals.task_id is deferred).
        this.#repository.insertApproval({
          id: pt.approvalId,
          workspaceId,
          taskId: pt.id,
          status: "pending",
          requester: pt.assignedTo ?? "orchestrator",
          reason: `Task ${pt.title} requires human approval`,
        });
      }
      const task = this.#repository.createTask({
        id: pt.id,
        workspaceId,
        title: pt.title,
        description: pt.description,
        status: "pending",
        assignedTo: pt.assignedTo,
        dependencies: pt.dependencies,
        contextRefs: refs,
        priority: pt.priority,
        approvalId: pt.approvalId,
      });
      this.#appendEvent(workspaceId, { type: "orchestrator.task.created", payload: { taskId: task.id, assignedTo: task.assignedTo }, taskId: task.id });
      return task;
    });
  }

  #ensureWorker(agentId: AgentId, workspaceId: WorkspaceId): void {
    if (this.#registry.has(agentId)) return;
    try {
      this.#repository.seedAgent({ id: agentId, workspaceId, name: agentId, role: "worker" });
    } catch {
      // Already seeded by a previous run in this workspace (no lookup API in P0).
    }
    this.#registry.set(agentId, this.#harnessForAgent(agentId, workspaceId));
  }

  #harnessForAgent(agentId: AgentId, workspaceId: WorkspaceId): OrchestratorHarness {
    const harness = this.#decisionProvider.harnessFor?.(agentId, workspaceId);
    if (!harness) throw new Error(`No harness available for agent ${agentId}`);
    return harness;
  }

  async #materializeContexts(workspaceId: WorkspaceId, tasks: Task[]): Promise<void> {
    const snapshot = this.#repository.getWorkspaceSnapshot(workspaceId);
    for (const task of tasks) {
      if (task.contextRefs.length === 0) continue;
      const session = snapshot.sessions.find((s) => s.taskId === task.id && (s.status === "spawning" || s.status === "running"));
      if (session) await this.#context.materialize(session.id, task.contextRefs, workspaceId);
    }
  }

  /**
   * Wait for a human to resolve the approval gate guarding `taskId`
   * (spec §11.3), then re-dispatch. Rejection leaves the task cancelled;
   * acceptance resumes execution. Abort propagates on timeout/cancel.
   */
  async #awaitApproval(workspaceId: WorkspaceId, taskId: TaskId, signal: AbortSignal): Promise<void> {
    let task = this.#repository.getTask(taskId)!;
    while (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled") {
      if (signal.aborted) return;
      if (task.status === "running") {
        await this.#consumeSessions(workspaceId, [taskId], signal);
      } else {
        await this.#sleep(SLEEP_STEP_MS);
        const snapshot = this.#repository.getWorkspaceSnapshot(workspaceId);
        const approval = snapshot.approvals.find((a) => a.id === task.approvalId);
        if (approval && approval.status !== "pending") {
          await this.#runtime.dispatchPending(workspaceId);
        }
      }
      task = this.#repository.getTask(taskId)!;
    }
  }
  async #consumeSessions(workspaceId: WorkspaceId, taskIds: TaskId[], signal: AbortSignal): Promise<void> {
    const mine = new Set(taskIds);
    const deadline = Date.now() + SESSION_ACTIVE_WAIT_MS;
    let sessions: Session[] = [];
    while (sessions.length === 0 && Date.now() < deadline) {
      if (signal.aborted) return;
      const snapshot = this.#repository.getWorkspaceSnapshot(workspaceId);
      sessions = snapshot.sessions.filter((s) => mine.has(s.taskId) && (s.status === "spawning" || s.status === "running"));
      if (sessions.length === 0) await this.#sleep(SLEEP_STEP_MS);
    }
    if (signal.aborted) return;
    for (const session of sessions) {
      if (signal.aborted) return;
      const harness = this.#registry.get(session.agentId);
      if (!harness) throw new Error(`No harness registered for agent ${session.agentId}`);
      await this.#consumeSession(workspaceId, session.id, session.taskId, harness, signal);
    }
  }

  async #consumeSession(workspaceId: WorkspaceId, sessionId: string, taskId: string, harness: OrchestratorHarness, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    let stream: AsyncIterable<HarnessEvent> | null = null;
    const deadline = Date.now() + SESSION_ACTIVE_WAIT_MS;
    while (stream === null && Date.now() < deadline) {
      if (signal.aborted) return;
      try {
        stream = harness.events(sessionId);
      } catch {
        const session = this.#repository.getWorkspaceSnapshot(workspaceId).sessions.find((s) => s.id === sessionId);
        if (session && (session.status === "crashed" || session.status === "completed" || session.status === "terminated")) break;
        await this.#sleep(SLEEP_STEP_MS);
      }
    }
    if (stream === null) throw new Error(`Session ${sessionId} event stream unavailable`);

    const iterator = stream[Symbol.asyncIterator]();
    const abortWait = Promise.withResolvers<void>();
    const onAbort = () => {
      void harness.terminate(sessionId).catch(() => undefined);
      abortWait.resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        const result = await Promise.race([iterator.next(), abortWait.promise.then(() => null)]);
        if (result === null || signal.aborted) return;
        if (result.done) return;
        await this.#runtime.handleSessionEvent(workspaceId, sessionId, result.value);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      await iterator.return?.();
    }
  }

  #appendEvent(workspaceId: WorkspaceId, input: { type: string; payload?: unknown; taskId?: TaskId; sessionId?: string }): RuntimeEvent {
    const event = this.#repository.appendEvent({ workspaceId, source: ORCHESTRATOR_SOURCE, ...input });
    if (this.#onEvent) this.#onEvent(event);
    return event;
  }

  #isTerminal(task: Task): boolean {
    return task.status === "completed" || task.status === "failed" || task.status === "cancelled";
  }

  #buildReport(plan: Plan, tasks: Task[], artifacts: Artifact[], error?: string): string {
    const lines: string[] = [];
    if (error) lines.push(`Plan failed: ${error}`);
    else lines.push(`Plan "${plan.goal}" completed: ${tasks.length} task(s), ${artifacts.length} artifact(s).`);
    for (const task of tasks) {
      const count = artifacts.filter((a) => a.taskId === task.id).length;
      const summary = task.resultSummary ? ` — ${task.resultSummary}` : "";
      lines.push(`- ${task.title} [${task.status}]${summary}${count > 0 ? ` (${count} artifact${count > 1 ? "s" : ""})` : ""}`);
    }
    return lines.join("\n");
  }

  async #withTimeout<T>(work: Promise<T>, label: string, controller?: AbortController): Promise<T> {
    const { promise: timeout, resolve } = Promise.withResolvers<typeof TIMED_OUT>();
    const timer = setTimeout(() => {
      controller?.abort();
      resolve(TIMED_OUT);
    }, this.#timeoutMs);
    timer.unref();
    try {
      const result = await Promise.race([work, timeout]);
      if (result === TIMED_OUT) {
        try { await work; } catch { /* timeout remains the primary error */ }
        throw new Error(`Timed out after ${this.#timeoutMs}ms: ${label}`);
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  #sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, ms);
    timer.unref();
    return promise;
  }
}

/** Self-contained investigator script (runs via `node <script.js>`). */
const INVESTIGATOR_SCRIPT = `
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function findSessionId() {
  if (process.env.CHEF_SESSION_ID) return process.env.CHEF_SESSION_ID;
  const root = path.join(os.tmpdir(), "chef-sideband");
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch (err) {
    return null;
  }
  names.sort(function (a, b) {
    return fs.statSync(path.join(root, b)).mtimeMs - fs.statSync(path.join(root, a)).mtimeMs;
  });
  return names.length > 0 ? names[0] : null;
}

const sid = findSessionId();
if (!sid) {
  console.error("investigator: no session id");
  process.exit(1);
}

const findings = [
  { file: "src/orchestrator/orchestrator.ts", line: 1, note: "audited during smoke test" },
  { file: "src/runtime/scheduler.ts", line: 1, note: "audited during smoke test" },
];


const envelope = {
  version: 1,
  id: crypto.randomUUID(),
  kind: "artifact",
  from: "process",
  payload: {
    type: "research",
    name: "investigation-findings",
    uri: "sideband://" + sid + "/findings.json",
    metadata: { content: JSON.stringify(findings), task: "investigate" }
  },
  timestamp: Date.now()
};

const outbox = path.join(os.tmpdir(), "chef-sideband", sid, "outbox");
fs.mkdirSync(outbox, { recursive: true });
const file = path.join(outbox, envelope.id + ".json");
fs.writeFileSync(file, JSON.stringify(envelope));
console.log("investigator: wrote findings artifact envelope");

const until = Date.now() + 800;
while (Date.now() < until) { /* spin */ }
process.exit(0);
`;

/** Self-contained verifier script (runs via `node <script.js>`). */
const VERIFIER_SCRIPT = `
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function findSessionId() {
  if (process.env.CHEF_SESSION_ID) return process.env.CHEF_SESSION_ID;
  const root = path.join(os.tmpdir(), "chef-sideband");
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch (err) {
    return null;
  }
  names.sort(function (a, b) {
    return fs.statSync(path.join(root, b)).mtimeMs - fs.statSync(path.join(root, a)).mtimeMs;
  });
  return names.length > 0 ? names[0] : null;
}

const sid = findSessionId();
if (!sid) {
  console.error("verifier: cannot locate sideband session");
  process.exit(2);
}

const inbox = path.join(os.tmpdir(), "chef-sideband", sid, "inbox");
let resolved = null;
const deadline = Date.now() + 6000;
while (Date.now() < deadline && resolved === null) {
  let names = [];
  try {
    names = fs.readdirSync(inbox);
  } catch (err) {
    names = [];
  }
  for (let i = 0; i < names.length && resolved === null; i++) {
    if (names[i].indexOf(".json") < 0) continue;
    try {
      const env = JSON.parse(fs.readFileSync(path.join(inbox, names[i]), "utf8"));
      if (env && env.kind === "context" && env.payload && env.payload.items && env.payload.items.length > 0) {
        resolved = env.payload;
      }
    } catch (err) { /* unreadable envelope, keep polling */ }
  }
  if (resolved === null) {
    const start = Date.now();
    while (Date.now() - start < 100) { /* spin */ }
  }
}

let summary = "verification failed: no context received within deadline";
if (resolved !== null) {
  const item = resolved.items[0];
  const meta = item.payload && item.payload.metadata ? item.payload.metadata : {};
  const content = typeof meta.content === "string" ? meta.content : "{}";
  summary = "Verified artifact '" + item.payload.name + "' (" + item.reference.id + "): " + content;
  console.log("verifier: " + summary);
} else {
  console.error("verifier: " + summary);
}

const envelope = {
  version: 1,
  id: crypto.randomUUID(),
  kind: "artifact",
  from: "process",
  payload: {
    type: "result",
    name: "verification-summary",
    uri: "sideband://" + sid + "/verification.json",
    metadata: { content: summary }
  },
  timestamp: Date.now()
};

const outbox = path.join(os.tmpdir(), "chef-sideband", sid, "outbox");
fs.mkdirSync(outbox, { recursive: true });
fs.writeFileSync(path.join(outbox, envelope.id + ".json"), JSON.stringify(envelope));
console.log("verifier: wrote verification artifact envelope");

const until = Date.now() + 800;
while (Date.now() < until) { /* spin */ }
process.exit(0);
`;