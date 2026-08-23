import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChef } from "../src/main.ts";

/**
 * P0 golden path: a user intent traverses the real runtime, scheduler, and
 * generic PTY harness, then survives a close/reopen cycle.
 */
async function main(): Promise<void> {
  const projectDir = await mkdtemp(join(tmpdir(), "chef-golden-project-"));
  const dbPath = join(projectDir, "chef.sqlite");

  try {
    // Core Mission execution is cancellation-driven by default. Tests that
    // require bounded completion must opt into their own deadline so a runtime
    // regression cannot hang CI indefinitely.
    const chef = createChef({ dbPath, projectDir, orchestratorTimeoutMs: 10_000 });
    await chef.start();

    assert.ok(chef.workspaceId, "start() must expose the seeded workspace id");
    const workspaceId = chef.workspaceId;
    const result = await chef.sendUserMessage("Investigate and fix this bug");

    assert.equal(result.workspaceId, workspaceId);
    assert.equal(result.ok, true, `orchestrator failed: ${result.report}`);
    assert.ok(result.taskIds.length > 0, "orchestrator must create at least one task");
    assert.ok(result.report.length > 0, "orchestrator must report the outcome");

    const snapshot = await chef.inspectState();
    assert.equal(snapshot.workspaceId, workspaceId);
    assert.ok(snapshot.tasks.length >= result.taskIds.length, "created tasks must be persisted");
    assert.ok(snapshot.tasks.every((task) => task.status === "completed"), "golden path tasks must complete");
    assert.equal(snapshot.plans.length, 1, "the executed plan must be persisted");
    assert.equal(snapshot.plans[0].status, "completed", "the executed plan must complete durably");
    assert.deepEqual(snapshot.plans[0].taskIds, result.taskIds, "plan must retain task lineage");
    assert.ok(snapshot.events.length > 0, "runtime transitions must be recorded as events");
    assert.ok(snapshot.events.some((event) => event.type.startsWith("task.")), "task lifecycle events must be recorded");
    assert.ok(snapshot.artifacts.length > 0, "worker must produce a durable artifact");
    assert.ok(snapshot.sessions.length > 0, "runtime must persist the PTY session");
    assert.ok(snapshot.sessions.some((session) => session.status === "completed"), "real PTY session must exit successfully");
    assert.ok(snapshot.sessions.every((session) => session.command.length > 0), "session command must be recorded");
    // Regression (handoff.md Bug 1): terminal exit events must reach the
    // scheduler even when a structured event already completed the task, or
    // sessions stay "running" and reopen recovery corrupts event counts.
    assert.ok(
      snapshot.sessions.every((session) => session.status !== "running"),
      "no session may remain stuck in running after plan completion",
    );

    const messagesBeforeClose = chef.repository.listMessages(workspaceId);
    assert.ok(messagesBeforeClose.length > 0, "structured agent/message history must be persisted");

    await chef.close();

    const reopened = createChef({ dbPath, projectDir });
    await reopened.start();
    assert.equal(reopened.workspaceId, workspaceId, "reopen must recover the same workspace");

    const restored = await reopened.inspectState();
    assert.equal(restored.tasks.length, snapshot.tasks.length, "task history must survive reopen");
    assert.equal(restored.events.length, snapshot.events.length, "event history must survive reopen");
    assert.equal(restored.artifacts.length, snapshot.artifacts.length, "artifact history must survive reopen");
    assert.equal(restored.sessions.length, snapshot.sessions.length, "session history must survive reopen");
    assert.equal(restored.plans.length, snapshot.plans.length, "plan history must survive reopen");

    const messagesAfterReopen = reopened.repository.listMessages(workspaceId);
    assert.equal(messagesAfterReopen.length, messagesBeforeClose.length, "message history must survive reopen");
    assert.ok(messagesAfterReopen.some((message) => message.payload !== undefined), "reopened messages must retain payloads");

    await reopened.close();
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
