import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChef } from "../src/main.ts";

const dir = mkdtempSync(join(tmpdir(), "chef-cancel-facade-"));
const chef = createChef({ dbPath: join(dir, "chef.db"), projectDir: dir });
try {
  await chef.start();
  const result = await chef.sendUserMessage("Investigate and fix this bug");
  const taskId = result.taskIds[0];
  if (!taskId) throw new Error("expected a task to cancel");
  let rejected = false;
  try {
    await chef.cancelTask(taskId);
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("Invalid task transition");
  }
  if (!rejected) throw new Error("cancelling a completed task must reject");
  const task = chef.repository.getTask(taskId);
  if (!task || task.status !== "completed") {
    throw new Error(`completed task regressed after rejected cancellation: ${task?.status}`);
  }
  console.log("cancel-facade: ok — terminal task cannot be regressed by cancellation");
} finally {
  await chef.close();
  rmSync(dir, { recursive: true, force: true });
}
