import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Repository } from "../src/persistence/database.ts";
import { createThreadRepository } from "../src/persistence/threads.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-thread-persistence-"));
const dbPath = join(dir, "chef.sqlite");

try {
  const repo = new Repository(dbPath);
  repo.createWorkspace({ id: "workspace-a", name: "Workspace A" });
  repo.createWorkspace({ id: "workspace-b", name: "Workspace B" });
  const threads = createThreadRepository(repo);

  const auth = threads.create({
    id: "thread-auth",
    workspaceId: "workspace-a",
    title: "  Authentication  ",
    metadata: { source: "test" },
  });
  const dashboard = threads.create({
    id: "thread-dashboard",
    workspaceId: "workspace-a",
    title: "Dashboard redesign",
  });
  threads.create({
    id: "thread-other-workspace",
    workspaceId: "workspace-b",
    title: "Other workspace",
  });

  assert.equal(auth.title, "Authentication", "thread titles should be normalized at persistence boundary");
  assert.equal(auth.status, "active");
  assert.deepEqual(auth.metadata, { source: "test" });
  assert.deepEqual(
    new Set(threads.list("workspace-a").map((thread) => thread.id)),
    new Set([auth.id, dashboard.id]),
    "thread listing must stay workspace scoped",
  );

  const renamed = threads.update(auth.id, {
    title: "Authentication follow-ups",
    summary: "Sign-in is implemented; password reset is next.",
  });
  assert.equal(renamed.title, "Authentication follow-ups");
  assert.equal(renamed.summary, "Sign-in is implemented; password reset is next.");

  const archived = threads.archive(dashboard.id);
  assert.equal(archived.status, "archived", "archive must preserve the durable thread instead of deleting it");

  repo.close();

  const reopenedRepo = new Repository(dbPath);
  const reopenedThreads = createThreadRepository(reopenedRepo);
  const restoredAuth = reopenedThreads.get(auth.id);
  const restoredDashboard = reopenedThreads.get(dashboard.id);

  assert.ok(restoredAuth, "thread must survive database reopen");
  assert.equal(restoredAuth.title, renamed.title);
  assert.equal(restoredAuth.summary, renamed.summary);
  assert.equal(restoredDashboard?.status, "archived", "archived state must survive database reopen");
  assert.equal(reopenedThreads.list("workspace-b").length, 1, "workspace isolation must survive reopen");

  assert.throws(
    () => reopenedThreads.create({ workspaceId: "workspace-a", title: "   " }),
    /must not be empty/,
    "empty titles must fail before persistence",
  );

  reopenedRepo.close();
  console.log("thread-persistence: ok — threads persist, archive safely, and remain workspace scoped");
} finally {
  await rm(dir, { recursive: true, force: true });
}
