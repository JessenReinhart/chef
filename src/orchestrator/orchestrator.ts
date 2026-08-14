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
  #activePlan: Plan | null = null;
  readonly #terminalEvents = new Map<TaskId, string>();

  constructor(options: OrchestratorOptions) {
    this.#repository = options.repository;
    this.#runtime = options.runtime;
    this.#registry = options.harnessRegistry;
    this.#decisionProvider = options.decisionProvider ?? new ScriptedDecisionProvider();
    this.#context = new ContextManager(options.repository);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    this.#appendEvent(workspaceId, { type: "orchestrator.plan.proposed", payload: { planId: plan.id, goal: plan.goal, taskIds: plan.taskIds } });

    let executionError: string | undefined;
    try {
      await this.#withTimeout(this.#executePlan(workspaceId, plan), `plan ${plan.id}`);
    } catch (error) {
      executionError = error instanceof Error ? error.message : String(error);
    }
    plan.status = executionError ? "failed" : "completed";

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

  async inspectState(workspaceId: WorkspaceId): Promise<WorkspaceSnapshot> {
    return this.#repository.getWorkspaceSnapshot(workspaceId);
  }

  async proposePlan(input: PlanProposalContext): Promise<Plan | null> {
    return this.#decisionProvider.proposePlan(input);
  }

  async executePlan(planId: string): Promise<void> {
    const plan = this.#activePlan;
    if (!plan || plan.id !== planId) throw new Error(`Unknown plan ${planId}`);
    await this.#withTimeout(this.#executePlan(plan.workspaceId, plan), `plan ${planId}`);
  }

  async handleEvent(event: RuntimeEvent): Promise<void> {
    if (!event.taskId) return;
    if (event.type === "task.completed" || event.type === "task.failed" || event.type === "task.cancelled" || event.type === "task.blocked") {
      this.#terminalEvents.set(event.taskId, event.type);
    }
  }

  async #executePlan(workspaceId: WorkspaceId, plan: Plan): Promise<void> {
    this.#activePlan = plan;
    plan.status = "executing";
    this.#appendEvent(workspaceId, { type: "orchestrator.plan.executing", payload: { planId: plan.id, goal: plan.goal, taskIds: plan.taskIds } });

    const created = new Map<string, Task>();
    let remaining = [...plan.tasks];

    while (remaining.length > 0) {
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
        await this.#consumeSessions(workspaceId, [...created.keys()]);
      }
      for (const id of batchTaskIds) {
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

    // Terminate any sessions still running after plan completion.
    await this.#cleanupSessions(workspaceId, [...created.values()]);
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
            // Ignore termination failures.
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
    });
    this.#appendEvent(workspaceId, { type: "orchestrator.task.created", payload: { taskId: task.id, assignedTo: task.assignedTo }, taskId: task.id });
    return task;
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

  async #consumeSessions(workspaceId: WorkspaceId, taskIds: TaskId[]): Promise<void> {
    const mine = new Set(taskIds);
    const deadline = Date.now() + SESSION_ACTIVE_WAIT_MS;
    let sessions: Session[] = [];
    while (sessions.length === 0 && Date.now() < deadline) {
      const snapshot = this.#repository.getWorkspaceSnapshot(workspaceId);
      sessions = snapshot.sessions.filter((s) => mine.has(s.taskId) && (s.status === "spawning" || s.status === "running"));
      if (sessions.length === 0) await this.#sleep(SLEEP_STEP_MS);
    }
    for (const session of sessions) {
      const harness = this.#registry.get(session.agentId);
      if (!harness) throw new Error(`No harness registered for agent ${session.agentId}`);
      await this.#consumeSession(workspaceId, session.id, session.taskId, harness);
    }
  }

  async #consumeSession(workspaceId: WorkspaceId, sessionId: string, taskId: TaskId, harness: OrchestratorHarness): Promise<void> {
    let stream: AsyncIterable<HarnessEvent> | null = null;
    const deadline = Date.now() + SESSION_ACTIVE_WAIT_MS;
    while (stream === null && Date.now() < deadline) {
      try {
        stream = harness.events(sessionId);
      } catch {
        const session = this.#repository.getWorkspaceSnapshot(workspaceId).sessions.find((s) => s.id === sessionId);
        if (session && (session.status === "crashed" || session.status === "completed" || session.status === "terminated")) break;
        await this.#sleep(SLEEP_STEP_MS);
      }
    }
    if (stream === null) return;
    for await (const event of stream) {
      if (event.type === "data") continue;
      if (event.type === "exit" || event.type === "crash") {
        const task = this.#repository.getTask(taskId);
        if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "blocked")) continue;
      }
      await this.#runtime.handleSessionEvent(workspaceId, sessionId, event);
    }
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

  #appendEvent(workspaceId: WorkspaceId, input: { type: string; payload?: unknown; taskId?: TaskId; sessionId?: string }): RuntimeEvent {
    return this.#repository.appendEvent({ workspaceId, source: ORCHESTRATOR_SOURCE, ...input });
  }

  async #withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
    const { promise: timeout, resolve } = Promise.withResolvers<typeof TIMED_OUT>();
    const timer = setTimeout(resolve, this.#timeoutMs, TIMED_OUT);
    timer.unref();
    try {
      return await Promise.race([work, timeout]);
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
  console.error("investigator: cannot locate sideband session");
  process.exit(2);
}

const findings = {
  summary: "Investigated the reported issue and located the root cause.",
  evidence: ["reproduced the failure", "traced event ordering", "identified the fix target"]
};

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