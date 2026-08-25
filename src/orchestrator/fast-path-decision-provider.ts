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
const INFORMATION_ACTION = /\b(research|explain|summari[sz]e)\b/i;
const COMPLEXITY_MARKER = /\b(compare|evaluate|analy[sz]e|audit|investigate|architecture|architect|migrate|migration|benchmark|parallel|multiple|multi[- ]agent|across)\b|\b(and then|then verify|then test|after that)\b|\b(and|then)\s+(create|build|implement|fix|update|change|remove)\b/i;

/**
 * Keep the shortcut deliberately narrow. A false negative only costs one
 * planning round-trip; a false positive can collapse work that genuinely
 * benefits from decomposition.
 */
export function shouldUseSingleWorkerFastPath(goal: string): boolean {
  const normalized = goal.trim();
  if (!normalized || normalized.length > MAX_FAST_PATH_GOAL_LENGTH) return false;
  if (normalized.includes("\n") || normalized.includes(";")) return false;
  if (COMPLEXITY_MARKER.test(normalized)) return false;

  const simpleImplementation = SIMPLE_QUALIFIER.test(normalized)
    && IMPLEMENTATION_ACTION.test(normalized);
  const straightforwardInformationRequest = INFORMATION_ACTION.test(normalized);

  return simpleImplementation || straightforwardInformationRequest;
}

export class SingleWorkerFastPathDecisionProvider implements DecisionProvider {
  readonly name: string;
  readonly #delegate: DecisionProvider;

  constructor(delegate: DecisionProvider) {
    this.#delegate = delegate;
    this.name = `${delegate.name}-single-worker-fast-path`;
  }

  async proposePlan(input: PlanProposalContext): Promise<Plan | null> {
    const workers = input.availableWorkers ?? [];
    if (!shouldUseSingleWorkerFastPath(input.goal) || workers.length === 0) {
      return this.#delegate.proposePlan(input);
    }

    const taskId = crypto.randomUUID();
    return {
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
    };
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
