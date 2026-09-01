import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ThreadMessageContext } from "../src/core/types.ts";
import { createChatRepository } from "../src/persistence/chat.ts";
import { Repository } from "../src/persistence/database.ts";
import { createThreadRepository } from "../src/persistence/threads.ts";
import { createThreadServer } from "../src/server/thread-http.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-thread-http-"));
const repository = new Repository(join(dir, "chef.sqlite"));
repository.createWorkspace({ id: "workspace-a", name: "Workspace A" });
repository.createWorkspace({ id: "workspace-b", name: "Workspace B" });
const threads = createThreadRepository(repository);
const chat = createChatRepository(repository);
const foreignThread = threads.create({ workspaceId: "workspace-b", title: "Private work" });
const planningCalls: Array<{
  message: string;
  context?: { threadId?: string; recentMessages?: ThreadMessageContext[] };
}> = [];

let releaseHeldWork!: () => void;
const heldWork = new Promise<{ workspaceId: string; taskIds: string[]; report: string; ok: boolean }>((resolve) => {
  releaseHeldWork = () => resolve({ workspaceId: "workspace-a", taskIds: [], report: "Completed: Hold until released", ok: true });
});

const runtime = {
  workspaceId: "workspace-a",
  repository,
  sendUserMessage(message: string, context?: { threadId?: string; recentMessages?: ThreadMessageContext[] }) {
    planningCalls.push({ message, context });
    if (message === "Complete after async startup") {
      return Promise.resolve().then(() => {
        repository.insertMission({ workspaceId: "workspace-a", goal: message, status: "planning", createdBy: "user" });
        return { workspaceId: "workspace-a", taskIds: [] as string[], report: `Completed: ${message}`, ok: true };
      });
    }
    if (message === "Fail after async startup") {
      return Promise.resolve().then(() => {
        repository.insertMission({ workspaceId: "workspace-a", goal: message, status: "planning", createdBy: "user" });
        throw new Error("async startup failed");
      });
    }
    if (message === "Fail before mission creation") throw new Error("provider unavailable");
    repository.insertMission({ workspaceId: "workspace-a", goal: message, status: "planning", createdBy: "user" });
    if (message === "Fail during startup") throw new Error("startup failed");
    if (message === "Hold until released") return heldWork;
    return Promise.resolve({ workspaceId: "workspace-a", taskIds: [] as string[], report: `Completed: ${message}`, ok: true });
  },
} as never;

const baseServer = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ fallback: req.url }));
});
const server = createThreadServer(runtime, baseServer);

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;

async function waitForMessage(threadId: string, predicate: (message: { role: string; content: string; metadata?: Record<string, unknown> }) => boolean) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const messages = chat.list("workspace-a", threadId);
    const match = messages.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for Thread message in ${threadId}`);
}

try {
  const createdResponse = await fetch(`${origin}/api/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "  Authentication  " }),
  });
  assert.equal(createdResponse.status, 201);
  const createdBody = await createdResponse.json() as { data: { id: string; workspaceId: string; title: string; status: string } };
  assert.equal(createdBody.data.workspaceId, "workspace-a");
  assert.equal(createdBody.data.title, "Authentication");
  assert.equal(createdBody.data.status, "active");

  const secondThread = threads.create({ workspaceId: "workspace-a", title: "Dashboard" });
  chat.insert({ workspaceId: "workspace-a", threadId: createdBody.data.id, role: "user", content: "Keep email login" });
  chat.insert({ workspaceId: "workspace-a", threadId: createdBody.data.id, role: "assistant", content: "I will keep it." });
  chat.insert({ workspaceId: "workspace-a", threadId: secondThread.id, role: "user", content: "Redesign dashboard" });
  chat.insert({ workspaceId: "workspace-b", threadId: foreignThread.id, role: "user", content: "Private sibling workspace message" });

  const historyResponse = await fetch(`${origin}/api/threads/${createdBody.data.id}/messages`);
  assert.equal(historyResponse.status, 200);
  const historyBody = await historyResponse.json() as { data: Array<{ threadId?: string; content: string }> };
  assert.deepEqual(historyBody.data.map((message) => message.content), ["Keep email login", "I will keep it."]);

  const sendResponse = await fetch(`${origin}/api/threads/${secondThread.id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "  Keep the filters from before  " }),
  });
  assert.equal(sendResponse.status, 202, "selected-Thread work should acknowledge once its Mission is durable");
  const sendBody = await sendResponse.json() as { data: { accepted: boolean; threadId: string; missionId?: string; report: string; ok: boolean } };
  assert.equal(sendBody.data.accepted, true);
  assert.equal(sendBody.data.threadId, secondThread.id);
  assert.equal(sendBody.data.report, "", "acknowledgement must not pretend background work already produced its final report");
  assert.equal(sendBody.data.ok, true);
  assert.ok(sendBody.data.missionId, "Thread acknowledgement should expose its originating Mission");
  assert.equal(repository.getMission(sendBody.data.missionId!)?.metadata.threadId, secondThread.id);

  const followUpPlanningCall = planningCalls.at(-1);
  assert.equal(followUpPlanningCall?.message, "Keep the filters from before");
  assert.equal(followUpPlanningCall?.context?.threadId, secondThread.id);
  assert.deepEqual(
    followUpPlanningCall?.context?.recentMessages?.map((message) => message.content),
    ["Redesign dashboard"],
    "planning must receive only same-Thread history that existed before the current turn",
  );
  assert.ok(!followUpPlanningCall?.context?.recentMessages?.some((message) => message.content === "Keep the filters from before"));
  assert.ok(!followUpPlanningCall?.context?.recentMessages?.some((message) => message.content === "Keep email login"));

  const completedReply = await waitForMessage(secondThread.id, (message) => message.role === "assistant" && message.content === "Completed: Keep the filters from before");
  assert.equal(completedReply.metadata?.missionId, sendBody.data.missionId, "background completion must preserve Mission lineage in the Thread");
  assert.equal(chat.count("workspace-a"), 0, "Thread-scoped sends must not leak into legacy workspace-global chat history");

  const heldThread = threads.create({ workspaceId: "workspace-a", title: "Held work" });
  const heldResponse = await fetch(`${origin}/api/threads/${heldThread.id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Hold until released" }),
  });
  assert.equal(heldResponse.status, 202, "HTTP acknowledgement must not wait for Mission completion");
  const heldBody = await heldResponse.json() as { data: { missionId?: string; threadId: string; accepted: boolean } };
  assert.equal(heldBody.data.accepted, true);
  assert.ok(heldBody.data.missionId);
  assert.equal(repository.getMission(heldBody.data.missionId!)?.metadata.threadId, heldThread.id);
  assert.equal(
    chat.list("workspace-a", heldThread.id).filter((message) => message.role === "assistant").length,
    0,
    "final assistant output must not exist before held background execution completes",
  );
  releaseHeldWork();
  const heldReply = await waitForMessage(heldThread.id, (message) => message.role === "assistant");
  assert.equal(heldReply.content, "Completed: Hold until released");
  assert.equal(heldReply.metadata?.missionId, heldBody.data.missionId);

  const boundedThread = threads.create({ workspaceId: "workspace-a", title: "Long context" });
  for (let index = 0; index < 10; index += 1) {
    chat.insert({
      workspaceId: "workspace-a",
      threadId: boundedThread.id,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `context-${index}`,
      timestamp: 1_000 + index,
    });
  }
  const boundedSendResponse = await fetch(`${origin}/api/threads/${boundedThread.id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Use the latest context" }),
  });
  assert.equal(boundedSendResponse.status, 202);
  const boundedPlanningCall = planningCalls.at(-1);
  assert.equal(boundedPlanningCall?.context?.threadId, boundedThread.id);
  assert.deepEqual(
    boundedPlanningCall?.context?.recentMessages?.map((message) => message.content),
    ["context-2", "context-3", "context-4", "context-5", "context-6", "context-7", "context-8", "context-9"],
  );

  const asyncSuccessThread = threads.create({ workspaceId: "workspace-a", title: "Async success" });
  const asyncSuccessResponse = await fetch(`${origin}/api/threads/${asyncSuccessThread.id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Complete after async startup" }),
  });
  assert.equal(asyncSuccessResponse.status, 202, "a Mission created on the first async turn should still acknowledge without waiting for completion");
  const asyncSuccessBody = await asyncSuccessResponse.json() as { data: { missionId?: string; threadId: string } };
  assert.ok(asyncSuccessBody.data.missionId);
  assert.equal(repository.getMission(asyncSuccessBody.data.missionId!)?.metadata.threadId, asyncSuccessThread.id);
  await waitForMessage(asyncSuccessThread.id, (message) => message.role === "assistant" && message.content === "Completed: Complete after async startup");

  const failingThread = threads.create({ workspaceId: "workspace-a", title: "Startup failure" });
  const failingResponse = await fetch(`${origin}/api/threads/${failingThread.id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Fail during startup" }),
  });
  assert.equal(failingResponse.status, 500, "synchronous Mission startup failures must still surface as request failures");
  assert.deepEqual(await failingResponse.json(), { error: "startup failed" });
  const failedMission = repository.listMissions("workspace-a").find((mission) => mission.goal === "Fail during startup");
  assert.ok(failedMission);
  assert.equal(failedMission.metadata.threadId, failingThread.id);
  const startupFailureReply = chat.list("workspace-a", failingThread.id).find((message) => message.role === "assistant");
  assert.ok(startupFailureReply, "a synchronous startup failure must remain visible after the request and page lifecycle end");
  assert.equal(startupFailureReply.content, "Chef could not start that work: startup failed");
  assert.equal(startupFailureReply.metadata?.ok, false);
  assert.equal(startupFailureReply.metadata?.missionId, failedMission.id, "startup failure feedback must preserve Mission lineage when startup created one");

  const preMissionFailureThread = threads.create({ workspaceId: "workspace-a", title: "Pre-Mission failure" });
  const preMissionFailureResponse = await fetch(`${origin}/api/threads/${preMissionFailureThread.id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Fail before mission creation" }),
  });
  assert.equal(preMissionFailureResponse.status, 500, "pre-Mission startup failure must remain a submit failure");
  assert.deepEqual(await preMissionFailureResponse.json(), { error: "provider unavailable" });
  assert.equal(
    repository.listMissions("workspace-a").some((mission) => mission.goal === "Fail before mission creation"),
    false,
    "the failure test must prove feedback does not depend on a Mission being created",
  );
  const preMissionFailureReply = chat.list("workspace-a", preMissionFailureThread.id).find((message) => message.role === "assistant");
  assert.ok(preMissionFailureReply, "Chef must leave durable Thread feedback even when startup fails before Mission creation");
  assert.equal(preMissionFailureReply.content, "Chef could not start that work: provider unavailable");
  assert.equal(preMissionFailureReply.metadata?.ok, false);
  assert.equal(preMissionFailureReply.metadata?.missionId, undefined, "Chef must not invent Mission lineage for a pre-Mission failure");

  const asyncFailingThread = threads.create({ workspaceId: "workspace-a", title: "Async failure" });
  const asyncFailingResponse = await fetch(`${origin}/api/threads/${asyncFailingThread.id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Fail after async startup" }),
  });
  assert.equal(asyncFailingResponse.status, 202, "once a Mission is durable, later execution failure belongs to background Mission state, not the submit transport");
  const asyncFailingBody = await asyncFailingResponse.json() as { data: { missionId?: string } };
  assert.ok(asyncFailingBody.data.missionId);
  assert.equal(repository.getMission(asyncFailingBody.data.missionId!)?.metadata.threadId, asyncFailingThread.id);
  const failureReply = await waitForMessage(asyncFailingThread.id, (message) => message.role === "assistant" && message.metadata?.ok === false);
  assert.match(failureReply.content, /async startup failed/);
  assert.equal(failureReply.metadata?.missionId, asyncFailingBody.data.missionId);

  const renameResponse = await fetch(`${origin}/api/threads/${createdBody.data.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Auth follow-ups", summary: "Sign-in is done." }),
  });
  assert.equal(renameResponse.status, 200);
  const renameBody = await renameResponse.json() as { data: { title: string; summary?: string } };
  assert.equal(renameBody.data.title, "Auth follow-ups");
  assert.equal(renameBody.data.summary, "Sign-in is done.");

  const archiveResponse = await fetch(`${origin}/api/threads/${createdBody.data.id}/archive`, { method: "POST" });
  assert.equal(archiveResponse.status, 200);
  assert.equal((await fetch(`${origin}/api/threads/${createdBody.data.id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Do not continue archived work" }),
  })).status, 409);

  assert.equal((await fetch(`${origin}/api/threads/${foreignThread.id}`)).status, 404);
  assert.equal((await fetch(`${origin}/api/threads/${foreignThread.id}/messages`)).status, 404);
  assert.equal((await fetch(`${origin}/api/threads/${foreignThread.id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "steal context" }),
  })).status, 404);
  assert.equal((await fetch(`${origin}/api/threads/${foreignThread.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "stolen" }),
  })).status, 404);
  assert.equal((await fetch(`${origin}/api/threads/${foreignThread.id}/archive`, { method: "POST" })).status, 404);

  assert.equal((await fetch(`${origin}/api/threads/${secondThread.id}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "   " }),
  })).status, 400);
  assert.equal((await fetch(`${origin}/api/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
  })).status, 400);
  assert.equal((await fetch(`${origin}/api/threads/%E0%A4%A`)).status, 400);
  assert.equal((await fetch(`${origin}/api/threads/%E0%A4%A/messages`)).status, 400);
  assert.equal((await fetch(`${origin}/api/threads/%E0%A4%A/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  })).status, 400);

  const fallback = await fetch(`${origin}/api/state`);
  assert.equal(fallback.status, 200);
  assert.deepEqual(await fallback.json(), { fallback: "/api/state" });
  console.log("thread-http: ok — Thread chat acknowledges durable Missions immediately, persists completion and startup failure feedback, and preserves workspace/context isolation");
} finally {
  releaseHeldWork();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  repository.close();
  await rm(dir, { recursive: true, force: true });
}