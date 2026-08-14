import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChef } from "file:///C:/Users/LGSM228/chef/src/main.ts";

/**
 * P0 golden path: a user intent traverses the real runtime, scheduler, and
 * generic PTY harness, then survives a close/reopen cycle.
 */
async function main(): Promise<void> {
  const projectDir = await mkdtemp(join(tmpdir(), "chef-golden-project-"));
  const dbPath = join(projectDir, "chef.sqlite");

  try {
    const chef = createChef({ dbPath, projectDir });
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
    assert.ok(snapshot.events.length > 0, "runtime transitions must be recorded as events");
    assert.ok(snapshot.events.some((event) => event.type.startsWith("task.")), "task lifecycle events must be recorded");
    assert.ok(snapshot.artifacts.length > 0, "worker must produce a durable artifact");
    assert.ok(snapshot.sessions.length > 0, "runtime must persist the PTY session");
    assert.ok(snapshot.sessions.some((session) => session.status === "completed"), "real PTY session must exit successfully");
    assert.ok(snapshot.sessions.every((session) => session.command.length > 0), "session command must be recorded");

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

    const messagesAfterReopen = reopened.repository.listMessages(workspaceId);
    assert.equal(messagesAfterReopen.length, messagesBeforeClose.length, "message history must survive reopen");
    assert.ok(messagesAfterReopen.some((message) => message.payload !== undefined), "reopened messages must retain payloads");

    await reopened.close();
  } finally {
    await new Promise(r => setTimeout(r, 300)); await rm(projectDir, { recursive: true, force: true }); console.error("RM-OK-AFTER-300MS");
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
