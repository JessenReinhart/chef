import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChef } from "../src/main.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-plan-persistence-"));
const dbPath = join(dir, "chef.sqlite");
const chef = createChef({ dbPath, projectDir: dir });

try {
  await chef.start();
  const result = await chef.sendUserMessage("Persist this plan durably");
  assert.equal(result.ok, true, `orchestrator failed: ${result.report}`);

  const snapshot = await chef.inspectState();
  assert.ok(snapshot.plans.length > 0, "plans must be persisted in workspace snapshots");
  const plan = snapshot.plans[0];
  assert.equal(plan.goal, "Persist this plan durably", "plan goal must survive persistence");
  assert.equal(plan.status, "completed", "completed plan status must be persisted");
  assert.ok(plan.taskIds.length > 0, "plan task ids must be persisted");
  assert.ok(plan.tasks.length === plan.taskIds.length, "plan task list must match task ids");

  await chef.close();

  const reopened = createChef({ dbPath, projectDir: dir });
  await reopened.start();
  const restored = await reopened.inspectState();
  assert.equal(restored.plans.length, snapshot.plans.length, "plan history must survive reopen");
  const restoredPlan = restored.plans[0];
  assert.equal(restoredPlan.id, plan.id, "plan id must survive reopen");
  assert.equal(restoredPlan.goal, plan.goal, "plan goal must survive reopen");
  assert.equal(restoredPlan.status, "completed", "plan status must survive reopen");
  assert.equal(restoredPlan.taskIds.length, plan.taskIds.length, "plan task ids must survive reopen");
  assert.deepEqual(restoredPlan.taskIds, plan.taskIds, "plan task ids must be identical after reopen");
  await reopened.close();

  console.log("plan-persistence: ok — plans survive close/reopen with status and task lineage");
} finally {
  await rm(dir, { recursive: true, force: true });
}
