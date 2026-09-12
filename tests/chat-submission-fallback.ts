import { strict as assert } from "node:assert";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecisionProvider } from "../src/core/types.ts";
import { createChef } from "../src/main.ts";
import { createThreadServer } from "../src/server/thread-http.ts";
import {
  assistantContentSeenSinceLastUser,
  chatSubmissionFallback,
} from "../web/src/chatSubmissionFallback.ts";

assert.deepEqual(
  chatSubmissionFallback({ ok: true, report: "Mission accepted.", accepted: true }),
  { content: "Mission accepted.", isError: false },
  "a successful POST report must remain a visible fallback when chat SSE is missed",
);

assert.deepEqual(
  chatSubmissionFallback({ ok: true, report: "", accepted: true }),
  { content: "Got it. I’m starting this now.", isError: false },
  "an accepted Mission with no report must still acknowledge that Chef started",
);

assert.deepEqual(
  chatSubmissionFallback({ ok: false, report: "Provider unavailable" }),
  { content: "Provider unavailable", isError: true },
  "a rejected submission must remain visibly marked as an error",
);

assert.deepEqual(
  chatSubmissionFallback({ ok: false, report: "" }),
  { content: "I couldn't start that work yet. Please try again.", isError: true },
  "an empty failed response must still provide a concrete retryable failure",
);

assert.equal(
  chatSubmissionFallback({ ok: true, report: "", accepted: false }),
  null,
  "a successful response without report or acceptance evidence must not invent progress",
);

const currentTurn = [
  { role: "user", content: "Create a simple todo app" },
  { role: "assistant", content: "Got it. I’m starting this now." },
  { role: "assistant", content: "Mission started with 1 planned step." },
];
assert.equal(
  assistantContentSeenSinceLastUser(currentTurn, "Got it. I’m starting this now."),
  true,
  "a matching SSE acknowledgement must be recognized even when another progress message followed the POST fallback",
);
assert.equal(
  assistantContentSeenSinceLastUser(
    [
      { role: "assistant", content: "Got it. I’m starting this now." },
      { role: "user", content: "Create a simple todo app" },
    ],
    "Got it. I’m starting this now.",
  ),
  false,
  "an acknowledgement from an older turn must not suppress the current submission fallback",
);

async function assertCanonicalThreadSubmissionAcknowledgesBeforePlanningFinishes(): Promise<void> {
  const projectDir = await mkdtemp(join(tmpdir(), "chef-canonical-ack-"));
  let releasePlanner!: () => void;
  const plannerGate = new Promise<void>((resolve) => { releasePlanner = resolve; });
  const heldPlanner: DecisionProvider = {
    name: "canonical-ack-held-planner",
    async proposePlan() {
      await plannerGate;
      return null;
    },
    async evaluate(input) {
      return {
        id: crypto.randomUUID(),
        workspaceId: "canonical-ack-workspace",
        type: "task.evaluation",
        summary: `unused evaluation for ${input.taskId}`,
        payload: input,
        madeBy: "canonical-ack-held-planner",
        timestamp: Date.now(),
        status: "accepted",
      };
    },
  };

  const chef = createChef({
    dbPath: join(projectDir, "chef.sqlite"),
    projectDir,
    decisionProvider: heldPlanner,
  });
  await chef.start();

  const base = createHttpServer((_req, res) => {
    res.writeHead(404);
    res.end("not found");
  });
  const server = createThreadServer(chef, base);

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object", "canonical acknowledgement server must listen on TCP");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const threadResponse = await fetch(`${baseUrl}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Canonical todo acknowledgement" }),
    });
    assert.equal(threadResponse.status, 201, "canonical acknowledgement check must use a real durable Thread");
    const threadBody = await threadResponse.json() as { data?: { id?: string } };
    assert.ok(threadBody.data?.id, "canonical acknowledgement Thread must expose its durable id");

    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}/api/threads/${encodeURIComponent(threadBody.data.id)}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Create a simple todo app" }),
      signal: AbortSignal.timeout(5_000),
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(response.status, 202, "canonical todo submission must acknowledge accepted work before planning finishes");
    const body = await response.json() as {
      ok?: boolean;
      data?: {
        ok?: boolean;
        report?: string;
        accepted?: boolean;
        missionId?: string;
        threadId?: string;
      };
    };
    assert.equal(body.ok, true, "canonical Thread submission response must be successful");
    assert.equal(body.data?.accepted, true, "canonical Thread submission must explicitly report accepted work");
    assert.ok(body.data?.missionId, "canonical acknowledgement must retain durable Mission identity");
    assert.equal(body.data?.threadId, threadBody.data.id, "canonical acknowledgement must retain its originating Thread identity");

    const userFacingAcknowledgement = chatSubmissionFallback({
      ok: body.data?.ok === true,
      report: body.data?.report ?? "",
      accepted: body.data?.accepted,
    });
    assert.deepEqual(
      userFacingAcknowledgement,
      { content: "Got it. I’m starting this now.", isError: false },
      "the real canonical Thread 202 response must project to an immediate human-readable Simple Mode acknowledgement",
    );

    const mission = chef.repository.getMission(body.data.missionId!);
    assert.equal(
      mission?.status,
      "planning",
      "the acknowledgement must be observable while the canonical Mission is still planning, not only after work finishes",
    );
    assert.ok(elapsedMs < 1_000, `canonical Simple Mode acknowledgement exceeded its 1s test budget (${elapsedMs}ms)`);
  } finally {
    releasePlanner();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await chef.close();
    await rm(projectDir, { recursive: true, force: true });
  }
}

await assertCanonicalThreadSubmissionAcknowledgesBeforePlanningFinishes();

console.log("chat submission fallback behavior passed, including the real canonical Thread acknowledgement");
