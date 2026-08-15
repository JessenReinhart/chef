import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Repository } from "../src/persistence/database.ts";
import { Scheduler, type HarnessLike, type HarnessRegistry } from "../src/runtime/scheduler.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-dispatch-concurrency-"));
const repository = new Repository(join(dir, "chef.db"));

class DummyHarness implements HarnessLike {
  readonly id = "dummy-harness";
  readonly command = "dummy";
  readonly args: string[] = [];
  readonly cwd = dir;

  async spawn(options: { sessionId?: string }): Promise<{ id: string; pid: number }> {
    return { id: options.sessionId ?? "missing-session", pid: 1 };
  }
  async writeContextRefs(): Promise<string> { return ""; }
  events(): AsyncIterable<{ type: "data"; data: string }> {
    return { async *[Symbol.asyncIterator]() {} };
  }
  async terminate(): Promise<void> {}
  async forget(): Promise<void> {}
  async close(): Promise<void> {}
}

class DummyRegistry implements HarnessRegistry {
  readonly #harness = new DummyHarness();
  get(): HarnessLike { return this.#harness; }
  set(): void {}
  values(): Iterable<HarnessLike> { return [this.#harness]; }
}

try {
  const workspace = repository.createWorkspace({ name: "dispatch-test", rootPath: dir });
  for (let index = 0; index < 4; index++) {
    repository.insertTask({
      workspaceId: workspace.id,
      title: `task-${index}`,
      description: "dispatch race regression",
      status: "pending",
      assignedTo: "agent-1",
    });
  }

  const scheduler = new Scheduler(repository, new DummyRegistry(), { maxConcurrency: 2 });
  await Promise.all([
    scheduler.dispatchPending(workspace.id),
    scheduler.dispatchPending(workspace.id),
  ]);

  const liveSessions = repository.countLiveSessions(workspace.id);
  assert.ok(liveSessions <= 2, `concurrent dispatch oversubscribed: ${liveSessions} live sessions`);
  assert.equal(repository.listSessions(workspace.id).length, 2, "only capacity-sized sessions should be inserted");
  console.log("dispatch-concurrency: ok — concurrent dispatch respects maxConcurrency");
} finally {
  repository.close();
  await rm(dir, { recursive: true, force: true });
}
