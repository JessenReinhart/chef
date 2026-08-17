import { strict as assert } from "node:assert";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Repository } from "../src/persistence/database.ts";
import { Scheduler, type HarnessLike, type HarnessRegistry } from "../src/runtime/scheduler.ts";
import { GenericTerminalHarness, type GenericHarnessConfig } from "../src/harness/generic.ts";
import { type ContextReference } from "../src/harness/sideband.ts";

const testRoot = await mkdtemp(join(tmpdir(), "chef-inbox-context-"));
const dbPath = join(testRoot, "chef.db");
const sidebandRoot = join(testRoot, "sideband");

const repository = new Repository(dbPath);

const harnessConfig: GenericHarnessConfig = {
  agentId: "agent-1",
  workspaceId: "", // will set after workspace created
  command: "echo",
  args: ["hello"],
  cwd: testRoot,
};

class TestHarnessRegistry implements HarnessRegistry {
  readonly #harness: GenericTerminalHarness;
  constructor(harness: GenericTerminalHarness) {
    this.#harness = harness;
  }
  get(agentId: string): HarnessLike | undefined {
    return agentId === "agent-1" ? this.#harness : undefined;
  }
  set(agentId: string, harness: HarnessLike): void {}
  values(): Iterable<HarnessLike> {
    return [this.#harness];
  }
}

let harness: GenericTerminalHarness;

try {
  const workspace = repository.createWorkspace({ name: "inbox-context-test", rootPath: testRoot });
  harnessConfig.workspaceId = workspace.id;

  harness = new GenericTerminalHarness(harnessConfig, { sidebandRoot });
  const registry = new TestHarnessRegistry(harness);

  const contextRefs: ContextReference[] = [
    { type: "artifact", id: "test-artifact-id", relevance: 1 },
    { type: "task", id: "source-task", relevance: 1 },
  ];

  repository.insertTask({
    workspaceId: workspace.id,
    title: "target-task",
    description: "dispatch with contextRefs",
    status: "pending",
    assignedTo: "agent-1",
    contextRefs,
  });

  const scheduler = new Scheduler(repository, registry, { maxConcurrency: 1 });
  await scheduler.dispatchPending(workspace.id);

  const sessions = repository.listSessions(workspace.id);
  assert.equal(sessions.length, 1, "one session should be created");
  const session = sessions[0];

  const inboxDir = join(sidebandRoot, session.id, "inbox");
  const files = await readdir(inboxDir);
  assert.ok(files.length > 0, "inbox should contain at least one envelope");

  const envelopePath = join(inboxDir, files[0]);
  const raw = await readFile(envelopePath, "utf8");
  const envelope = JSON.parse(raw);

  assert.equal(envelope.version, 1, "envelope version");
  assert.equal(envelope.kind, "context", "envelope kind");
  assert.equal(envelope.from, "runtime", "envelope from");
  assert.deepEqual(envelope.contextRefs, contextRefs, "contextRefs match task's contextRefs");
  assert.ok(envelope.id, "envelope has id");
  assert.ok(envelope.timestamp > 0, "envelope has timestamp");

  console.log("inbox-context-delivery: ok — envelope.contextRefs matches task.contextRefs at dispatch");
} finally {
  await harness.close();
  repository.close();
  await rm(testRoot, { recursive: true, force: true });
}