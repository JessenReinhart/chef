import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { createThreadServer } from "../src/server/thread-http.ts";

const WORKER_STARTUP_BUDGET_MS = 1_500;
const POLL_MS = 20;

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

const dir = await mkdtemp(join(tmpdir(), "chef-thread-worker-startup-"));
const chef = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir });
await chef.start();
const server = createThreadServer(chef, createHttpServer(chef));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("worker-startup HTTP server did not bind");
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const createThreadResponse = await fetch(`${baseUrl}/api/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Worker startup acceptance" }),
  });
  assert.equal(createThreadResponse.status, 201);
  const created = await createThreadResponse.json() as { data?: { id?: string } };
  const threadId = created.data?.id;
  assert.ok(threadId);

  const request = fetch(`${baseUrl}/api/threads/${encodeURIComponent(threadId)}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Investigate the selected project" }),
  });

  await waitForWorkerStartup(async () => {
    const snapshot = await chef.inspectState();
    return { tasks: snapshot.tasks, sessions: snapshot.sessions };
  });

  const response = await request;
  assert.equal(response.status, 200);
  const body = await response.json() as { ok?: boolean; data?: { ok?: boolean; missionId?: string; taskIds?: string[] } };
  assert.equal(body.ok, true);
  assert.equal(body.data?.ok, true);
  const missionId = body.data?.missionId;
  assert.ok(missionId, "completed Thread request must expose its Mission lineage");
  assert.ok((body.data?.taskIds?.length ?? 0) > 0, "completed Thread request must retain worker Task lineage");

  const finalSnapshot = await chef.inspectState();
  assert.ok(finalSnapshot.sessions.length > 0, "Thread request must persist its real worker Session");
  assert.ok(finalSnapshot.sessions.every((session) => session.command.length > 0), "worker Session command must be observable");

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
  assert.ok(planningStarted.seq < planningSucceeded.seq, "planning-start evidence must precede the accepted plan");

  const firstTaskId = body.data?.taskIds?.[0];
  const taskCreated = firstTaskId
    ? finalSnapshot.events.find((event) => event.type === "orchestrator.task.created" && event.taskId === firstTaskId)
    : undefined;
  assert.ok(taskCreated, "worker startup must retain durable Task creation evidence");
  assert.ok(planningSucceeded.seq < taskCreated.seq, "accepted plan evidence must precede real worker Task creation");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await chef.close();
  await rm(dir, { recursive: true, force: true });
}

console.log("thread-worker-startup: ok — Thread chat durably shows planning before reaching a real worker Session within its startup budget");
