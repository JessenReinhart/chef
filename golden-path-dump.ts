import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChef } from "file:///C:/Users/LGSM228/chef/src/main.ts";

const projectDir = await mkdtemp(join(tmpdir(), "chef-golden-project-"));
const dbPath = join(projectDir, "chef.sqlite");

const chef = createChef({ dbPath, projectDir });
await chef.start();
const result = await chef.sendUserMessage("Investigate and fix this bug");
console.error(`result.ok=${result.ok} report=${result.report.slice(0, 200)}`);
const snapshot = await chef.inspectState();
console.error("SESSIONS:");
for (const s of snapshot.sessions) console.error(`  status=${s.status} task=${s.taskId} cmd=${s.command}`);
console.error("TASKS:");
for (const t of snapshot.tasks) console.error(`  status=${t.status} agent=${t.assignedTo}`);
await chef.close();
await rm(projectDir, { recursive: true, force: true }).catch(e => console.error(`rm FAILED: ${e.code}`));
process.exit(0);
