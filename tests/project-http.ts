import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createProjectServer, findLinuxDirectoryPicker, isSameProjectPath } from "../src/server/project-http.ts";
import { shouldRejectOtherProjectRuntime } from "../scripts/launcher-policy.mjs";
import type { ChefRuntime } from "../src/main.ts";

assert.equal(shouldRejectOtherProjectRuntime({
  existingProjectPath: "/home/jessen/brain",
  currentProjectPath: "/home/jessen/chef",
  restart: true,
  platform: "linux",
}), false, "--restart must be allowed to replace a Chef runtime serving another project");
assert.equal(shouldRejectOtherProjectRuntime({
  existingProjectPath: "/home/jessen/brain",
  currentProjectPath: "/home/jessen/chef",
  restart: false,
  platform: "linux",
}), true, "without --restart, Chef must refuse to steal another project's runtime");
assert.equal(shouldRejectOtherProjectRuntime({
  existingProjectPath: "C:\\Work\\Chef",
  currentProjectPath: "c:\\work\\chef",
  restart: false,
  platform: "win32",
}), false, "Windows project comparison must remain case-insensitive");

assert.equal(
  isSameProjectPath("C:\\Work\\Chef", "c:\\work\\chef", "win32"),
  true,
  "selecting the already-open Windows project must not relaunch Chef just because path casing differs",
);
assert.equal(
  isSameProjectPath("/home/jessen/Chef", "/home/jessen/chef", "linux"),
  false,
  "Linux project selection must preserve case-sensitive path semantics",
);

const zenityPicker = await findLinuxDirectoryPicker(async (command) => command === "zenity");
assert.equal(zenityPicker?.command, "zenity");
assert.deepEqual(zenityPicker?.args.slice(0, 2), ["--file-selection", "--directory"]);

const kdialogPicker = await findLinuxDirectoryPicker(async (command) => command === "kdialog");
assert.equal(kdialogPicker?.command, "kdialog");
assert.equal(await findLinuxDirectoryPicker(async () => false), null);

const dir = await mkdtemp(join(tmpdir(), "chef-project-http-"));
const current = join(dir, "current");
const next = join(dir, "next");
const other = join(dir, "other");
const recents = join(dir, "state", "recent.json");
await mkdir(current);
await mkdir(next);
await mkdir(other);
let opened: string | null = null;
const openAttempts: string[] = [];

const runtime = { projectDir: current } as ChefRuntime;
const base = createServer((_req, res) => { res.writeHead(418); res.end("base"); });
const server = createProjectServer(runtime, base, {
  recentProjectsPath: recents,
  pickDirectory: async () => next,
  canPickDirectory: async () => true,
  onOpenProject: async (path) => { opened = path; openAttempts.push(path); },
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;

try {
  const state = await fetch(`${origin}/api/project`).then((response) => response.json()) as { data: { path: string; recent: unknown[]; nativePicker: boolean } };
  assert.equal(state.data.path, current);
  assert.deepEqual(state.data.recent, []);
  assert.equal(state.data.nativePicker, true);

  const invalid = await fetch(`${origin}/api/project/open`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: join(dir, "missing") }),
  });
  assert.equal(invalid.status, 400);

  const selectedCurrent = await fetch(`${origin}/api/project/open`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: current }),
  });
  assert.equal(selectedCurrent.status, 200, "selecting the active project must clearly succeed without a relaunch");
  const selectedCurrentBody = await selectedCurrent.json() as { ok?: boolean; data?: { path?: string; current?: boolean } };
  assert.equal(selectedCurrentBody.ok, true);
  assert.equal(selectedCurrentBody.data?.path, current);
  assert.equal(selectedCurrentBody.data?.current, true, "project selection response must explicitly confirm the project is current");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(opened, null, "selecting the already-active project must not trigger a runtime relaunch");

  const picked = await fetch(`${origin}/api/project/pick`, { method: "POST" });
  assert.equal(picked.status, 202);

  const duplicatePending = await fetch(`${origin}/api/project/open`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: next }),
  });
  assert.equal(duplicatePending.status, 202, "re-selecting the pending target should be idempotent");
  const duplicatePendingBody = await duplicatePending.json() as { data?: { path?: string; reopening?: boolean } };
  assert.equal(duplicatePendingBody.data?.path, next);
  assert.equal(duplicatePendingBody.data?.reopening, true);

  const conflictingPending = await fetch(`${origin}/api/project/open`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: other }),
  });
  assert.equal(conflictingPending.status, 409, "a second project must not race the already-pending runtime handoff");
  const conflictingPendingBody = await conflictingPending.json() as { error?: string };
  assert.match(conflictingPendingBody.error ?? "", /already switching/i);
  assert.match(conflictingPendingBody.error ?? "", new RegExp(next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const blockedThreadCreate = await fetch(`${origin}/api/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Todo app" }),
  });
  assert.equal(blockedThreadCreate.status, 409, "the old runtime must not create a Thread after another project is selected");
  const blockedThreadCreateBody = await blockedThreadCreate.json() as { error?: string };
  assert.match(blockedThreadCreateBody.error ?? "", /selected project is active/i);

  const blockedChat = await fetch(`${origin}/api/threads/thread-old/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Create a simple todo app" }),
  });
  assert.equal(blockedChat.status, 409, "the canonical task must not start against the old project during runtime handoff");

  const blockedLegacyChat = await fetch(`${origin}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Create a simple todo app" }),
  });
  assert.equal(blockedLegacyChat.status, 409, "legacy chat must not start work against the old project during runtime handoff");
  const blockedLegacyChatBody = await blockedLegacyChat.json() as { error?: string };
  assert.match(blockedLegacyChatBody.error ?? "", /selected project is active/i);

  const blockedRetry = await fetch(`${origin}/api/nodes/task-old/retry`, { method: "POST" });
  assert.equal(blockedRetry.status, 409, "Retry must not restart old-project work after another project is selected");
  const blockedRetryBody = await blockedRetry.json() as { error?: string };
  assert.match(blockedRetryBody.error ?? "", /selected project is active/i);

  const blockedApprovalAccept = await fetch(`${origin}/api/tools/approvals/approval-old/accept`, { method: "POST" });
  assert.equal(blockedApprovalAccept.status, 409, "Allow must not resume old-project work after another project is selected");
  const blockedApprovalAcceptBody = await blockedApprovalAccept.json() as { error?: string };
  assert.match(blockedApprovalAcceptBody.error ?? "", /selected project is active/i);

  const blockedLegacyApprovalAccept = await fetch(`${origin}/api/approvals/approval-old/accept`, { method: "POST" });
  assert.equal(blockedLegacyApprovalAccept.status, 409, "legacy approval acceptance must not resume old-project work after another project is selected");
  const blockedLegacyApprovalAcceptBody = await blockedLegacyApprovalAccept.json() as { error?: string };
  assert.match(blockedLegacyApprovalAcceptBody.error ?? "", /selected project is active/i);

  const blockedMissionResume = await fetch(`${origin}/api/missions/mission-old/resume`, { method: "POST" });
  assert.equal(blockedMissionResume.status, 409, "Resume must not restart an old-project Mission after another project is selected");
  const blockedMissionResumeBody = await blockedMissionResume.json() as { error?: string };
  assert.match(blockedMissionResumeBody.error ?? "", /selected project is active/i);

  const blockedMissionRedirect = await fetch(`${origin}/api/missions/mission-old`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "Use a different implementation approach" }),
  });
  assert.equal(blockedMissionRedirect.status, 409, "Redirect must not replan old-project work after another project is selected");
  const blockedMissionRedirectBody = await blockedMissionRedirect.json() as { error?: string };
  assert.match(blockedMissionRedirectBody.error ?? "", /selected project is active/i);

  const allowedApprovalReject = await fetch(`${origin}/api/tools/approvals/approval-old/reject`, { method: "POST" });
  assert.equal(allowedApprovalReject.status, 418, "Reject does not resume work and should remain available during project handoff");
  assert.equal(
    (await fetch(`${origin}/api/approvals/approval-old/reject`, { method: "POST" })).status,
    418,
    "legacy approval rejection does not resume work and should remain available during project handoff",
  );
  assert.equal(
    (await fetch(`${origin}/api/missions/mission-old/pause`, { method: "POST" })).status,
    418,
    "Pause restrains work and should remain available during project handoff",
  );
  assert.equal(
    (await fetch(`${origin}/api/missions/mission-old/cancel`, { method: "POST" })).status,
    418,
    "Cancel stops work and should remain available during project handoff",
  );

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(opened, next);
  assert.deepEqual(openAttempts, [next], "duplicate/conflicting project selections must schedule exactly one runtime handoff");

  const remembered = JSON.parse(await readFile(recents, "utf8")) as Array<{ path: string }>;
  assert.equal(remembered[0]?.path, next);

  const fallback = await fetch(`${origin}/anything`);
  assert.equal(fallback.status, 418);

  const failingBase = createServer((_req, res) => { res.writeHead(418); res.end("base"); });
  const failingServer = createProjectServer(runtime, failingBase, {
    recentProjectsPath: join(dir, "state", "failed-recent.json"),
    canPickDirectory: async () => false,
    onOpenProject: async () => { throw new Error("restart failed"); },
  });
  await new Promise<void>((resolve) => failingServer.listen(0, "127.0.0.1", resolve));
  const failingAddress = failingServer.address();
  assert.ok(failingAddress && typeof failingAddress === "object");
  const failingOrigin = `http://127.0.0.1:${failingAddress.port}`;
  try {
    const reopen = await fetch(`${failingOrigin}/api/project/open`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: next }),
    });
    assert.equal(reopen.status, 202);
    assert.equal((await fetch(`${failingOrigin}/api/threads`, { method: "POST" })).status, 409);
    assert.equal(
      (await fetch(`${failingOrigin}/api/nodes/task-old/retry`, { method: "POST" })).status,
      409,
      "Retry must stay gated while the old runtime is attempting the selected-project handoff",
    );
    assert.equal(
      (await fetch(`${failingOrigin}/api/tools/approvals/approval-old/accept`, { method: "POST" })).status,
      409,
      "approval acceptance must stay gated while the old runtime is attempting the selected-project handoff",
    );
    assert.equal(
      (await fetch(`${failingOrigin}/api/approvals/approval-old/accept`, { method: "POST" })).status,
      409,
      "legacy approval acceptance must stay gated while the old runtime is attempting the selected-project handoff",
    );
    assert.equal(
      (await fetch(`${failingOrigin}/api/missions/mission-old/resume`, { method: "POST" })).status,
      409,
      "Mission resume must stay gated while the old runtime is attempting the selected-project handoff",
    );
    assert.equal(
      (await fetch(`${failingOrigin}/api/missions/mission-old`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "Use a different implementation approach" }),
      })).status,
      409,
      "Mission redirect must stay gated while the old runtime is attempting the selected-project handoff",
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      (await fetch(`${failingOrigin}/api/threads`, { method: "POST" })).status,
      418,
      "a failed runtime reopen must release the old-project work gate so recovery remains possible",
    );
    assert.equal(
      (await fetch(`${failingOrigin}/api/nodes/task-old/retry`, { method: "POST" })).status,
      418,
      "a failed runtime reopen must release Retry back to the old runtime instead of leaving recovery deadlocked",
    );
    assert.equal(
      (await fetch(`${failingOrigin}/api/tools/approvals/approval-old/accept`, { method: "POST" })).status,
      418,
      "a failed runtime reopen must release approval acceptance back to the old runtime for recovery",
    );
    assert.equal(
      (await fetch(`${failingOrigin}/api/approvals/approval-old/accept`, { method: "POST" })).status,
      418,
      "a failed runtime reopen must release legacy approval acceptance back to the old runtime for recovery",
    );
    assert.equal(
      (await fetch(`${failingOrigin}/api/missions/mission-old/resume`, { method: "POST" })).status,
      418,
      "a failed runtime reopen must release Mission resume back to the old runtime for recovery",
    );
    assert.equal(
      (await fetch(`${failingOrigin}/api/missions/mission-old`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "Use a different implementation approach" }),
      })).status,
      418,
      "a failed runtime reopen must release Mission redirect back to the old runtime for recovery",
    );
    const recoverySelection = await fetch(`${failingOrigin}/api/project/open`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: other }),
    });
    assert.equal(recoverySelection.status, 202, "after a failed handoff Chef must accept a new project selection for recovery");
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    await new Promise<void>((resolve) => failingServer.close(() => resolve()));
  }

  console.log("project-http: ok");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
}
