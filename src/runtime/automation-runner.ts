import type { AutomationRun, AutomationRunId, HarnessEvent, RuntimeEvent, TaskId, WorkspaceId } from "../core/types.ts";
import type { Repository } from "../persistence/database.ts";

const POLL_MS = 25;

export interface AutomationHarness {
  events(sessionId: string): AsyncIterable<HarnessEvent>;
}

export interface AutomationHarnessRegistry {
  get(agentId: string): AutomationHarness | undefined;
}

export interface AutomationScheduler {
  dispatchPending(workspaceId: WorkspaceId, allowedTaskIds?: readonly TaskId[]): Promise<number>;
  handleSessionEvent(workspaceId: WorkspaceId, sessionId: string, event: HarnessEvent): Promise<void>;
  cancelTask(workspaceId: WorkspaceId, taskId: TaskId): Promise<void>;
}

/** Owns execution after Repository.runAutomation materializes a durable run. */
export class AutomationRunner {
  readonly #controllers = new Map<AutomationRunId, AbortController>();
  readonly #repository: Repository;
  readonly #scheduler: AutomationScheduler;
  readonly #harnesses: AutomationHarnessRegistry;
  readonly #onEvent: ((event: RuntimeEvent) => void) | undefined;

  constructor(
    repository: Repository,
    scheduler: AutomationScheduler,
    harnesses: AutomationHarnessRegistry,
    onEvent?: (event: RuntimeEvent) => void,
  ) {
    this.#repository = repository;
    this.#scheduler = scheduler;
    this.#harnesses = harnesses;
    this.#onEvent = onEvent;
  }

  run(automationId: string): AutomationRun {
    const run = this.#repository.runAutomation(automationId);
    this.#start(run);
    return run;
  }

  resumeActive(workspaceId: WorkspaceId): void {
    for (const automation of this.#repository.listAutomations(workspaceId)) {
      if (automation.status !== "running" || !automation.currentRunId) continue;
      const run = this.#repository.getAutomationRun(automation.currentRunId);
      if (run) this.#start(run);
    }
  }

  async stop(automationId: string): Promise<AutomationRun> {
    const automation = this.#repository.getAutomation(automationId);
    if (!automation?.currentRunId || automation.status !== "running") {
      throw new Error(`Automation is not running: ${automationId}`);
    }
    this.#controllers.get(automation.currentRunId)?.abort();
    const run = this.#repository.getAutomationRun(automation.currentRunId);
    await Promise.allSettled((run?.taskIds ?? []).map((taskId) => this.#scheduler.cancelTask(automation.workspaceId, taskId)));
    const stopped = this.#repository.stopAutomation(automationId);
    this.#emit(automation.workspaceId, automationId, "automation.stopped", { automationId, runId: stopped.id });
    return stopped;
  }

  close(): void {
    for (const controller of this.#controllers.values()) controller.abort();
    this.#controllers.clear();
  }

  #start(run: AutomationRun): void {
    if (this.#controllers.has(run.id)) return;
    const controller = new AbortController();
    this.#controllers.set(run.id, controller);
    void this.#drive(run, controller.signal).finally(() => {
      if (this.#controllers.get(run.id) === controller) this.#controllers.delete(run.id);
    });
  }

  async #drive(run: AutomationRun, signal: AbortSignal): Promise<void> {
    this.#emit(run.workspaceId, run.automationId, "automation.started", { automationId: run.automationId, runId: run.id });
    let stalledPolls = 0;
    try {
      while (!signal.aborted) {
        const durableRun = this.#repository.getAutomationRun(run.id);
        if (!durableRun || durableRun.status === "cancelled" || durableRun.status === "completed" || durableRun.status === "failed") return;
        const tasks = durableRun.taskIds.map((id) => this.#repository.getTask(id)).filter((task) => task !== null);
        const failed = tasks.find((task) => task.status === "failed" || task.status === "cancelled");
        if (failed) {
          await Promise.allSettled(tasks.filter((task) => task.status === "pending" || task.status === "assigned" || task.status === "running" || task.status === "blocked").map((task) => this.#scheduler.cancelTask(run.workspaceId, task.id)));
          const final = this.#repository.finalizeAutomationRun(run.id, "failed", failed.error ?? `Task ${failed.id} ${failed.status}`);
          this.#emit(run.workspaceId, run.automationId, "automation.failed", { automationId: run.automationId, runId: run.id, error: final.error });
          return;
        }
        if (tasks.length === durableRun.taskIds.length && tasks.every((task) => task.status === "completed")) {
          this.#repository.finalizeAutomationRun(run.id, "completed");
          this.#emit(run.workspaceId, run.automationId, "automation.completed", { automationId: run.automationId, runId: run.id });
          return;
        }

        const dispatched = await this.#scheduler.dispatchPending(run.workspaceId, durableRun.taskIds);
        const snapshot = this.#repository.getWorkspaceSnapshot(run.workspaceId);
        const currentTasks = durableRun.taskIds.map((id) => snapshot.tasks.find((task) => task.id === id)).filter((task) => task !== undefined);
        const approvalsById = new Map(snapshot.approvals.map((approval) => [approval.id, approval]));
        const waitingForApproval = currentTasks.some((task) =>
          task.status === "blocked" && task.approvalId !== undefined && approvalsById.get(task.approvalId)?.status === "pending",
        );
        if (waitingForApproval) {
          if (durableRun.status !== "waiting") {
            this.#repository.updateAutomationRunStatus(run.id, "waiting");
            this.#emit(run.workspaceId, run.automationId, "automation.waiting_for_approval", {
              automationId: run.automationId,
              runId: run.id,
            });
          }
          stalledPolls = 0;
          await this.#sleep(signal);
          continue;
        }
        const session = snapshot.sessions.find((candidate) =>
          durableRun.taskIds.includes(candidate.taskId) && (candidate.status === "spawning" || candidate.status === "running"),
        );
        if (!session) {
          const completedIds = new Set(snapshot.tasks.filter((task) => task.status === "completed").map((task) => task.id));
          const capacityQueued = currentTasks.some((task) =>
            (task.status === "pending" || task.status === "assigned") && task.assignedTo !== undefined &&
            task.dependencies.every((dependency) => completedIds.has(dependency)),
          );
          if (capacityQueued) {
            if (durableRun.status !== "queued") {
              this.#repository.updateAutomationRunStatus(run.id, "queued");
              this.#emit(run.workspaceId, run.automationId, "automation.queued", {
                automationId: run.automationId,
                runId: run.id,
                reason: "waiting for runtime capacity",
              });
            }
            stalledPolls = 0;
            await this.#sleep(signal);
            continue;
          }
          // Only run-owned work demonstrates progress. Unassigned or otherwise
          // intrinsically stuck work must fail even while unrelated sessions live.
          stalledPolls = dispatched === 0 ? stalledPolls + 1 : 0;
          if (stalledPolls >= 20) {
            const summary = tasks.map((task) => `${task.id}:${task.status}${task.assignedTo ? "" : ":unassigned"}`).join(", ");
            throw new Error(`Automation run ${run.id} cannot make progress (${summary})`);
          }
          await this.#sleep(signal);
          continue;
        }
        if (durableRun.status !== "running") {
          this.#repository.updateAutomationRunStatus(run.id, "running");
          this.#emit(run.workspaceId, run.automationId, "automation.resumed", {
            automationId: run.automationId,
            runId: run.id,
          });
        }
        stalledPolls = 0;
        const harness = this.#harnesses.get(session.agentId);
        if (!harness) throw new Error(`No harness registered for agent ${session.agentId}`);
        for await (const event of harness.events(session.id)) {
          if (signal.aborted) return;
          await this.#scheduler.handleSessionEvent(run.workspaceId, session.id, event);
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      const current = this.#repository.getAutomationRun(run.id);
      if (current && current.status !== "completed" && current.status !== "failed" && current.status !== "cancelled") {
        await Promise.allSettled(current.taskIds.map((taskId) => this.#scheduler.cancelTask(run.workspaceId, taskId)));
        this.#repository.finalizeAutomationRun(run.id, "failed", message);
        this.#emit(run.workspaceId, run.automationId, "automation.failed", { automationId: run.automationId, runId: run.id, error: message });
      }
    }
  }

  #emit(workspaceId: WorkspaceId, automationId: string, type: string, payload: unknown): void {
    const event = this.#repository.appendEvent({ workspaceId, source: { type: "automation", id: automationId }, type, payload });
    this.#onEvent?.(event);
  }

  #sleep(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        signal.removeEventListener("abort", stop);
        resolve();
      };
      const timer = setTimeout(done, POLL_MS);
      const stop = () => { clearTimeout(timer); done(); };
      signal.addEventListener("abort", stop, { once: true });
    });
  }
}
