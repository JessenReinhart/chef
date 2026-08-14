// Smoke test: real Repository + real Scheduler + real GenericTerminalHarness
// driven by Orchestrator + ScriptedDecisionProvider.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "../src/persistence/database.ts";
import { Scheduler } from "../src/runtime/scheduler.ts";
import { Orchestrator, ScriptedDecisionProvider } from "../src/orchestrator/orchestrator.ts";
import { GenericTerminalHarness } from "../src/harness/generic.ts";
import type { HarnessRegistry } from "../src/orchestrator/orchestrator.ts";

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "chef-smoke-"));
  const dbPath = join(dir, "chef.db");
  const repo = new Repository(dbPath);
  const ws = repo.createWorkspace({ name: "smoke", rootPath: dir });
  repo.seedAgent({ workspaceId: ws.id, name: "orchestrator", role: "orchestrator" });

  const provider = new ScriptedDecisionProvider();
  const registry: HarnessRegistry = new Map();
  const scheduler = new Scheduler(repo, registry, { maxConcurrency: 2 });

  // Wire the two scripted agent harnesses (per TaskScheduler: one GenericTerminalHarness per agent).
  for (const agentId of ["investigator", "verifier"]) {
    const h = provider.harnessFor(agentId, ws.id) as unknown as GenericTerminalHarness;
    registry.set(agentId, h);
  }

  const orch = new Orchestrator({
    repository: repo,
    runtime: scheduler,
    harnessRegistry: registry,
    decisionProvider: provider,
    timeoutMs: 30_000,
  });

  console.log("Sending: Investigate this bug and verify the fix.");
  const result = await orch.handleUserMessage(ws.id, "Investigate this bug and verify the fix.");
  console.log("\n=== ORCHESTRATOR RESULT ===");
  console.log(JSON.stringify(result, null, 2));

  const snap = repo.getWorkspaceSnapshot(ws.id);
  console.log("\n=== TASKS ===");
  for (const t of snap.tasks) console.log(`  ${t.id.slice(0, 8)} ${t.title} -> ${t.status}${t.resultSummary ? ` | ${t.resultSummary}` : ""}`);
  console.log("=== ARTIFACTS ===");
  for (const a of snap.artifacts) console.log(`  ${a.id.slice(0, 8)} ${a.name} (${a.type}) task=${a.taskId?.slice(0, 8)}`);
  console.log("=== EVENT TYPES ===");
  for (const e of snap.events) console.log(`  ${e.seq}: ${e.type}${e.taskId ? ` task=${e.taskId.slice(0, 8)}` : ""}`);

  repo.close();
  console.log("\nDONE");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});