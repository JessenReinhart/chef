/**
 * Chef — deterministic tool runner tests (Phase 8).
 *
 * Covers: filesystem read/list/write scoping, out-of-root denial,
 * git status/log, terminal execution via PTY harness, approval gate for
 * destructive operations, and honest errors for unavailable tools.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ToolRunner, PermissionDeniedError, type ToolContext } from "../src/runtime/tool-runner.ts";
import { GenericTerminalHarness } from "../src/harness/generic.ts";
import { Repository } from "../src/persistence/database.ts";

const dir = mkdtempSync(join(tmpdir(), "chef-tool-runner-"));
const projectDir = join(dir, "project");
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, "hello.txt"), "hello world\n");

const dbPath = join(dir, "chef.sqlite");
const repository = new Repository(dbPath);

let passed = 0;
const test = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn();
  passed += 1;
  console.log(`tool-runner: ok — ${name}`);
};

function makeContext(role: "engineer" | "orchestrator" | "human" = "engineer"): ToolContext {
  return {
    workspaceId: "ws-tools",
    projectDir,
    harnessRegistry: {
      get: () => undefined,
      set: () => {},
      values: () => [],
    },
    capabilities: { agentId: `agent-${role}`, workspaceId: "ws-tools", role },
  };
}

const runner = new ToolRunner(makeContext());

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

await test("file_read reads a file inside project root", async () => {
  const result = await runner.execute({ tool: "file_read", input: { path: "hello.txt" } });
  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.output, { content: "hello world\n" });
});

await test("file_write writes inside project root", async () => {
  const result = await runner.execute({ tool: "file_write", input: { path: "out.txt", content: "written" } });
  assert.equal(result.ok, true);
  const read = await runner.execute({ tool: "file_read", input: { path: "out.txt" } });
  assert.deepEqual(read.output, { content: "written" });
});

await test("file_list lists directory entries", async () => {
  const result = await runner.execute({ tool: "file_list", input: { path: "." } });
  assert.equal(result.ok, true);
  const entries = (result.output as { entries: string[] }).entries;
  assert.ok(entries.includes("hello.txt"));
  assert.ok(entries.includes("out.txt"));
});

await test("out-of-root read fails with denied status", async () => {
  const outside = join(dir, "outside-secret.txt");
  writeFileSync(outside, "secret");
  const result = await runner.execute({ tool: "file_read", input: { path: resolve(outside) } });
  assert.equal(result.status, "denied");
  const output = result.output as { error: string };
  assert.match(output.error, /permission denied|outside/i);
});

// ---------------------------------------------------------------------------
// Terminal (PTY)
// ---------------------------------------------------------------------------

await test("bash tool runs a real command through PTY", async () => {
  const ctx = makeContext();
  const harness = new GenericTerminalHarness({ agentId: "agent-pty", workspaceId: "ws-tools", command: "sh", args: ["-c", "echo hello-pty"] });
  ctx.harnessRegistry = {
    get: (id: string) => (id === "agent-pty" ? harness : undefined),
    set: () => {},
    values: () => [harness],
  };
  const runnerPty = new ToolRunner(ctx);
  const result = await runnerPty.execute({ tool: "bash", input: { command: "echo hello-pty", cwd: projectDir } });
  assert.equal(result.ok, true);
  const stdout = (result.output as { stdout: string }).stdout;
  assert.match(stdout, /hello-pty/);
  await harness.close();
});

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

await test("git status works on a real repo", async () => {
  const repoDir = join(projectDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "a.txt"), "a");
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@chef.local"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Chef Test"], { cwd: repoDir });
  const ctx = makeContext();
  ctx.projectDir = repoDir;
  const runnerRepo = new ToolRunner(ctx);
  const result = await runnerRepo.execute({ tool: "git", input: { operation: "status" } });
  assert.equal(result.ok, true);
  const stdout = (result.output as { stdout: string }).stdout;
  assert.match(stdout, /a\.txt|nothing to commit|No commits/i);
});

// ---------------------------------------------------------------------------
// Approval gate
// ---------------------------------------------------------------------------

await test("destructive operation requires approval and blocks until resolved", async () => {
  // Engineer role: out-of-root write is denied outright (no approval flow).
  const denied = await runner.execute({
    tool: "file_write",
    input: { path: resolve(join(dir, "outside-write.txt")), content: "x" },
  });
  assert.equal(denied.status, "denied");

  // git push is always approval-gated; capture the approval id via emitEvent.
  const repoDir = join(projectDir, "approval-repo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "b.txt"), "b");
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@chef.local"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Chef Test"], { cwd: repoDir });

  const ctx = makeContext("orchestrator");
  ctx.projectDir = repoDir;
  let approvalId: string | undefined;
  const runnerApproval = new ToolRunner({
    ...ctx,
    emitEvent: (event) => {
      if (event.type === "approval.requested") {
        const payload = event.payload as { approvalId?: string };
        approvalId = payload.approvalId;
      }
    },
  });
  const pushPromise = runnerApproval.execute({
    tool: "git",
    input: { operation: "push", remote: "origin", branch: "main" },
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(approvalId, "expected an approval.requested event with an id");
  // Blocks until resolved: reject, then the call fails with denied.
  runnerApproval.resolveApproval(approvalId, "rejected");
  const result = await pushPromise;
  assert.equal(result.ok, false);
  assert.equal(result.status, "denied");
});

// ---------------------------------------------------------------------------
// Unavailable tools
// ---------------------------------------------------------------------------

await test("unknown tool returns honest error", async () => {
  const result = await runner.execute({ tool: "no_such_tool" });
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.match((result.output as { error: string }).error, /no_such_tool/);
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

repository.close();
rmSync(dir, { recursive: true, force: true });

console.log(`tool-runner: ok — ${passed} tests passed`);
