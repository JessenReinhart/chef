import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericTerminalHarness } from "../src/harness/generic.ts";
import { createChef, type ChefRuntime } from "../src/main.ts";
import { createMissionDecisionProvider } from "../src/orchestrator/fast-path-decision-provider.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { createThreadServer } from "../src/server/thread-http.ts";

const WORKER_STARTUP_BUDGET_MS = 1_500;
const FIXTURE_SETTLE_BUDGET_MS = 5_000;
const POLL_MS = 20;
const TODO_REQUEST = "Create a simple todo app";
const ACCEPTANCE_WORKER_ID = "acceptance-worker";

class AcceptanceTaskHarness extends GenericTerminalHarness {
  readonly taskCapable = true;

  taskLaunch(): { command: string; args: string[] } {
    return { command: this.command, args: this.args };
  }
}

async function waitForWorkerStartup(
  inspect: () => Promise<{ tasks: Array<{ id: string }>; sessions: Array<{ id: string }> }>,
): Promise<void> {
  const deadline = Date.now() + WORKER_STARTUP_BUDGET_MS;
  let lastTaskCount = 0;
  let lastSessionCount = 0;

  while (Date.now() < deadline) {
    const snapshot = await inspect();
    lastTaskCount = snapshot.tasks.length;
    lastSessionCount = snapshot.sessions.length;
    if (lastTaskCount > 0 && lastSessionCount > 0) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  assert.fail(
    `Thread request did not reach a real worker session within ${WORKER_STARTUP_BUDGET_MS}ms `
    + `(tasks=${lastTaskCount}, sessions=${lastSessionCount})`,
  );
}

async function allowFixtureToSettle(chef: ChefRuntime, missionId: string): Promise<void> {
  const deadline = Date.now() + FIXTURE_SETTLE_BUDGET_MS;
  while (Date.now() < deadline) {
    const mission = chef.repository.getMission(missionId);
    if (!mission || ["completed", "failed", "cancelled"].includes(mission.status)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  const mission = chef.repository.getMission(missionId);
  if (mission && !["completed", "failed", "cancelled"].includes(mission.status)) {
    await chef.cancelMission(missionId);
  }
}

const dir = await mkdtemp(join(tmpdir(), "chef-thread-worker-startup-"));
const previousEnv = {
  path: process.env.PATH,
  provider: process.env.CHEF_PROVIDER,
  apiKey: process.env.CHEF_API_KEY,
  model: process.env.CHEF_MODEL,
  baseUrl: process.env.CHEF_BASE_URL,
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
};

// Model the production server's no-planner mode deterministically. Hiding PATH
// during harness discovery prevents a developer/CI machine's incidental CLI
// installs from changing which worker wins the fast path; the acceptance worker
// uses process.execPath directly and therefore remains cross-platform.
process.env.PATH = "";
delete process.env.CHEF_PROVIDER;
delete process.env.CHEF_API_KEY;
delete process.env.CHEF_MODEL;
delete process.env.CHEF_BASE_URL;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const decisionProvider = createMissionDecisionProvider({ allowDirectWithoutPlanner: true });
assert.ok(decisionProvider, "production no-planner mode must provide bounded direct-worker routing");
const chef = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir, decisionProvider });
chef.specializedHarnesses.register(ACCEPTANCE_WORKER_ID, "Acceptance Worker", () => new AcceptanceTaskHarness({
  agentId: ACCEPTANCE_WORKER_ID,
  workspaceId: chef.workspaceId,
  command: process.execPath,
  args: ["-e", "setTimeout(() => {}, 1000)"],
  cwd: dir,
}));

let server: ReturnType<typeof createThreadServer> | undefined;
let acknowledgedMissionId: string | undefined;

try {
  await chef.start();

  // Detection is complete; restore the host environment so the test does not
  // leak configuration into later work in the same process.
  if (previousEnv.path === undefined) delete process.env.PATH; else process.env.PATH = previousEnv.path;
  if (previousEnv.provider === undefined) delete process.env.CHEF_PROVIDER; else process.env.CHEF_PROVIDER = previousEnv.provider;
  if (previousEnv.apiKey === undefined) delete process.env.CHEF_API_KEY; else process.env.CHEF_API_KEY = previousEnv.apiKey;
  if (previousEnv.model === undefined) delete process.env.CHEF_MODEL; else process.env.CHEF_MODEL = previousEnv.model;
  if (previousEnv.baseUrl === undefined) delete process.env.CHEF_BASE_URL; else process.env.CHEF_BASE_URL = previousEnv.baseUrl;
  if (previousEnv.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousEnv.openai;
  if (previousEnv.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previousEnv.anthropic;

  server = createThreadServer(chef, createHttpServer(chef));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("worker-startup HTTP server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  assert.equal(chef.llmStatus.configured, false, "acceptance must run without a configured planner provider");
  const detections = chef.specializedHarnesses.detections();
  const readyTaskWorkers = detections.filter((worker) => worker.available && worker.taskCapable);
  assert.deepEqual(
    readyTaskWorkers.map((worker) => worker.id),
    [ACCEPTANCE_WORKER_ID],
    "acceptance must exercise one deterministic detected task-capable CLI worker",
  );

  const createThreadResponse = await fetch(`${baseUrl}/api/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Worker startup acceptance" }),
  });
  assert.equal(createThreadResponse.status, 201);
  const created = await createThreadResponse.json() as { data?: { id?: string } };
  const threadId = created.data?.id;
  assert.ok(threadId);

  const response = await fetch(`${baseUrl}/api/threads/${encodeURIComponent(threadId)}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: TODO_REQUEST }),
  });
  assert.equal(response.status, 202, "selected-Thread chat must acknowledge durable work without waiting for completion");
  const body = await response.json() as { ok?: boolean; data?: { ok?: boolean; accepted?: boolean; missionId?: string; threadId?: string } };
  assert.equal(body.ok, true);
  assert.equal(body.data?.ok, true);
  assert.equal(body.data?.accepted, true);
  assert.equal(body.data?.threadId, threadId);
  const missionId = body.data?.missionId;
  assert.ok(missionId, "Thread acknowledgement must expose its durable Mission lineage");
  acknowledgedMissionId = missionId;

  await waitForWorkerStartup(async () => {
    const snapshot = await chef.inspectState();
    const missionTasks = snapshot.tasks.filter((task) => task.missionId === missionId);
    const taskIds = new Set(missionTasks.map((task) => task.id));
    return {
      tasks: missionTasks,
      sessions: snapshot.sessions.filter((session) => taskIds.has(session.taskId)),
    };
  });

  const finalSnapshot = await chef.inspectState();
  const missionTasks = finalSnapshot.tasks.filter((task) => task.missionId === missionId);
  const missionTaskIds = new Set(missionTasks.map((task) => task.id));
  const missionSessions = finalSnapshot.sessions.filter((session) => missionTaskIds.has(session.taskId));
  assert.equal(missionTasks.length, 1, "canonical bounded request must create exactly one worker Task");
  assert.equal(missionTasks[0].assignedTo, ACCEPTANCE_WORKER_ID, "no-planner production routing must assign the detected CLI worker");
  assert.equal(missionTasks[0].description, TODO_REQUEST, "canonical request must reach the worker unchanged");
  assert.ok(missionSessions.length > 0, "acknowledged Mission must persist its real worker Session");
  assert.ok(missionSessions.every((session) => session.agentId === ACCEPTANCE_WORKER_ID), "worker Session must belong to the detected CLI worker");
  assert.ok(missionSessions.every((session) => session.command.length > 0), "worker Session command must be observable");

  const planningStarted = finalSnapshot.events.find((event) =>
    event.type === "orchestrator.plan.started"
    && (event.payload as { missionId?: unknown }).missionId === missionId
  );
  assert.ok(planningStarted, "successful worker startup must retain durable Mission-correlated planning-start evidence");

  const planningSucceeded = finalSnapshot.events.find((event) =>
    event.type === "orchestrator.plan.proposed"
    && (event.payload as { missionId?: unknown }).missionId === missionId
  );
  assert.ok(planningSucceeded, "successful planning must remain correlated to the Mission before Task creation");
  assert.equal(
    (planningSucceeded.payload as { routingMode?: unknown }).routingMode,
    "single-worker",
    "production no-planner path must durably expose its bounded single-worker routing decision",
  );
  assert.ok(planningStarted.seq < planningSucceeded.seq, "planning-start evidence must precede the accepted plan");

  const firstTaskId = missionTasks[0]?.id;
  const taskCreated = firstTaskId
    ? finalSnapshot.events.find((event) => event.type === "orchestrator.task.created" && event.taskId === firstTaskId)
    : undefined;
  assert.ok(taskCreated, "worker startup must retain durable Task creation evidence");
  assert.ok(planningSucceeded.seq < taskCreated.seq, "accepted plan evidence must precede real worker Task creation");
} finally {
  // Also restore configuration when startup itself fails.
  if (previousEnv.path === undefined) delete process.env.PATH; else process.env.PATH = previousEnv.path;
  if (previousEnv.provider === undefined) delete process.env.CHEF_PROVIDER; else process.env.CHEF_PROVIDER = previousEnv.provider;
  if (previousEnv.apiKey === undefined) delete process.env.CHEF_API_KEY; else process.env.CHEF_API_KEY = previousEnv.apiKey;
  if (previousEnv.model === undefined) delete process.env.CHEF_MODEL; else process.env.CHEF_MODEL = previousEnv.model;
  if (previousEnv.baseUrl === undefined) delete process.env.CHEF_BASE_URL; else process.env.CHEF_BASE_URL = previousEnv.baseUrl;
  if (previousEnv.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousEnv.openai;
  if (previousEnv.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previousEnv.anthropic;

  if (acknowledgedMissionId) await allowFixtureToSettle(chef, acknowledgedMissionId);
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  await chef.close();
  await rm(dir, { recursive: true, force: true });
}

console.log("thread-worker-startup: ok — production no-planner Thread chat acknowledges first and durably reaches one detected CLI worker Session within its startup budget");
