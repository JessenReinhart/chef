import { AsyncLocalStorage } from "node:async_hooks";
import type { AvailableWorker } from "../core/types.ts";

export type WorkerPolicy =
  | { mode: "auto" }
  | { mode: "preferred"; workerId: string }
  | { mode: "locked"; workerId: string };

const policyContext = new AsyncLocalStorage<WorkerPolicy>();

export function parseWorkerPolicy(value: unknown): WorkerPolicy {
  if (value === undefined || value === null) return { mode: "auto" };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workerPolicy must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.mode === "auto") return { mode: "auto" };
  if (record.mode !== "preferred" && record.mode !== "locked") {
    throw new Error("workerPolicy.mode must be auto, preferred, or locked");
  }
  if (typeof record.workerId !== "string" || record.workerId.trim().length === 0) {
    throw new Error(`workerPolicy.workerId is required for ${record.mode} mode`);
  }
  return { mode: record.mode, workerId: record.workerId.trim() };
}

export function runWithWorkerPolicy<T>(policy: WorkerPolicy, fn: () => T): T {
  return policyContext.run(policy, fn);
}

export function currentWorkerPolicy(): WorkerPolicy {
  return policyContext.getStore() ?? { mode: "auto" };
}

export interface WorkerPolicyResolution {
  workers: AvailableWorker[];
  policy: WorkerPolicy;
  fallback: boolean;
}

export function resolveWorkerPolicy(
  workers: readonly AvailableWorker[],
  policy: WorkerPolicy = currentWorkerPolicy(),
): WorkerPolicyResolution {
  const available = workers.map((worker) => ({ ...worker }));
  if (policy.mode === "auto") {
    return { workers: available, policy, fallback: false };
  }

  const selected = available.find((worker) => worker.id === policy.workerId);
  if (selected) {
    // A user-selected worker outranks planner preference. Exposing only the
    // selected worker keeps assignment deterministic without rewriting plans.
    return { workers: [selected], policy, fallback: false };
  }

  if (policy.mode === "locked") {
    throw new Error(`Required worker is not available for Mission execution: ${policy.workerId}`);
  }

  // Preferred mode intentionally degrades to Auto when the selected worker is
  // unavailable. The planner can then choose from every healthy worker.
  return { workers: available, policy, fallback: true };
}
