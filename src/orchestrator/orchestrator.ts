import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, now } from "../core/ids.ts";
import type {
  AgentId,
  Artifact,
  CanvasEdge,
  CanvasNode,
  CanvasNodeKind,
  CanvasPatch,
  CanvasPatchResult,
  ContextReference,
  Decision,
  DecisionProvider,
  HarnessEvent,
  Mission,
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
import { type CanvasEdgeRecord, type CanvasNodeRecord, type Repository } from "../persistence/database.ts";
import { computeLayout } from "../runtime/layout.ts";
import { GenericTerminalHarness } from "../harness/generic.ts";
import { defaultSidebandRoot } from "../harness/sideband.ts";
import { ContextManager } from "../context/context.ts";

const SCRIPTS_DIR = join(defaultSidebandRoot(), "scripts");
const TIMED_OUT = Symbol("orchestrator-timeout");
const ORCHESTRATOR_SOURCE = { type: "orchestrator", id: "orchestrator" } as const;
type MissionRoutingMode = "single-worker" | "planner";

function routingModeOf(plan: Plan): MissionRoutingMode | undefined {
  const value = (plan as Plan & { routingMode?: unknown }).routingMode;
  return value === "single-worker" || value === "planner" ? value : undefined;
}

class MissionTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, label: string) {
    super(`Timed out after ${timeoutMs}ms: ${label}`);
    this.name = "MissionTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

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
  dispatchPending(workspaceId: WorkspaceId, allowedTaskIds?: readonly TaskId[]): Promise<number>;
  handleSessionEvent(workspaceId: WorkspaceId, sessionId: string, event: HarnessEvent): Promise<void>;
  recoverOnStartup(workspaceId: WorkspaceId): Promise<void>;
  cancelTask(workspaceId: WorkspaceId, taskId: TaskId): Promise<void>;
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
  readonly #timeoutMs: number | undefined;
  readonly #onEvent: ((event: RuntimeEvent) => void) | undefined;
  #activePlan: Plan | null = null;
  readonly #terminalEvents = new Map<TaskId, string>();
  readonly #missionControllers = new Map<string, AbortController>();
  readonly #missionEpochs = new Map<string, number>();

  constructor(options: OrchestratorOptions) {
    this.#repository = options.repository;
    this.#runtime = options.runtime;
    this.#registry = options.harnessRegistry;
    this.#decisionProvider = options.decisionProvider ?? new ScriptedDecisionProvider();
    this.#context = new ContextManager(options.repository);
    this.#timeoutMs = options.timeoutMs;
    this.#onEvent = options.onEvent;
  }

  async handleUserMessage(workspaceId: WorkspaceId, message: string): Promise<OrchestratorResult> {
    const mission = this.#repository.insertMission({ workspaceId, goal: message, createdBy: "user", status: "planning" });
    const missionEpoch = 0;
    this.#missionEpochs.set(mission.id, missionEpoch);
    this.#appendEvent(workspaceId, { type: "mission.created", payload: { missionId: mission.id, goal: message, status: mission.status } });
    this.#repository.insertMessage({ workspaceId, from: "user", type: "message", payload: { text: message } });
    this.#appendEvent(workspaceId, { type: "orchestrator.user_message", payload: { text: message } });
    this.#appendEvent(workspaceId, {
      type: "orchestrator.plan.started",
      payload: { missionId: mission.id, goal: message, provider: this.#decisionProvider.name },
    });

    let plan: Plan | null = null;
    try {
      plan = await this.#decisionProvider.proposePlan({ workspaceId, goal: message });
    } catch (error) {
      if (this.#ownsPlanningAttempt(mission.id, missionEpoch)) this.#repository.updateMission(mission.id, { status: "failed" });
      const err = error instanceof Error ? error.message : String(error);
      this.#appendEvent(workspaceId, {
        type: "orchestrator.plan.error",
        payload: { missionId: mission.id, goal: message, provider: this.#decisionProvider.name, error: err },
      });
      return { workspaceId, taskIds: [], report: `Plan proposal failed: ${err}`, ok: false };
    }
    if (!plan) {
      if (this.#ownsPlanningAttempt(mission.id, missionEpoch)) this.#repository.updateMission(mission.id, { status: "failed" });
      this.#appendEvent(workspaceId, {
        type: "orchestrator.plan.none",
        payload: { missionId: mission.id, goal: message, provider: this.#decisionProvider.name },
      });
      return { workspaceId, taskIds: [], report: `No plan proposed for: ${message}`, ok: false };
    }
    const missionBeforeActivation = this.#repository.getMission(mission.id);
    if (missionBeforeActivation?.status !== "planning" || this.#missionEpochs.get(mission.id) !== missionEpoch) {
      return { workspaceId, taskIds: [], report: `Mission ${mission.id} was ${missionBeforeActivation?.status ?? "removed"} before execution`, ok: false };
    }
    plan.missionId = mission.id;
    this.#repository.insertPlan({
      id: plan.id,
      workspaceId,
      goal: plan.goal,
      missionId: mission.id,
      status: "proposed",
      tasks: plan.tasks,
      taskIds: plan.taskIds,
      createdAt: plan.createdAt,
    });
    this.#repository.updateMission(mission.id, { status: "active", planId: plan.id, taskIds: plan.taskIds });
    this.#appendEvent(workspaceId, { type: "mission.status", payload: { missionId: mission.id, status: "active", planId: plan.id } });
    this.#appendEvent(workspaceId, {
      type: "orchestrator.plan.proposed",
      payload: { missionId: mission.id, planId: plan.id, goal: plan.goal, taskIds: plan.taskIds, routingMode: routingModeOf(plan) },
    });
    const controller = new AbortController();
    this.#missionControllers.set(mission.id, controller);
    let executionError: string | undefined;
    try {
      await this.#withTimeout(this.#executePlan(workspaceId, plan, controller.signal), `plan ${plan.id}`, controller);
    } catch (error) {
      if (error instanceof MissionTimeoutError) this.#recordMissionTimeout(workspaceId, mission.id, plan.id, error);
      executionError = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.#missionControllers.get(mission.id) === controller) this.#missionControllers.delete(mission.id);
    }
    const finalStatus = executionError ? "failed" : "completed";
    plan.status = finalStatus;
    this.#repository.updatePlanStatus(plan.id, finalStatus);
    const attemptOwner = this.#repository.getMission(mission.id);
    if (attemptOwner?.status !== "active" || attemptOwner.planId !== plan.id) {
      const report = `Mission attempt ${plan.id} was interrupted by ${attemptOwner?.status ?? "mission removal"}.`;
      this.#appendEvent(workspaceId, { type: "orchestrator.plan.interrupted", payload: { missionId: mission.id, planId: plan.id, status: attemptOwner?.status } });
      return { workspaceId, taskIds: plan.taskIds, report, ok: false };
    }

    const snapshot = this.#repository.getWorkspaceSnapshot(workspaceId);
    const tasks = snapshot.tasks.filter((t) => plan.taskIds.includes(t.id));
    const artifacts = snapshot.artifacts.filter((a) => a.taskId !== undefined && plan.taskIds.includes(a.taskId));
    const failed = tasks.some((t) => t.status === "failed" || t.status === "cancelled");
    const ok = !executionError && !failed && tasks.length === plan.taskIds.length && tasks.every((task) => task.status === "completed");
    if (ok && !this.#beginVerification(workspaceId, mission.id, plan.id, plan.taskIds)) {
      const owner = this.#repository.getMission(mission.id);
      const report = `Mission attempt ${plan.id} was interrupted by ${owner?.status ?? "mission removal"}.`;
      this.#appendEvent(workspaceId, { type: "orchestrator.plan.interrupted", payload: { missionId: mission.id, planId: plan.id, status: owner?.status } });
      return { workspaceId, taskIds: plan.taskIds, report, ok: false };
    }
    const finalOwner = this.#repository.getMission(mission.id);
    const expectedStatus = ok ? "verifying" : "active";
    if (finalOwner?.status !== expectedStatus || finalOwner.planId !== plan.id) {
      const report = `Mission attempt ${plan.id} was interrupted by ${finalOwner?.status ?? "mission removal"}.`;
      this.#appendEvent(workspaceId, { type: "orchestrator.plan.interrupted", payload: { missionId: mission.id, planId: plan.id, status: finalOwner?.status } });
      return { workspaceId, taskIds: plan.taskIds, report, ok: false };
    }
    this.#repository.updateMission(mission.id, { status: ok ? "completed" : "failed", taskIds: plan.taskIds });
    this.#appendEvent(workspaceId, { type: "mission.status", payload: { missionId: mission.id, status: ok ? "completed" : "failed" } });
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
    const mission = this.#repository.insertMission({ workspaceId, goal: message, createdBy: "user", status: "planning" });
    const missionEpoch = 0;
    this.#missionEpochs.set(mission.id, missionEpoch);
    this.#appendEvent(workspaceId, { type: "mission.created", payload: { missionId: mission.id, goal: message, status: mission.status } });
    this.#repository.insertMessage({
      workspaceId,
      from: "user",
      to: "assistant",
      channel: "chat",
      type: "message",
      payload: { content: message },
    });
    this.#appendEvent(workspaceId, { type: "chat.user", payload: { content: message } });
    this.#appendEvent(workspaceId, {
      type: "chat.plan.started",
      payload: { missionId: mission.id, goal: message, provider: this.#decisionProvider.name },
    });

    let plan: Plan | null = null;
    try {
      plan = await this.#decisionProvider.proposePlan({ workspaceId, goal: message });
    } catch (error) {
      if (this.#ownsPlanningAttempt(mission.id, missionEpoch)) this.#repository.updateMission(mission.id, { status: "failed" });
      const err = error instanceof Error ? error.message : String(error);
      this.#appendEvent(workspaceId, {
        type: "chat.plan.error",
        payload: { missionId: mission.id, goal: message, provider: this.#decisionProvider.name, error: err },
      });
      return { workspaceId, taskIds: [], report: `Plan proposal failed: ${err}`, ok: false };
    }
    if (!plan) {
      if (this.#ownsPlanningAttempt(mission.id, missionEpoch)) this.#repository.updateMission(mission.id, { status: "failed" });
      this.#appendEvent(workspaceId, {
        type: "chat.plan.none",
        payload: { missionId: mission.id, goal: message, provider: this.#decisionProvider.name },
      });
      return { workspaceId, taskIds: [], report: `No plan proposed for: ${message}`, ok: false };
    }

    const missionBeforeActivation = this.#repository.getMission(mission.id);
    if (missionBeforeActivation?.status !== "planning" || this.#missionEpochs.get(mission.id) !== missionEpoch) {
      return { workspaceId, taskIds: [], report: `Mission ${mission.id} was ${missionBeforeActivation?.status ?? "removed"} before execution`, ok: false };
    }

    plan.missionId = mission.id;
    this.#repository.insertPlan({
      id: plan.id,
      workspaceId,
      goal: plan.goal,
      missionId: mission.id,
      status: "proposed",
      tasks: plan.tasks,
      taskIds: plan.taskIds,
      createdAt: plan.createdAt,
    });
    this.#repository.updateMission(mission.id, { status: "active", planId: plan.id, taskIds: plan.taskIds });
    this.#appendEvent(workspaceId, { type: "mission.status", payload: { missionId: mission.id, status: "active", planId: plan.id } });
    this.#appendEvent(workspaceId, {
      type: "chat.plan.proposed",
      payload: { missionId: mission.id, planId: plan.id, goal: plan.goal, taskIds: plan.taskIds, taskCount: plan.tasks.length, routingMode: routingModeOf(plan) },
    });

    // Validate the graph patch proposal through the node execution engine
    // before it can be applied (spec §12). Invalid proposals are reported
    // back to the user rather than silently applied.
    const controller = new AbortController();
    this.#missionControllers.set(mission.id, controller);
    let executionError: string | undefined;
    try {
      await this.#withTimeout(this.#executePlan(workspaceId, plan, controller.signal), `plan ${plan.id}`, controller);
      this.#appendEvent(workspaceId, { type: "chat.plan.applied", payload: { planId: plan.id, status: "completed" } });
    } catch (error) {
      if (error instanceof MissionTimeoutError) this.#recordMissionTimeout(workspaceId, mission.id, plan.id, error);
      executionError = error instanceof Error ? error.message : String(error);
      this.#appendEvent(workspaceId, { type: "chat.plan.applied", payload: { planId: plan.id, status: "failed", error: executionError } });
    } finally {
      if (this.#missionControllers.get(mission.id) === controller) this.#missionControllers.delete(mission.id);
    }
    const finalStatus = executionError ? "failed" : "completed";
    plan.status = finalStatus;
    this.#repository.updatePlanStatus(plan.id, finalStatus);
    const attemptOwner = this.#repository.getMission(mission.id);
    if (attemptOwner?.status !== "active" || attemptOwner.planId !== plan.id) {
      const report = `Mission attempt ${plan.id} was interrupted by ${attemptOwner?.status ?? "mission removal"}.`;
      this.#appendEvent(workspaceId, { type: "chat.plan.interrupted", payload: { missionId: mission.id, planId: plan.id, status: attemptOwner?.status } });
      return { workspaceId, taskIds: plan.taskIds, report, ok: false };
    }

    const executionTasks = plan.taskIds.map((id) => this.#repository.getTask(id)).filter((task) => task !== null);
    const executionSucceeded = !executionError && executionTasks.length === plan.taskIds.length && executionTasks.every((task) => task.status === "completed");
    if (executionSucceeded && !this.#beginVerification(workspaceId, mission.id, plan.id, plan.taskIds)) {
      const owner = this.#repository.getMission(mission.id);
      const report = `Mission attempt ${plan.id} was interrupted by ${owner?.status ?? "mission removal"}.`;
      this.#appendEvent(workspaceId, { type: "chat.plan.interrupted", payload: { missionId: mission.id, planId: plan.id, status: owner?.status } });
      return { workspaceId, taskIds: plan.taskIds, report, ok: false };
    }

    // Materialize the plan as a durable canvas graph (spawn + connect + arrange).
    // Canvas failure is non-fatal: the plan already executed; the canvas
    // simply stays as-is. patchCanvasGraph already emits canvas.patched /
    // canvas.patch.failed events internally.
    try {
      await this.patchCanvasGraph(workspaceId, {
        upsertNodes: plan.tasks.map((t) => ({
          id: t.id,
          taskId: t.id,
          label: t.title,
          kind: t.assignedTo ? "agent" : "tool",
          nodeType: "blueprint",
        })),
        upsertEdges: plan.tasks.flatMap((t) =>
          t.dependencies.map((dep) => ({ source: dep, target: t.id, type: "dependency" as const })),
        ),
        arrange: { mode: "columns" },
      });
    } catch {
      // Plan succeeded even if canvas layout failed — do not block chat.
    }

    const snapshot = this.#repository.getWorkspaceSnapshot(workspaceId);
    const tasks = snapshot.tasks.filter((t) => plan.taskIds.includes(t.id));
    const artifacts = snapshot.artifacts.filter((a) => a.taskId !== undefined && plan.taskIds.includes(a.taskId));
    const failed = tasks.some((t) => t.status === "failed" || t.status === "cancelled");
    const ok = !executionError && !failed && tasks.length === plan.taskIds.length && tasks.every((task) => task.status === "completed");
    const finalOwner = this.#repository.getMission(mission.id);
    const expectedStatus = ok ? "verifying" : "active";
    if (finalOwner?.status !== expectedStatus || finalOwner.planId !== plan.id) {
      const report = `Mission attempt ${plan.id} was interrupted by ${finalOwner?.status ?? "mission removal"}.`;
      this.#appendEvent(workspaceId, { type: "chat.plan.interrupted", payload: { missionId: mission.id, planId: plan.id, status: finalOwner?.status } });
      return { workspaceId, taskIds: plan.taskIds, report, ok: false };
    }
    this.#repository.updateMission(mission.id, { status: ok ? "completed" : "failed", taskIds: plan.taskIds });
    this.#appendEvent(workspaceId, { type: "mission.status", payload: { missionId: mission.id, status: ok ? "completed" : "failed" } });
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

  async pauseMission(workspaceId: WorkspaceId, missionId: string): Promise<Mission> {
    const mission = this.#requireMission(workspaceId, missionId);
    if (mission.status === "completed" || mission.status === "failed" || mission.status === "cancelled") {
      throw new Error(`Mission ${missionId} is already terminal (${mission.status})`);
    }
    this.#bumpMissionEpoch(missionId);
    const paused = this.#repository.updateMission(missionId, { status: "paused" });
    this.#appendEvent(workspaceId, { type: "mission.status", payload: { missionId, status: "paused" } });
    this.#missionControllers.get(missionId)?.abort();
    await this.#cancelMissionTasks(workspaceId, paused.taskIds);
    return this.#repository.getMission(missionId)!;
  }

  resumeMission(workspaceId: WorkspaceId, missionId: string): Mission {
    const mission = this.#requireMission(workspaceId, missionId);
    if (mission.status !== "paused") throw new Error(`Mission ${missionId} is not paused`);
    const missionEpoch = this.#bumpMissionEpoch(missionId);
    const planning = this.#repository.updateMission(missionId, { status: "planning" });
    this.#appendEvent(workspaceId, { type: "mission.status", payload: { missionId, status: "planning", resumed: true } });
    void this.#restartMission(workspaceId, missionId, missionEpoch);
    return planning;
  }

  async cancelMission(workspaceId: WorkspaceId, missionId: string): Promise<Mission> {
    const mission = this.#requireMission(workspaceId, missionId);
    if (mission.status === "completed" || mission.status === "failed") {
      throw new Error(`Mission ${missionId} is already terminal (${mission.status})`);
    }
    if (mission.status !== "cancelled") {
      this.#bumpMissionEpoch(missionId);
      this.#repository.updateMission(missionId, { status: "cancelled" });
      this.#appendEvent(workspaceId, { type: "mission.status", payload: { missionId, status: "cancelled" } });
    }
    this.#missionControllers.get(missionId)?.abort();
    await this.#cancelMissionTasks(workspaceId, mission.taskIds);
    return this.#repository.getMission(missionId)!;
  }

  async redirectMission(workspaceId: WorkspaceId, missionId: string, goal: string): Promise<Mission> {
    const mission = this.#requireMission(workspaceId, missionId);
    if (mission.status === "completed" || mission.status === "failed" || mission.status === "cancelled") {
      throw new Error(`Mission ${missionId} is already terminal (${mission.status})`);
    }
    this.#missionControllers.get(missionId)?.abort();
    const missionEpoch = this.#bumpMissionEpoch(missionId);
    // Claim the redirected attempt before asynchronous teardown. A subsequent
    // redirect can then supersede this token while the old tasks are stopping.
    const redirected = this.#repository.updateMission(missionId, { goal, status: "planning" });
    this.#appendEvent(workspaceId, { type: "mission.redirected", payload: { missionId, goal } });
    await this.#cancelMissionTasks(workspaceId, mission.taskIds);
    void this.#restartMission(workspaceId, missionId, missionEpoch);
    return redirected;
  }

  async patchCanvasGraph(workspaceId: WorkspaceId, patch: CanvasPatch): Promise<CanvasPatchResult> {
    // Node / edge reference validation — edges must reference nodes that
    // exist AFTER this patch's upserts are applied, and self-loops are rejected.
    for (const node of patch.upsertNodes ?? []) {
      if (node.position !== undefined && (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y))) {
        return this.#patchFailure(workspaceId, "invalid position");
      }
    }
    const ids = new Set(this.#repository.listCanvasNodes(workspaceId).map((n) => n.id));
    for (const node of patch.upsertNodes ?? []) ids.add(node.id);
    for (const ed of patch.upsertEdges ?? []) {
      if (!["communication", "context", "delegation", "dependency", "control", "error", "approval"].includes(ed.type ?? "context")) {
        return this.#patchFailure(workspaceId, `invalid edge type ${String(ed.type)}`);
      }
      if (ed.source === ed.target) return this.#patchFailure(workspaceId, `self-loop edge ${ed.source}->${ed.target}`);
      if (!ids.has(ed.source)) return this.#patchFailure(workspaceId, `edge references missing node ${ed.source}`);
      if (!ids.has(ed.target)) return this.#patchFailure(workspaceId, `edge references missing node ${ed.target}`);
    }

    // Apply transactionally — any failure rolls the whole batch back.
    try {
      this.#repository.transaction(() => {
        for (const node of patch.upsertNodes ?? []) this.#repository.upsertCanvasNode({ ...node, workspaceId });
        for (const ed of patch.upsertEdges ?? []) this.#repository.upsertCanvasEdge({ ...ed, workspaceId });
        for (const id of patch.deleteNodes ?? []) {
          this.#deleteCanvasEdgesFor(workspaceId, id);
          this.#repository.deleteCanvasNode(id);
        }
        for (const ed of patch.deleteEdges ?? []) {
          const edgeId = ed.type && ed.type !== "context" ? `${ed.source}->${ed.target}:${ed.type}` : `${ed.source}->${ed.target}`;
          this.#repository.deleteCanvasEdge(edgeId);
        }
      });
    } catch (error) {
      return this.#patchFailure(workspaceId, error instanceof Error ? error.message : String(error));
    }
    // Context sharing: a canvas edge source->target means "the target consumes
    // the source's context" (October-style connections). Recompute each
    // affected target task's contextRefs from its incoming edges after the
    // transactional graph write.
    const allEdges = this.#repository.listCanvasEdges(workspaceId);
    const affectedTargets = new Set<string>();
    for (const ed of [...(patch.upsertEdges ?? []), ...(patch.deleteEdges ?? [])]) {
      if ((ed.type ?? "context") === "context") affectedTargets.add(ed.target);
    }
    for (const id of patch.deleteNodes ?? []) {
      for (const edge of allEdges) if (edge.source === id || edge.target === id) affectedTargets.add(edge.target);
    }
    for (const targetId of affectedTargets) {
      const node = this.#repository.listCanvasNodes(workspaceId).find((n) => n.id === targetId);
      if (!node?.taskId) continue;
      this.#syncCanvasEdgeContext(workspaceId, targetId, allEdges);
    }

    // Arrange (deterministic server-side layout) when requested.
    if (patch.arrange) {
      const arrangeNodes = this.#repository.listCanvasNodes(workspaceId);
      const arrangeEdges = this.#repository.listCanvasEdges(workspaceId);
      const layout = computeLayout(arrangeNodes, arrangeEdges, patch.arrange.mode);
      this.#repository.transaction(() => {
        for (const nd of arrangeNodes) {
          const position = layout.get(nd.id);
          if (!position) continue;
          this.#repository.upsertCanvasNode({
            id: nd.id,
            workspaceId,
            taskId: nd.taskId,
            label: nd.label,
            kind: nd.kind,
            nodeType: nd.nodeType,
            harnessId: nd.harnessId,
            liveStatus: nd.liveStatus,
            config: nd.config,
            position,
          });
        }
      });
    }
    const nodes = this.#repository.listCanvasNodes(workspaceId).map((n) => this.#mapToCanvasNode(n));
    const edges = this.#repository.listCanvasEdges(workspaceId).map((e) => this.#mapToCanvasEdge(e));
    this.#appendEvent(workspaceId, { type: "canvas.patched", payload: { nodes, edges } });
    return { ok: true, nodes, edges };
  }

  listCanvasGraph(workspaceId: WorkspaceId): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
    return {
      nodes: this.#repository.listCanvasNodes(workspaceId).map((n) => this.#mapToCanvasNode(n)),
      edges: this.#repository.listCanvasEdges(workspaceId).map((e) => this.#mapToCanvasEdge(e)),
    };
  }

  activateCanvasNode(workspaceId: WorkspaceId, nodeId: string): CanvasNode {
    const node = this.#repository.listCanvasNodes(workspaceId).find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`Canvas node not found: ${nodeId}`);
    this.#repository.upsertCanvasNode({
      id: node.id, workspaceId, taskId: node.taskId, label: node.label, nodeType: node.nodeType,
      kind: node.kind, harnessId: node.harnessId, liveStatus: "idle", config: node.config,
      position: { x: node.positionX, y: node.positionY },
    });
    const activated = this.#repository.listCanvasNodes(workspaceId).find((candidate) => candidate.id === nodeId)!;
    this.#appendEvent(workspaceId, { type: "node.activated", payload: { nodeId, liveStatus: "idle" }, taskId: activated.taskId ?? undefined });
    return this.#mapToCanvasNode(activated);
  }

  interveneCanvasNode(workspaceId: WorkspaceId, nodeId: string, message: string): void {
    const node = this.#repository.listCanvasNodes(workspaceId).find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`Canvas node not found: ${nodeId}`);
    const task = node.taskId ? this.#repository.getTask(node.taskId) : null;
    this.#repository.insertMessage({ workspaceId, from: "user", to: nodeId, channel: `node:${nodeId}`, type: "message", payload: { text: message } });
    this.#appendEvent(workspaceId, {
      type: "user.intervention",
      payload: { nodeId, message, missionId: task?.missionId },
      taskId: node.taskId ?? undefined,
    });
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
      if (error instanceof MissionTimeoutError && plan.missionId) this.#recordMissionTimeout(plan.workspaceId, plan.missionId, plan.id, error);
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

  #requireMission(workspaceId: WorkspaceId, missionId: string): Mission {
    const mission = this.#repository.getMission(missionId);
    if (!mission || mission.workspaceId !== workspaceId) throw new Error(`Mission not found: ${missionId}`);
    return mission;
  }

  #bumpMissionEpoch(missionId: string): number {
    const next = (this.#missionEpochs.get(missionId) ?? 0) + 1;
    this.#missionEpochs.set(missionId, next);
    return next;
  }

  #ownsPlanningAttempt(missionId: string, missionEpoch: number): boolean {
    return this.#missionEpochs.get(missionId) === missionEpoch && this.#repository.getMission(missionId)?.status === "planning";
  }

  #ownsActiveAttempt(missionId: string, missionEpoch: number, planId: string): boolean {
    const mission = this.#repository.getMission(missionId);
    return this.#missionEpochs.get(missionId) === missionEpoch && mission?.status === "active" && mission.planId === planId;
  }

  #ownsVerifyingAttempt(missionId: string, missionEpoch: number, planId: string): boolean {
    const mission = this.#repository.getMission(missionId);
    return this.#missionEpochs.get(missionId) === missionEpoch && mission?.status === "verifying" && mission.planId === planId;
  }

  #beginVerification(workspaceId: WorkspaceId, missionId: string, planId: string, taskIds: readonly TaskId[]): boolean {
    const mission = this.#repository.getMission(missionId);
    if (mission?.status !== "active" || mission.planId !== planId) return false;
    const tasks = taskIds.map((taskId) => this.#repository.getTask(taskId));
    if (tasks.some((task) => task === null || task.status !== "completed")) return false;
    this.#repository.updateMission(missionId, { status: "verifying", taskIds: [...taskIds] });
    this.#appendEvent(workspaceId, { type: "mission.status", payload: { missionId, status: "verifying", planId } });
    return true;
  }

  async #cancelMissionTasks(workspaceId: WorkspaceId, taskIds: TaskId[]): Promise<void> {
    const cancellable = taskIds.filter((taskId) => {
      const task = this.#repository.getTask(taskId);
      return task && task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled";
    });
    await Promise.allSettled(cancellable.map((taskId) => this.#runtime.cancelTask(workspaceId, taskId)));
  }

  async #restartMission(workspaceId: WorkspaceId, missionId: string, missionEpoch: number): Promise<void> {
    const mission = this.#requireMission(workspaceId, missionId);
    if (!this.#ownsPlanningAttempt(missionId, missionEpoch)) return;
    this.#appendEvent(workspaceId, {
      type: "orchestrator.plan.started",
      payload: { missionId, goal: mission.goal, provider: this.#decisionProvider.name, resumed: true },
    });
    let plan: Plan | null = null;
    try {
      plan = await this.#decisionProvider.proposePlan({ workspaceId, goal: mission.goal });
      if (!plan) throw new Error(`No plan proposed for: ${mission.goal}`);
      if (!this.#ownsPlanningAttempt(missionId, missionEpoch)) return;
      plan.missionId = missionId;
      this.#repository.insertPlan({
        id: plan.id, workspaceId, goal: plan.goal, missionId, status: "proposed",
        tasks: plan.tasks, taskIds: plan.taskIds, createdAt: plan.createdAt,
      });
      this.#repository.updateMission(missionId, { status: "active", planId: plan.id, taskIds: plan.taskIds });
      this.#appendEvent(workspaceId, { type: "mission.status", payload: { missionId, status: "active", planId: plan.id } });
      this.#appendEvent(workspaceId, {
        type: "orchestrator.plan.proposed",
        payload: { missionId, planId: plan.id, goal: plan.goal, taskIds: plan.taskIds, routingMode: routingModeOf(plan), resumed: true },
      });
      const controller = new AbortController();
      this.#missionControllers.set(missionId, controller);
      let executionError: string | undefined;
      try {
        await this.#withTimeout(this.#executePlan(workspaceId, plan, controller.signal), `plan ${plan.id}`, controller);
      } catch (error) {
        if (error instanceof MissionTimeoutError) this.#recordMissionTimeout(workspaceId, missionId, plan.id, error);
        executionError = error instanceof Error ? error.message : String(error);
      } finally {
        if (this.#missionControllers.get(missionId) === controller) this.#missionControllers.delete(missionId);
      }
      plan.status = executionError ? "failed" : "completed";
      this.#repository.updatePlanStatus(plan.id, plan.status);
      if (!this.#ownsActiveAttempt(missionId, missionEpoch, plan.id)) return;
      const tasks = plan.taskIds.map((id) => this.#repository.getTask(id)).filter((task) => task !== null);
      const ok = !executionError && tasks.length === plan.taskIds.length && tasks.every((task) => task.status === "completed");
      if (ok) {
        if (!this.#beginVerification(workspaceId, missionId, plan.id, plan.taskIds)) return;
        if (!this.#ownsVerifyingAttempt(missionId, missionEpoch, plan.id)) return;
      } else if (!this.#ownsActiveAttempt(missionId, missionEpoch, plan.id)) {
        return;
      }
      this.#repository.updateMission(missionId, { status: ok ? "completed" : "failed", taskIds: plan.taskIds });
      this.#appendEvent(workspaceId, { type: "mission.status", payload: { missionId, status: ok ? "completed" : "failed" } });
    } catch (error) {
      const sameAttempt = plan
        ? this.#ownsActiveAttempt(missionId, missionEpoch, plan.id) || this.#ownsVerifyingAttempt(missionId, missionEpoch, plan.id)
        : this.#ownsPlanningAttempt(missionId, missionEpoch);
      if (sameAttempt) {
        const err = error instanceof Error ? error.message : String(error);
        this.#repository.updateMission(missionId, { status: "failed" });
        this.#appendEvent(workspaceId, { type: "mission.status", payload: { missionId, status: "failed", error: err } });
        this.#appendEvent(workspaceId, {
          type: "orchestrator.plan.error",
          payload: { missionId, goal: mission.goal, provider: this.#decisionProvider.name, error: err, resumed: true },
        });
      }
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
        if (signal.aborted) throw new Error(`Mission execution aborted`);
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
        await this.#driveMissionBatch(workspaceId, plan.taskIds, batchTaskIds, [...created.values()], signal);
        // A batch task still pending/assigned/blocked after dispatch is held
        // behind a human approval gate (spec §11.3): wait for resolution.
        const held = batchTaskIds.filter((id) => {
          const task = this.#repository.getTask(id);
          return task && task.approvalId !== undefined;
        });
        for (const id of held) {
          await this.#awaitApproval(workspaceId, id, plan.taskIds, signal);
        }
        for (const id of batchTaskIds) {
          if (signal.aborted) throw new Error(`Mission execution aborted`);
          const task = this.#repository.getTask(id)!;
          if (!this.#isTerminal(task)) throw new Error(`Task ${id} did not reach a terminal state (${task.status})`);
          try {
            const decision = await this.#decisionProvider.evaluate({ taskId: task.id, status: task.status, resultSummary: task.resultSummary });
            this.#repository.insertDecision({ ...decision, workspaceId });
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

  /**
   * Drive one dependency-ready Mission batch until every runnable task is
   * terminal or held by a human gate. Capacity starvation is a queueing state:
   * unrelated live surfaces and batches wider than maxConcurrency must not
   * turn valid pending work into an immediate Mission failure.
   */
  async #driveMissionBatch(
    workspaceId: WorkspaceId,
    planTaskIds: readonly TaskId[],
    batchTaskIds: readonly TaskId[],
    createdTasks: Task[],
    signal: AbortSignal,
  ): Promise<void> {
    while (true) {
      if (signal.aborted) throw new Error(`Mission execution aborted`);
      // Dispatch also materializes the blocked state/event for a dependency-
      // ready approval gate, so it must run before classifying held work.
      const dispatched = await this.#runtime.dispatchPending(workspaceId, planTaskIds);
      const snapshot = this.#repository.getWorkspaceSnapshot(workspaceId);
      const approvalsById = new Map(snapshot.approvals.map((approval) => [approval.id, approval]));
      const batchTasks = batchTaskIds.map((id) => this.#repository.getTask(id)).filter((task) => task !== null);
      const active = batchTasks.filter((task) => !this.#isTerminal(task));
      if (active.length === 0) return;
      const executable = active.filter((task) =>
        task.approvalId === undefined || approvalsById.get(task.approvalId)?.status !== "pending",
      );
      if (executable.length === 0) return;

      if (dispatched > 0) await this.#materializeContexts(workspaceId, createdTasks);

      const liveTaskIds = new Set(batchTaskIds);
      const hasOwnedSession = this.#repository.getWorkspaceSnapshot(workspaceId).sessions.some((session) =>
        liveTaskIds.has(session.taskId) && (session.status === "spawning" || session.status === "running"),
      );
      if (hasOwnedSession) {
        await this.#consumeSessions(workspaceId, [...batchTaskIds], signal);
        continue;
      }

      const completedIds = new Set(snapshot.tasks.filter((task) => task.status === "completed").map((task) => task.id));
      const capacityQueued = executable.some((task) =>
        (task.status === "pending" || task.status === "assigned") && task.assignedTo !== undefined &&
        task.dependencies.every((dependency) => completedIds.has(dependency)),
      );
      if (!capacityQueued) {
        const summary = executable.map((task) => `${task.id}:${task.status}${task.assignedTo ? "" : ":unassigned"}`).join(", ");
        throw new Error(`Mission batch cannot make progress (${summary})`);
      }
      await this.#sleep(SLEEP_STEP_MS);
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

  #createPlanTask(workspaceId: WorkspaceId, plan: Plan, pt: PlanTask, refs: ContextReference[]): Task {
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
        missionId: plan.missionId,
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
  async #awaitApproval(workspaceId: WorkspaceId, taskId: TaskId, planTaskIds: readonly TaskId[], signal: AbortSignal): Promise<void> {
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
          await this.#runtime.dispatchPending(workspaceId, planTaskIds);
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

  #recordMissionTimeout(workspaceId: WorkspaceId, missionId: string, planId: string, error: MissionTimeoutError): void {
    this.#appendEvent(workspaceId, {
      type: "mission.timeout",
      payload: { missionId, planId, timeoutMs: error.timeoutMs, cause: "mission_timeout" },
    });
  }

  #patchFailure(workspaceId: WorkspaceId, error: string): CanvasPatchResult {
    this.#appendEvent(workspaceId, { type: "canvas.patch.failed", payload: { error } });
    return { ok: false, error };
  }

  /** Delete every edge whose source or target is the removed node. */
  #deleteCanvasEdgesFor(workspaceId: WorkspaceId, id: string): void {
    for (const edge of this.#repository.listCanvasEdges(workspaceId)) {
      if (edge.source === id || edge.target === id) this.#repository.deleteCanvasEdge(edge.id);
    }
  }

  /**
   * Derive each target task's context refs from its incoming canvas edges
   * (October-style "connections scope context"): for every edge source->target
   * the target references the source's latest artifact (falling back to a
   * task reference when the source has produced none) plus the source task
   * itself. Recomputes for every candidate target in one pass.
   */
  #syncCanvasEdgeContext(workspaceId: WorkspaceId, targetId: string, edges: CanvasEdgeRecord[]): void {
    const incoming = edges.filter((e) => e.target === targetId && e.type === "context");
    if (incoming.length === 0) {
      this.#repository.updateTaskContextRefs(targetId, []);
      return;
    }
    const refs: ContextReference[] = [];
    for (const edge of incoming) {
      const srcNode = this.#repository.listCanvasNodes(workspaceId).find((n) => n.id === edge.source);
      if (!srcNode?.taskId) continue;
      const srcArtifacts = this.#repository.listArtifacts(workspaceId).filter((a) => a.taskId === srcNode.taskId);
      if (srcArtifacts.length > 0) {
        const latest = srcArtifacts[srcArtifacts.length - 1];
        refs.push({ type: "artifact", id: latest.id, relevance: 1 });
      }
      refs.push({ type: "task", id: srcNode.taskId, relevance: 1 });
    }
    this.#repository.updateTaskContextRefs(targetId, refs);
  }

  /** Translate durable record → public CanvasNode (position object, kind narrowed). */
  #mapToCanvasNode(rec: CanvasNodeRecord): CanvasNode {
    return {
      id: rec.id,
      workspaceId: rec.workspaceId,
      taskId: rec.taskId,
      label: rec.label,
      nodeType: rec.nodeType,
      kind: rec.kind as CanvasNodeKind,
      harnessId: rec.harnessId,
      liveStatus: rec.liveStatus,
      config: rec.config,
      position: { x: rec.positionX, y: rec.positionY },
      updatedAt: rec.updatedAt,
    };
  }

  /** Translate durable record → public CanvasEdge. */
  #mapToCanvasEdge(rec: CanvasEdgeRecord): CanvasEdge {
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
    const timeoutMs = this.#timeoutMs;
    if (timeoutMs === undefined) return work;

    const { promise: timeout, resolve } = Promise.withResolvers<typeof TIMED_OUT>();
    const timer = setTimeout(() => {
      controller?.abort();
      resolve(TIMED_OUT);
    }, timeoutMs);
    timer.unref();
    try {
      const result = await Promise.race([work, timeout]);
      if (result === TIMED_OUT) {
        // Cancellation is best-effort. A Mission deadline must still return
        // control when downstream work ignores AbortSignal or cannot abort.
        void work.catch(() => undefined);
        throw new MissionTimeoutError(timeoutMs, label);
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  #sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, ms);
    // Do NOT unref: capacity-starvation polls and deadline waits are
    // active pending work that must keep the event loop alive.
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