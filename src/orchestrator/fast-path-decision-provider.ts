import type {
  Decision,
  DecisionProvider,
  Plan,
  PlanProposalContext,
  PlanTaskOutcome,
} from "../core/types.ts";
import { createLLMDecisionProvider } from "./llm-decision-provider.ts";

const MAX_FAST_PATH_GOAL_LENGTH = 240;
const SIMPLE_QUALIFIER = /\b(simple|small|basic|minimal|tiny)\b/i;
const IMPLEMENTATION_ACTION = /\b(create|build|make|implement|add|fix|update|change|rename|remove)\b/i;
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

  const qualifiedImplementation = SIMPLE_QUALIFIER.test(normalized)
    && IMPLEMENTATION_ACTION.test(normalized);
  const straightforwardSingleStageWork = DIRECT_SINGLE_STAGE_ACTION.test(normalized);
  const straightforwardInformationRequest = INFORMATION_ACTION.test(normalized);

  return qualifiedImplementation || straightforwardSingleStageWork || straightforwardInformationRequest;
}

export class SingleWorkerFastPathDecisionProvider implements DecisionProvider {
  readonly name: string;
  readonly #delegate: DecisionProvider;
  readonly #plannerTimeoutMs: number;

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

  evaluate(taskResult: PlanTaskOutcome): Promise<Decision> {
    return this.#delegate.evaluate(taskResult);
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
