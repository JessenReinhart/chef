import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ThreadMessageContext } from "../src/core/types.ts";
import { Repository } from "../src/persistence/database.ts";
import { createThreadRepository } from "../src/persistence/threads.ts";
import { createThreadServer } from "../src/server/thread-http.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-thread-reopen-followup-"));
const dbPath = join(dir, "chef.sqlite");
const workspaceId = "workspace-a";

type SubmissionContext = {
  message: string;
  threadId?: string;
  recentMessages?: ThreadMessageContext[];
};

function createRuntime(repository: Repository, submissions: SubmissionContext[]) {
  return {
    workspaceId,
    repository,
    sendUserMessage(message: string, context?: { threadId?: string; recentMessages?: ThreadMessageContext[] }) {
      submissions.push({ message, threadId: context?.threadId, recentMessages: context?.recentMessages });
      repository.insertMission({ workspaceId, goal: message, status: "planning", createdBy: "user" });
      return Promise.resolve({ workspaceId, taskIds: [] as string[], report: `Completed: ${message}`, ok: true });
    },
  } as never;
}

async function startThreadServer(
  repository: Repository,
  submissions: SubmissionContext[],
): Promise<{ server: ReturnType<typeof createThreadServer>; origin: string }> {
  const base = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ fallback: req.url }));
  });
  const server = createThreadServer(createRuntime(repository, submissions), base);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: ReturnType<typeof createThreadServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function send(origin: string, threadId: string, message: string): Promise<{ missionId: string; threadId: string }> {
  const response = await fetch(`${origin}/api/threads/${encodeURIComponent(threadId)}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  assert.equal(response.status, 202, "Thread follow-up must acknowledge once its Mission is durable");
  const body = await response.json() as {
    data: { accepted?: boolean; missionId?: string; threadId: string; report?: string };
  };
  assert.equal(body.data.accepted, true);
  assert.equal(body.data.threadId, threadId, "acknowledgement must preserve the restored Thread identity");
  assert.equal(body.data.report, "", "acknowledgement must not pretend background work is already complete");
  assert.ok(body.data.missionId, "acknowledgement must expose the new durable Mission");
  return { missionId: body.data.missionId, threadId: body.data.threadId };
}

async function waitForCompletion(origin: string, threadId: string, missionId: string): Promise<Array<{ role: string; content: string; metadata?: Record<string, unknown> }>> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/threads/${encodeURIComponent(threadId)}/messages`);
    assert.equal(response.status, 200, "restored Thread history must remain readable while follow-up work settles");
    const body = await response.json() as {
      data: Array<{ role: string; content: string; metadata?: Record<string, unknown> }>;
    };
    if (body.data.some((message) => message.role === "assistant" && message.metadata?.missionId === missionId)) {
      return body.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for reopened Thread Mission ${missionId}`);
}

let firstRepository: Repository | null = null;
let reopenedRepository: Repository | null = null;
let firstServer: ReturnType<typeof createThreadServer> | null = null;
let reopenedServer: ReturnType<typeof createThreadServer> | null = null;

try {
  firstRepository = new Repository(dbPath);
  firstRepository.createWorkspace({ id: workspaceId, name: "Workspace A" });
  const thread = createThreadRepository(firstRepository).create({ workspaceId, title: "Todo follow-up" });
  const firstSubmissions: SubmissionContext[] = [];
  const firstRuntime = await startThreadServer(firstRepository, firstSubmissions);
  firstServer = firstRuntime.server;

  const first = await send(firstRuntime.origin, thread.id, "Create a simple todo app");
  const firstHistory = await waitForCompletion(firstRuntime.origin, thread.id, first.missionId);
  assert.ok(firstHistory.some((message) => message.content === "Completed: Create a simple todo app"));
  assert.equal(firstRepository.getMission(first.missionId)?.metadata.threadId, thread.id);
  assert.equal(firstSubmissions.length, 1);
  assert.equal(firstSubmissions[0]?.threadId, thread.id, "the initial turn must be explicitly scoped to its Thread");

  await closeServer(firstServer);
  firstServer = null;
  firstRepository.close();
  firstRepository = null;

  reopenedRepository = new Repository(dbPath);
  const reopenedSubmissions: SubmissionContext[] = [];
  const reopenedRuntime = await startThreadServer(reopenedRepository, reopenedSubmissions);
  reopenedServer = reopenedRuntime.server;

  const restoredThreadResponse = await fetch(`${reopenedRuntime.origin}/api/threads/${encodeURIComponent(thread.id)}`);
  assert.equal(restoredThreadResponse.status, 200, "the same Thread must still exist after persistence is reopened");

  const followUp = await send(reopenedRuntime.origin, thread.id, "Add persistence to the todo app");
  assert.notEqual(followUp.missionId, first.missionId, "a reopened Thread follow-up must create a distinct Mission");
  const followUpMission = reopenedRepository.getMission(followUp.missionId);
  assert.ok(followUpMission, "the reopened follow-up Mission must be durable");
  assert.equal(followUpMission.metadata.threadId, thread.id, "the new Mission must remain linked to the same restored Thread");

  assert.equal(reopenedSubmissions.length, 1, "the reopened follow-up must dispatch exactly once");
  const reopenedSubmission = reopenedSubmissions[0];
  assert.equal(reopenedSubmission?.threadId, thread.id, "the reopened runtime must receive the restored Thread identity");
  assert.deepEqual(
    reopenedSubmission?.recentMessages?.map(({ role, content }) => [role, content]),
    [
      ["system", "Prior Mission (planning; context only): Create a simple todo app"],
      ["user", "Create a simple todo app"],
      ["assistant", "Completed: Create a simple todo app"],
    ],
    "the reopened follow-up must receive durable prior Mission and conversation context before new work starts",
  );

  const history = await waitForCompletion(reopenedRuntime.origin, thread.id, followUp.missionId);
  assert.deepEqual(
    history.map((message) => [message.role, message.content]),
    [
      ["user", "Create a simple todo app"],
      ["assistant", "Completed: Create a simple todo app"],
      ["user", "Add persistence to the todo app"],
      ["assistant", "Completed: Add persistence to the todo app"],
    ],
    "reopening Chef must not split follow-up work away from the existing Thread conversation",
  );
  assert.equal(
    history.at(-1)?.metadata?.missionId,
    followUp.missionId,
    "the reopened completion handoff must retain the new Mission lineage in the same Thread",
  );

  console.log("thread-reopen-followup: ok — a persisted Thread restores prior context, accepts a distinct follow-up Mission through production HTTP, and retains both turns in one conversation");
} finally {
  if (firstServer) await closeServer(firstServer);
  if (reopenedServer) await closeServer(reopenedServer);
  firstRepository?.close();
  reopenedRepository?.close();
  await rm(dir, { recursive: true, force: true });
}
