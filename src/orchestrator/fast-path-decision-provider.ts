import type {
  Decision,
  DecisionProvider,
  Plan,
  PlanProposalContext,
  PlanTaskOutcome,
} from "../core/types.ts";
import { createLLMDecisionProvider } from "./llm-decision-provider.ts";

const MAX_FAST_PATH_GOAL_LENGTH = 240;
const IMPLEMENTATION_ACTION = /\b(create|build|make|implement|add|fix|update|change|rename|remove)\b/i;
const INFORMATION_ACTION = /\b(research|explain|summari[sz]e)\b/i;
const COMPLEXITY_MARKER = /\b(compare|evaluate|analy[sz]e|audit|investigate|architecture|architect|migrate|migration|benchmark|parallel|multiple|multi[- ]agent|across)\b|\b(and then|then verify|then test|after that)\b|\b(and|then)\s+(create|build|implement|fix|update|change|remove|write|draft|document|prepare|produce)\b/i;

export type MissionRoutingMode = "single-worker" | "planner";
export type RoutedPlan = Plan & { routingMode: MissionRoutingMode };

function routedPlan(plan: Plan, routingMode: MissionRoutingMode): RoutedPlan {
  return { ...plan, routingMode };
}

/**
 * Short, single-action requests should reach a worker without a planner round
 * trip. Complexity markers remain the fail-closed boundary for work that
 * benefits from decomposition.
 */
export function shouldUseSingleWorkerFastPath(goal: string): boolean {
  const normalized = goal.trim();
  if (!normalized || normalized.length > MAX_FAST_PATH_GOAL_LENGTH) return false;
  if (normalized.includes("\n") || normalized.includes(";")) return false;
  if (COMPLEXITY_MARKER.test(normalized)) return false;

  const straightforwardImplementation = IMPLEMENTATION_ACTION.test(normalized);
  const straightforwardInformationRequest = INFORMATION_ACTION.test(normalized);

  return straightforwardImplementation || straightforwardInformationRequest;
}

export class SingleWorkerFastPathDecisionProvider implements DecisionProvider {
  readonly name: string;
  readonly #delegate: DecisionProvider;

  constructor(delegate: DecisionProvider) {
    this.#delegate = delegate;
    this.name = `${delegate.name}-single-worker-fast-path`;
  }

  async proposePlan(input: PlanProposalContext): Promise<RoutedPlan | null> {
    const workers = input.availableWorkers ?? [];
    if (!shouldUseSingleWorkerFastPath(input.goal) || workers.length === 0) {
      const plan = await this.#delegate.proposePlan(input);
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
        title: "Complete the simple request",
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
}

/** Use the normal configured LLM planner, with a narrow no-planner shortcut. */
export function createMissionDecisionProvider(): DecisionProvider | null {
  const provider = createLLMDecisionProvider();
  return provider ? new SingleWorkerFastPathDecisionProvider(provider) : null;
}
