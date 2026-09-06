import { strict as assert } from "node:assert";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GenericTerminalHarness } from "../src/harness/generic.ts";
import { createChef } from "../src/main.ts";
import { createProjectServer } from "../src/server/project-http.ts";
import { createThreadServer } from "../src/server/thread-http.ts";
import { artifactHandoff } from "../web/src/artifactHandoff.ts";
import type { LivingArtifact } from "../web/src/artifactProjection.ts";
import type {
  AgentId,
  Decision,
  DecisionProvider,
  Plan,
  PlanProposalContext,
  PlanTaskOutcome,
  RuntimeEvent,
  WorkspaceId,
} from "../src/core/types.ts";

const TODO_REQUEST = "Create a simple todo app";
const TODO_APP = "todo-app.mjs";
const TODO_APP_SOURCE = String.raw`import { createServer } from "node:http";

const todos = [];
const page = () => [
  "<!doctype html>",
  "<html lang=\"en\">",
  "<head><meta charset=\"utf-8\"><title>Chef Todo</title></head>",
  "<body><main>",
  "<h1>Chef Todo</h1>",
  "<form id=\"todo-form\"><input id=\"todo-input\" aria-label=\"New todo\"><button>Add</button></form>",
  "<ul id=\"todo-list\"></ul>",
  "</main>",
  "<script>",
  "const form=document.querySelector('#todo-form');",
  "const input=document.querySelector('#todo-input');",
  "const list=document.querySelector('#todo-list');",
  "form.addEventListener('submit',(event)=>{event.preventDefault();const text=input.value.trim();if(!text)return;const item=document.createElement('li');item.textContent=text;list.append(item);input.value='';});",
  "</script>",
  "</body></html>",
].join("");

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/api/todos") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(todos));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page());
});

server.listen(Number(process.env.PORT || 0), "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  console.log("LISTENING:" + address.port);
});
`;

class TodoAcceptanceDecisionProvider implements DecisionProvider {
  readonly name = "golden-todo-acceptance";
  readonly #projectDir: string;
  readonly #workerScript: string;
  #workspaceId: WorkspaceId = "";

  constructor(projectDir: string, workerScript: string) {
    this.#projectDir = projectDir;
    this.#workerScript = workerScript;
  }

  async proposePlan(input: PlanProposalContext): Promise<Plan & { routingMode: "single-worker" }> {
    this.#workspaceId = input.workspaceId;
    // Keep planning open briefly so the Thread HTTP acknowledgement is
    // observable before the worker can finish, without requiring mutable
    // persisted Mission state to still be planning when the client reads 202.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const taskId = crypto.randomUUID();
    return {
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      goal: input.goal,
      status: "proposed",
      routingMode: "single-worker",
      tasks: [{
        id: taskId,
        title: "Build the todo app",
        description: input.goal,
        dependencies: [],
        priority: 1,
        assignedTo: "todo-builder",
      }],
      taskIds: [taskId],
      createdAt: Date.now(),
    };
  }

  harnessFor(agentId: AgentId, workspaceId: WorkspaceId): GenericTerminalHarness {
    assert.equal(agentId, "todo-builder");
    return new GenericTerminalHarness({
      agentId,
      workspaceId,
      command: process.execPath,
      args: [this.#workerScript],
      cwd: this.#projectDir,
    });
  }

  async evaluate(taskResult: PlanTaskOutcome): Promise<Decision> {
    const accepted = taskResult.status === "completed";
    return {
      id: crypto.randomUUID(),
      workspaceId: this.#workspaceId,
      type: "task.evaluation",
      summary: accepted ? "Todo app worker completed" : `Todo app worker ended as ${taskResult.status}`,
      payload: taskResult,
      madeBy: this.name,
      timestamp: Date.now(),
      status: accepted ? "accepted" : "rejected",
    };
  }
}

async function writeTodoWorker(projectDir: string): Promise<string> {
  const workerScript = join(projectDir, "golden-todo-worker.cjs");
  const source = String.raw`
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const appPath = path.join(process.cwd(), ${JSON.stringify(TODO_APP)});
fs.writeFileSync(appPath, ${JSON.stringify(TODO_APP_SOURCE)}, "utf8");

const sid = process.env.CHEF_SESSION_ID;
if (!sid) throw new Error("CHEF_SESSION_ID is required for the golden acceptance worker");
const envelope = {
  version: 1,
  id: crypto.randomUUID(),
  kind: "artifact",
  from: "process",
  payload: {
    type: "result",
    name: "todo-app",
    uri: "file://" + appPath.replace(/\\\\/g, "/"),
    metadata: {
      content: "Created runnable todo app at " + appPath,
      run: process.execPath + " " + appPath,
      verifiedBy: "golden-path"
    }
  },
  timestamp: Date.now()
};
const outbox = path.join(os.tmpdir(), "chef-sideband", sid, "outbox");
fs.mkdirSync(outbox, { recursive: true });
fs.writeFileSync(path.join(outbox, envelope.id + ".json"), JSON.stringify(envelope));
console.log("todo-builder: created " + appPath);
`;
  await writeFile(workerScript, source, "utf8");
  return workerScript;
}

async function assertGeneratedAppRuns(appPath: string): Promise<void> {
  const child = spawn(process.execPath, [appPath], {
    cwd: dirname(appPath),
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  try {
    const deadline = Date.now() + 5_000;
    let port: number | undefined;
    while (Date.now() < deadline) {
      const match = stdout.match(/LISTENING:(\d+)/);
      if (match) {
        port = Number(match[1]);
        break;
      }
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(port, `generated todo app did not start; stdout=${stdout} stderr=${stderr}`);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200, "generated todo app must answer HTTP requests");
    const html = await response.text();
    assert.match(html, /Chef Todo/, "generated app must render its todo UI");
    assert.match(html, /todo-form/, "generated app must expose the todo interaction");
  } finally {
    if (child.exitCode === null) child.kill();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }
}

async function startJourneyServer(
  chef: ReturnType<typeof createChef>,
  projectDir: string,
): Promise<{ server: ReturnType<typeof createProjectServer>; baseUrl: string }> {
  const base = createHttpServer((_req, res) => {
    res.writeHead(404);
    res.end("not found");
  });
  const threadServer = createThreadServer(chef, base);
  const server = createProjectServer(chef, threadServer, {
    recentProjectsPath: join(projectDir, ".chef-golden-recent.json"),
    pickDirectory: async () => projectDir,
    canPickDirectory: async () => true,
    onOpenProject: async () => {
      assert.fail("selecting the already-active golden project must not relaunch Chef");
    },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object", "golden journey server must listen on TCP");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function assertProjectSelectionBeforeTask(baseUrl: string, projectDir: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/project/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: projectDir }),
  });
  assert.equal(response.status, 200, "golden path must explicitly select its local project before task submission");
  const body = await response.json() as { ok?: boolean; data?: { path?: string; current?: boolean } };
  assert.equal(body.ok, true, "project selection must clearly report success");
  assert.equal(body.data?.path, projectDir, "project selection must confirm the requested local project");
  assert.equal(body.data?.current, true, "project selection must settle as the active project before task submission");
}

async function submitTodoThroughThreadHttp(
  baseUrl: string,
  workspaceId: string,
): Promise<{ threadId: string; missionId: string }> {
  const threadResponse = await fetch(`${baseUrl}/api/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Todo golden path" }),
  });
  assert.equal(threadResponse.status, 201, "golden path must create the same durable Thread surface used by Simple Mode");
  const threadBody = await threadResponse.json() as {
    ok?: boolean;
    data?: { id?: string; workspaceId?: string; status?: string };
  };
  assert.equal(threadBody.ok, true, "Thread creation must succeed");
  assert.equal(threadBody.data?.workspaceId, workspaceId, "Thread must belong to the selected project workspace");
  assert.equal(threadBody.data?.status, "active", "canonical Thread must be writable");
  assert.ok(threadBody.data?.id, "Thread creation must return a durable id");
  const threadId = threadBody.data.id;

  const chatResponse = await fetch(`${baseUrl}/api/threads/${encodeURIComponent(threadId)}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: TODO_REQUEST }),
  });
  assert.equal(chatResponse.status, 202, "Thread submission must acknowledge accepted work without waiting for completion");
  const chatBody = await chatResponse.json() as {
    ok?: boolean;
    data?: { accepted?: boolean; threadId?: string; missionId?: string };
  };
  assert.equal(chatBody.ok, true, "Thread submission acknowledgement must be successful");
  assert.equal(chatBody.data?.accepted, true, "Thread submission must explicitly report accepted work");
  assert.equal(chatBody.data?.threadId, threadId, "acknowledgement must retain the originating Thread identity");
  assert.ok(chatBody.data?.missionId, "acknowledgement must expose the created Mission identity");
  return { threadId, missionId: chatBody.data.missionId };
}

async function waitForThreadCompletionMessage(
  baseUrl: string,
  threadId: string,
  missionId: string,
): Promise<{ content: string; metadata?: Record<string, unknown> }> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/threads/${encodeURIComponent(threadId)}/messages`);
    assert.equal(response.status, 200, "Thread history must stay readable during canonical work");
    const body = await response.json() as {
      ok?: boolean;
      data?: Array<{ role?: string; content?: string; metadata?: Record<string, unknown> }>;
    };
    const completion = body.data?.find((message) =>
      message.role === "assistant" && message.metadata?.missionId === missionId && message.metadata?.ok === true
    );
    if (completion?.content) return { content: completion.content, metadata: completion.metadata };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("completed canonical Mission must persist its assistant handoff into the originating Thread");
}

function eventStatus(event: RuntimeEvent): unknown {
  if (typeof event.payload !== "object" || event.payload === null) return undefined;
  return (event.payload as Record<string, unknown>).status;
}

function eventRoutingMode(event: RuntimeEvent): unknown {
  if (typeof event.payload !== "object" || event.payload === null) return undefined;
  return (event.payload as Record<string, unknown>).routingMode;
}

async function waitForObservableEvent(
  events: readonly RuntimeEvent[],
  predicate: (event: RuntimeEvent) => boolean,
  timeoutMs: number,
  label: string,
): Promise<RuntimeEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = events.find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${label} was not observable within ${timeoutMs} ms`);
}

function assertRoutingModeIsDurable(events: readonly RuntimeEvent[]): void {
  const planEvent = events.find((event) => event.type === "orchestrator.plan.proposed");
  assert.ok(planEvent, "golden path must publish its routing decision");
  assert.equal(eventRoutingMode(planEvent), "single-worker", "golden path must retain the chosen routing mode");
}

function assertObservableMissionLifecycle(events: readonly RuntimeEvent[], taskIds: readonly string[]): void {
  const missionCreated = events.findIndex((event) =>
    event.type === "mission.created" && eventStatus(event) === "planning"
  );
  assert.ok(missionCreated >= 0, "golden path must visibly enter planning");

  const missionId = events[missionCreated].source.id;
  const taskIdSet = new Set(taskIds);
  const missionActive = events.findIndex((event) =>
    event.source.id === missionId && event.type === "mission.status" && eventStatus(event) === "active"
  );
  const workerActivity = events.findIndex((event) =>
    event.taskId !== undefined && taskIdSet.has(event.taskId) && event.type.startsWith("task.")
  );
  const missionVerifying = events.findIndex((event) =>
    event.source.id === missionId && event.type === "mission.status" && eventStatus(event) === "verifying"
  );
  const missionCompleted = events.findIndex((event) =>
    event.source.id === missionId && event.type === "mission.status" && eventStatus(event) === "completed"
  );

  assert.ok(missionActive > missionCreated, "golden path must visibly leave planning before worker activity");
  assert.ok(workerActivity > missionActive, "golden path must expose authoritative worker activity after Mission activation");
  assert.ok(missionVerifying > workerActivity, "golden path must visibly enter verification after worker activity");
  assert.ok(missionCompleted > missionVerifying, "golden path must visibly complete only after verification");
}

function resultHandoff(artifact: LivingArtifact, appPath: string): ReturnType<typeof artifactHandoff> {
  const handoff = artifactHandoff(artifact);
  assert.equal(handoff.summary, `Created runnable todo app at ${appPath}`, "Simple Mode handoff must explain what changed");
  assert.equal(handoff.location, appPath.replace(/\\/g, "/"), "Simple Mode handoff must expose the generated result location");
  assert.equal(handoff.runCommand, `${process.execPath} ${appPath}`, "Simple Mode handoff must explain how to run the generated result");
  assert.equal(handoff.verification, "Verified by golden-path", "Simple Mode handoff must expose the worker-supplied verification evidence");
  return handoff;
}

/**
 * P0 golden path: the permanent boring acceptance task traverses the real
 * project selection -> Thread HTTP -> Mission -> Plan -> Task -> PTY lifecycle,
 * produces a discoverable result in the selected project, runs successfully,
 * and survives close/reopen.
 */
async function main(): Promise<void> {
  const projectDir = await mkdtemp(join(tmpdir(), "chef-golden-project-"));
  const dbPath = join(projectDir, "chef.sqlite");
  const appPath = join(projectDir, TODO_APP);
  let journeyServer: ReturnType<typeof createProjectServer> | null = null;

  try {
    const workerScript = await writeTodoWorker(projectDir);
    const chef = createChef({
      dbPath,
      projectDir,
      decisionProvider: new TodoAcceptanceDecisionProvider(projectDir, workerScript),
      orchestratorTimeoutMs: 10_000,
    });
    await chef.start();

    assert.ok(chef.workspaceId, "start() must expose the selected workspace id");
    const workspaceId = chef.workspaceId;
    const journey = await startJourneyServer(chef, projectDir);
    journeyServer = journey.server;
    await assertProjectSelectionBeforeTask(journey.baseUrl, projectDir);

    const liveEvents: RuntimeEvent[] = [];
    const unsubscribe = chef.subscribeEvents((event) => liveEvents.push(event));
    const acknowledgement = await submitTodoThroughThreadHttp(journey.baseUrl, workspaceId);

    const planningEvent = await waitForObservableEvent(
      liveEvents,
      (event) => event.type === "mission.created" && eventStatus(event) === "planning",
      500,
      "planning acknowledgement",
    );
    const acknowledgedMission = chef.repository.listMissions(workspaceId).find(
      (candidate) => candidate.id === acknowledgement.missionId,
    );
    assert.ok(acknowledgedMission, "Thread acknowledgement must name a durable Mission in the selected workspace");
    assert.equal(acknowledgedMission.metadata.threadId, acknowledgement.threadId, "acknowledged Mission must already be linked to its originating Thread");

    await waitForObservableEvent(
      liveEvents,
      (event) => event.source.id === planningEvent.source.id && event.type === "mission.status" && eventStatus(event) === "active",
      2_000,
      "active working state",
    );
    await waitForObservableEvent(
      liveEvents,
      (event) => event.source.id === planningEvent.source.id && event.type === "mission.status" && eventStatus(event) === "completed",
      10_000,
      "completed canonical Mission",
    );
    unsubscribe();

    const snapshot = await chef.inspectState();
    assert.equal(snapshot.workspaceId, workspaceId);
    const mission = snapshot.missions.find((candidate) => candidate.id === acknowledgement.missionId);
    assert.ok(mission, "Thread acknowledgement Mission must persist in the selected workspace");
    assert.equal(mission.metadata.threadId, acknowledgement.threadId, "Mission must remain durably linked to its originating Thread");
    assert.equal(mission.status, "completed", "canonical Mission must complete successfully");
    assert.equal(mission.taskIds.length, 1, "simple todo acceptance task should execute as one worker task");
    const resultTaskIds = mission.taskIds;

    const completionMessage = await waitForThreadCompletionMessage(
      journey.baseUrl,
      acknowledgement.threadId,
      acknowledgement.missionId,
    );
    assert.match(completionMessage.content, /todo app/i, "Thread completion handoff must identify the requested result");
    assert.deepEqual(completionMessage.metadata?.taskIds, resultTaskIds, "Thread completion handoff must retain Mission task lineage");

    assert.equal(snapshot.tasks.length, 1, "golden path should persist its worker task");
    assert.ok(snapshot.tasks.every((task) => task.status === "completed"), "golden path tasks must complete");
    assert.equal(snapshot.plans.length, 1, "the executed plan must be persisted");
    assert.equal(snapshot.plans[0].goal, TODO_REQUEST, "persisted plan must retain the canonical user request");
    assert.equal(snapshot.plans[0].status, "completed", "the executed plan must complete durably");
    assert.deepEqual(snapshot.plans[0].taskIds, resultTaskIds, "plan must retain task lineage");
    assert.ok(snapshot.events.some((event) => event.type.startsWith("task.")), "task lifecycle events must be recorded");
    assertObservableMissionLifecycle(liveEvents, resultTaskIds);
    assertRoutingModeIsDurable(liveEvents);
    assertObservableMissionLifecycle(snapshot.events, resultTaskIds);
    assertRoutingModeIsDurable(snapshot.events);
    assert.equal(snapshot.artifacts.length, 1, "worker must produce one durable result artifact");
    assert.equal(snapshot.artifacts[0].name, "todo-app", "artifact must make the generated result discoverable");
    assert.ok(snapshot.artifacts[0].uri.includes(TODO_APP), "artifact URI must point at the generated app");
    const handoff = resultHandoff(snapshot.artifacts[0] as LivingArtifact, appPath);
    assert.ok(snapshot.sessions.some((session) => session.status === "completed"), "real PTY session must exit successfully");
    assert.ok(snapshot.sessions.every((session) => session.command.length > 0), "session command must be recorded");
    assert.ok(snapshot.sessions.every((session) => session.status !== "running"), "no session may remain stuck after completion");

    const generatedSource = await readFile(appPath, "utf8");
    assert.equal(generatedSource, TODO_APP_SOURCE, "todo app must be written inside the selected project");
    await assertGeneratedAppRuns(appPath);

    const messagesBeforeClose = chef.repository.listMessages(workspaceId);
    assert.ok(messagesBeforeClose.length > 0, "structured agent/message history must be persisted");

    await new Promise<void>((resolve) => journeyServer!.close(() => resolve()));
    journeyServer = null;
    await chef.close();

    const reopened = createChef({ dbPath, projectDir });
    await reopened.start();
    assert.equal(reopened.workspaceId, workspaceId, "reopen must recover the same selected workspace");

    const restored = await reopened.inspectState();
    assert.equal(restored.tasks.length, snapshot.tasks.length, "task history must survive reopen");
    assert.equal(restored.events.length, snapshot.events.length, "event history must survive reopen");
    assertObservableMissionLifecycle(restored.events, resultTaskIds);
    assertRoutingModeIsDurable(restored.events);
    const restoredMission = restored.missions.find((candidate) => candidate.id === acknowledgement.missionId);
    assert.equal(restoredMission?.metadata.threadId, acknowledgement.threadId, "Thread -> Mission lineage must survive reopen");
    assert.equal(restored.artifacts.length, snapshot.artifacts.length, "result location must survive reopen");
    assert.deepEqual(resultHandoff(restored.artifacts[0] as LivingArtifact, appPath), handoff, "result location, summary, run command, and verification handoff must survive reopen");
    assert.equal(restored.sessions.length, snapshot.sessions.length, "session history must survive reopen");
    assert.equal(restored.plans.length, snapshot.plans.length, "plan history must survive reopen");

    const messagesAfterReopen = reopened.repository.listMessages(workspaceId);
    assert.equal(messagesAfterReopen.length, messagesBeforeClose.length, "message history must survive reopen");
    assert.ok(messagesAfterReopen.some((message) => message.payload !== undefined), "reopened messages must retain payloads");

    await reopened.close();
  } finally {
    if (journeyServer) await new Promise<void>((resolve) => journeyServer!.close(() => resolve()));
    await rm(projectDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
