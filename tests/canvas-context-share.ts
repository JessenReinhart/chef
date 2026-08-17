/**
 * Canvas-edge context sharing (spec §5.4 + October-style "connections
 * scope context"):
 *  1. Adding a canvas edge source->target injects the source's latest
 *     artifact as a ContextReference on the target's task.
 *  2. Removing an edge refreshes the target's contextRefs (drops the
 *     source's artifact reference).
 *  3. An edge whose source node has no task / no artifact still records
 *     a task reference (so the worker can read upstream state).
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChef } from "../src/main.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-canvas-context-"));
const chef = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir });

try {
  await chef.start();
  const workspaceId = chef.workspaceId;
  const repo = chef.repository;

  const srcId = "ctx-src";
  const tgtId = "ctx-tgt";

  // Seed tasks first (canvas_nodes.task_id has an immediate FK to tasks).
  repo.createTask({
    id: srcId,
    workspaceId,
    title: "Source task",
    description: "produces context",
    status: "pending",
  });
  repo.createTask({
    id: tgtId,
    workspaceId,
    title: "Target task",
    description: "consumes context",
    status: "pending",
  });

  // Seed two canvas nodes backed by those tasks (as the orchestrator does for a plan).
  await chef.patchCanvas(workspaceId, {
    upsertNodes: [
      { id: srcId, taskId: srcId, label: "Source", kind: "agent" },
      { id: tgtId, taskId: tgtId, label: "Target", kind: "agent" },
    ],
  });
  repo.insertArtifact({
    workspaceId,
    type: "result",
    name: "src-output",
    uri: "sideband://ctx-src/out.json",
    createdBy: "orchestrator",
    taskId: srcId,
  });

  // 1. Adding the edge injects the source's latest artifact into target's contextRefs
  {
    const res = await chef.patchCanvas(workspaceId, {
      upsertEdges: [{ source: srcId, target: tgtId }],
    });
    assert.equal(res.ok, true, "edge upsert must succeed");
    const targetTask = repo.getTask(tgtId)!;
    assert.ok(targetTask, "target task must exist");
    const refs = targetTask.contextRefs;
    const artifactRef = refs.find((r) => r.type === "artifact");
    assert.ok(
      artifactRef,
      `target task must gain a contextRef to source artifact; got ${JSON.stringify(refs)}`,
    );
    // Verify the artifact ref points to an artifact belonging to srcId
    const srcArtifact = repo.getArtifact(artifactRef.id)!;
    assert.equal(srcArtifact.taskId, srcId, "artifact ref must point to source task's artifact");
    assert.ok(
      refs.some((r) => r.type === "task" && r.id === srcId),
      `target task must gain a contextRef to source task; got ${JSON.stringify(refs)}`,
    );
  }

  // 2. Removing the edge refreshes target's contextRefs (drops source refs)
  {
    const res = await chef.patchCanvas(workspaceId, {
      deleteEdges: [{ source: srcId, target: tgtId }],
    });
    assert.equal(res.ok, true, "edge delete must succeed");
    const targetTask = repo.getTask(tgtId)!;
    const refs = targetTask.contextRefs;
    assert.ok(
      !refs.some((r) => r.id === srcId || r.id === "src-output"),
      `target task must lose source refs after edge removal; got ${JSON.stringify(refs)}`,
    );
  }

  // 3. Re-adding the edge re-injects (idempotent round-trip)
  {
    await chef.patchCanvas(workspaceId, {
      upsertEdges: [{ source: srcId, target: tgtId }],
    });
    const targetTask = repo.getTask(tgtId)!;
    const artifactRef = targetTask.contextRefs.find((r) => r.type === "artifact");
    assert.ok(
      artifactRef && repo.getArtifact(artifactRef.id)?.taskId === srcId,
      "re-added edge must re-inject the artifact ref",
    );
  }

  await chef.close();
  console.log("canvas-context-share: ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}