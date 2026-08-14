import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChef } from "./src/main.ts";

const projectDir = await mkdtemp(join(tmpdir(), "chef-diag-"));
const dbPath = join(projectDir, "chef.sqlite");

try {
  const chef = createChef({ dbPath, projectDir });
  await chef.start();
  const workspaceId = chef.workspaceId;
  await chef.sendUserMessage("Investigate and fix this bug");
  await chef.close();

  const reopened = createChef({ dbPath, projectDir });
  await reopened.start();
  await reopened.close();
} finally {
  console.error("=== AFTER BOTH CLOSES ===");
  const handles = process._getActiveHandles();
  console.error(`Active handles: ${handles.length}`);
  handles.forEach((h, i) => {
    const cn = h.constructor?.name;
    const keys = Object.getOwnPropertyNames(h).filter(k => k.startsWith('_') || k === 'refed' || k === 'unrefed');
    console.error(`  [${i}] ${cn} refed=${h.refed ?? 'N/A'} keys=${keys.join(',')}`);
    if (h._parent !== undefined) console.error(`      _parent: ${h._parent?.constructor?.name ?? h._parent}`);
    if (h._host !== undefined) console.error(`      _host: ${h._host}`);
    if (h._handle !== undefined) console.error(`      _handle: ${h._handle?.constructor?.name ?? h._handle}`);
  });
  const reqs = process._getActiveRequests();
  console.error(`Active requests: ${reqs.length}`);
  reqs.forEach((r, i) => console.error(`  [${i}] ${r.constructor?.name}`));
  
  process.exit(0);
}
