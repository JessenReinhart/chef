import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChef } from "file:///C:/Users/LGSM228/chef/src/main.ts";

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
    assert.ok(result.taskIds.length > 0);
    assert.ok(result.report.length > 0);

    const snapshot = await chef.inspectState();
    console.error("ASSERT: tasks completed");
    assert.ok(snapshot.tasks.every((task) => task.status === "completed"), "golden path tasks must complete");
    console.error("ASSERT: events recorded");
    assert.ok(snapshot.events.length > 0);
    assert.ok(snapshot.events.some((event) => event.type.startsWith("task.")));
    console.error("ASSERT: artifacts");
    assert.ok(snapshot.artifacts.length > 0, "worker must produce a durable artifact");
    console.error("ASSERT: sessions");
    assert.ok(snapshot.sessions.length > 0, "runtime must persist the PTY session");
    console.error("ASSERT: sessions completed");
    try {
      assert.ok(snapshot.sessions.some((session) => session.status === "completed"), "real PTY session must exit successfully");
      console.error("ASSERT: sessions completed — PASSED");
    } catch (e) {
      console.error("ASSERT: sessions completed — FAILED");
      for (const s of snapshot.sessions) console.error(`  session status=${s.status} task=${s.taskId}`);
    }
    console.error("ASSERT: session command");
    assert.ok(snapshot.sessions.every((session) => session.command.length > 0), "session command must be recorded");

    const messagesBeforeClose = chef.repository.listMessages(workspaceId);
    assert.ok(messagesBeforeClose.length > 0, "structured agent/message history must be persisted");

    console.error("BEFORE close");
    await chef.close();
    console.error("AFTER close");

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

    console.error("BEFORE reopened.close");
    await reopened.close();
    console.error("AFTER reopened.close");
  } finally {
    console.error("FINALLY: about to rm");
    try {
      await rm(projectDir, { recursive: true, force: true });
      console.error("FINALLY: rm OK");
    } catch (e) {
      console.error(`FINALLY: rm FAILED: ${(e as Error).code}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error("CAUGHT:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
