import type {
  Decision,
  DecisionProvider,
  Plan,
  PlanProposalContext,
  PlanTaskOutcome,
} from "../core/types.ts";
import { createLLMDecisionProvider } from "./llm-decision-provider.ts";

const MAX_FAST_PATH_GOAL_LENGTH = 240;
const MAX_TRACKED_FAST_PATH_TASKS = 1_024;
const DIRECT_SINGLE_STAGE_ACTION = /\b(create|build|make|implement|add|fix|update|change|rename|remove|write|draft|generate)\b/i;
const INFORMATION_ACTION = /\b(research|explain|summari[sz]e)\b/i;
const COMPLEXITY_MARKER = /\b(compare|evaluate|analy[sz]e|audit|investigate|architecture|architect|migrate|migration|benchmark|parallel|multiple|multi[- ]agent|across)\b|\b(and then|then verify|then test|after that)\b|\b(and|then)\s+(create|build|implement|fix|update|change|remove|write|draft|document|prepare|produce)\b/i;

export const DEFAULT_PLANNER_TIMEOUT_MS = 20_000;

export type MissionRoutingMode = "single-worker" | "planner";
export type RoutedPlan = Plan & { routingMode: MissionRoutingMode };

export interface SingleWorkerFastPathOptions {
  plannerTimeoutMs?: number;
}

function routedPlan(plan: Plan, routingMode: MissionRoutingMode): RoutedPlan {
  return { ...plan, routingMode };
}

function deterministicTaskEvaluation(taskResult: PlanTaskOutcome, madeBy: string): Decision {
  const accepted = taskResult.status === "completed";
  return {
    id: crypto.randomUUID(),
    workspaceId: taskResult.taskId,
    type: "task.evaluation",
    summary: accepted
      ? `Task ${taskResult.taskId} completed${taskResult.resultSummary ? `: ${taskResult.resultSummary}` : ""}`
      : `Task ${taskResult.taskId} did not complete (status ${taskResult.status})`,
    payload: taskResult,
    madeBy,
    timestamp: Date.now(),
    status: accepted ? "accepted" : "rejected",
  };
}

/**
 * Short, single-stage work should not pay a planner round-trip just because the
 * user omitted a magic qualifier such as "simple". Keep explicit complexity
 * markers on the planner path so decomposition remains available when useful.
 */
export function shouldUseSingleWorkerFastPath(goal: string): boolean {
  const normalized = goal.trim();
  if (!normalized || normalized.length > MAX_FAST_PATH_GOAL_LENGTH) return false;
  if (normalized.includes("\n") || normalized.includes(";")) return false;
  if (COMPLEXITY_MARKER.test(normalized)) return false;

  return DIRECT_SINGLE_STAGE_ACTION.test(normalized) || INFORMATION_ACTION.test(normalized);
}

export class SingleWorkerFastPathDecisionProvider implements DecisionProvider {
  readonly name: string;
  readonly #delegate: DecisionProvider;
  readonly #plannerTimeoutMs: number;
  readonly #fastPathTaskIds = new Set<string>();

  constructor(delegate: DecisionProvider, options: SingleWorkerFastPathOptions = {}) {
    this.#delegate = delegate;
    this.name = `${delegate.name}-single-worker-fast-path`;
    this.#plannerTimeoutMs = options.plannerTimeoutMs ?? DEFAULT_PLANNER_TIMEOUT_MS;
    if (!Number.isFinite(this.#plannerTimeoutMs) || this.#plannerTimeoutMs <= 0) {
      throw new Error(`plannerTimeoutMs must be a positive number (received ${this.#plannerTimeoutMs})`);
    }
  }

  async proposePlan(input: PlanProposalContext): Promise<RoutedPlan | null> {
    const workers = input.availableWorkers ?? [];
    if (!shouldUseSingleWorkerFastPath(input.goal) || workers.length === 0) {
      const plan = await this.#proposeWithTimeout(input);
      return plan ? routedPlan(plan, "planner") : null;
    }

    const taskId = crypto.randomUUID();
    this.#rememberFastPathTask(taskId);
    return routedPlan({
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      goal: input.goal,
      status: "proposed",
      tasks: [{
        id: taskId,
        title: "Complete the request",
        description: input.goal,
        dependencies: [],
        priority: 1,
        nodeType: "agent.llm",
        assignedTo: workers[0].id,
      }],
      taskIds: [taskId],
      createdAt: Date.now(),
    }, "single-worker");
  }

  async evaluate(taskResult: PlanTaskOutcome): Promise<Decision> {
    if (this.#fastPathTaskIds.delete(taskResult.taskId)) {
      return deterministicTaskEvaluation(taskResult, this.name);
    }
    return this.#delegate.evaluate(taskResult);
  }

  #rememberFastPathTask(taskId: string): void {
    if (this.#fastPathTaskIds.size >= MAX_TRACKED_FAST_PATH_TASKS) {
      const oldest = this.#fastPathTaskIds.values().next().value;
      if (oldest !== undefined) this.#fastPathTaskIds.delete(oldest);
    }
    this.#fastPathTaskIds.add(taskId);
  }

  async #proposeWithTimeout(input: PlanProposalContext): Promise<Plan | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(
          `Planner timed out after ${this.#plannerTimeoutMs}ms before any worker could start`,
        ));
      }, this.#plannerTimeoutMs);
    });

    try {
      return await Promise.race([this.#delegate.proposePlan(input), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** Use the normal configured LLM planner, with a bounded single-worker shortcut. */
export function createMissionDecisionProvider(): DecisionProvider | null {
  const provider = createLLMDecisionProvider();
  return provider ? new SingleWorkerFastPathDecisionProvider(provider) : null;
}
