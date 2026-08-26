import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createChef } from "../src/main.ts";
import { createMissionDecisionProvider } from "../src/orchestrator/fast-path-decision-provider.ts";
import { applyOrchestratorProviderEnv } from "../src/server/orchestrator-config.ts";

const REQUEST = "Create a simple todo app";
const STARTUP_BUDGET_MS = Number(process.env.CHEF_LIVE_STARTUP_BUDGET_MS ?? 5_000);
const COMPLETION_BUDGET_MS = Number(process.env.CHEF_LIVE_COMPLETION_BUDGET_MS ?? 10 * 60_000);

function positiveBudget(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

async function waitForSession(
  chef: ReturnType<typeof createChef>,
  taskCapableWorkerIds: ReadonlySet<string>,
  existingSessionIds: ReadonlySet<string>,
  budgetMs: number,
): Promise<{ id: string; agentId: string; taskId: string }> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const snapshot = await chef.inspectState();
    const session = snapshot.sessions.find(
      (candidate) => taskCapableWorkerIds.has(candidate.agentId) && !existingSessionIds.has(candidate.id),
    );
    if (session) return { id: session.id, agentId: session.agentId, taskId: session.taskId };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`No new detected task-capable CLI worker Session started within ${budgetMs}ms`);
}

async function withDeadline<T>(promise: Promise<T>, budgetMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${budgetMs}ms`)), budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  positiveBudget("CHEF_LIVE_STARTUP_BUDGET_MS", STARTUP_BUDGET_MS);
  positiveBudget("CHEF_LIVE_COMPLETION_BUDGET_MS", COMPLETION_BUDGET_MS);

  await applyOrchestratorProviderEnv();
  const decisionProvider = createMissionDecisionProvider();
  assert.ok(
    decisionProvider,
    "No real orchestrator provider is configured. Configure Chef's provider first or set CHEF_PROVIDER plus its API key.",
  );

  const suppliedProject = process.env.CHEF_LIVE_PROJECT_DIR?.trim();
  const projectDir = suppliedProject
    ? resolve(suppliedProject)
    : await mkdtemp(join(tmpdir(), "chef-live-todo-"));
  const ownsProjectDir = !suppliedProject;
  const dbPath = join(projectDir, ".chef-live-diagnostic.sqlite");
  const chef = createChef({
    dbPath,
    projectDir,
    decisionProvider,
    orchestratorTimeoutMs: COMPLETION_BUDGET_MS,
  });

  try {
    await chef.start();
    assert.equal(chef.llmStatus.configured, true, "Chef must report a configured real LLM provider");

    const availableWorkers = chef.specializedHarnesses.detections()
      .filter((worker) => worker.available && worker.taskCapable);
    assert.ok(
      availableWorkers.length > 0,
      `No task-capable CLI worker was detected. Detection: ${chef.specializedHarnesses.detections()
        .map((worker) => `${worker.id}=${worker.available ? "available" : "missing"}${worker.taskCapable ? ":task" : ""}`)
        .join(", ")}`,
    );
    const workerIds = new Set(availableWorkers.map((worker) => worker.id));
    const beforeExecution = await chef.inspectState();
    const existingSessionIds = new Set(beforeExecution.sessions.map((session) => session.id));

    console.log(`[live-todo] project: ${projectDir}`);
    console.log(`[live-todo] provider: ${chef.llmStatus.provider}/${chef.llmStatus.model}`);
    console.log(`[live-todo] detected workers: ${[...workerIds].join(", ")}`);
    console.log(`[live-todo] request: ${REQUEST}`);

    const execution = chef.sendUserMessage(REQUEST);
    const session = await waitForSession(chef, workerIds, existingSessionIds, STARTUP_BUDGET_MS);
    console.log(`[live-todo] worker started: ${session.agentId} session=${session.id} task=${session.taskId}`);

    const result = await withDeadline(execution, COMPLETION_BUDGET_MS, "Live todo Mission");
    assert.equal(result.ok, true, `Live todo Mission failed: ${result.report}`);
    assert.ok(result.taskIds.includes(session.taskId), "Observed CLI Session must belong to the completed Mission");

    const snapshot = await chef.inspectState();
    const mission = snapshot.missions.find((candidate) => candidate.taskIds.includes(session.taskId));
    assert.equal(mission?.status, "completed", "Live todo Mission must reach completed state");

    console.log(`[live-todo] completed: ${result.report}`);
  } finally {
    await chef.close();
    if (ownsProjectDir) await rm(projectDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[live-todo] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
