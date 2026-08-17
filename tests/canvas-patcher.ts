/**
 * Runtime patchCanvas regression (spec §5.4 canvas graph):
 *  1. upsert node position persists.
 *  2. upsert edge is idempotent (duplicate source->target = no double row).
 *  3. delete edge removes the row.
 *  4. delete node cascades its edges.
 *  5. patch with edge referencing missing node is rejected (ok:false, no partial write).
 *  6. patch with non-finite position is rejected.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChef } from "../src/main.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-canvas-patcher-"));
const chef = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir });

try {
  await chef.start();
  const workspaceId = chef.workspaceId;
  const repo = chef.repository;

  // 1. upsert node position persists
  {
    const res = await chef.patchCanvas(workspaceId, {
      upsertNodes: [{ id: "a", label: "Alpha", kind: "agent", position: { x: 12, y: 34 } }],
    });
    assert.equal(res.ok, true, "node upsert must succeed");
    const node = repo.listCanvasNodes(workspaceId).find((n) => n.id === "a");
    assert.ok(node, "upserted node must persist");
    assert.equal(node!.positionX, 12, "position x must persist");
    assert.equal(node!.positionY, 34, "position y must persist");
  }

  // 2. upsert edge + duplicate is idempotent
  {
    await chef.patchCanvas(workspaceId, {
      upsertNodes: [{ id: "b", label: "Beta", kind: "agent" }],
    });
    const first = await chef.patchCanvas(workspaceId, {
      upsertEdges: [{ source: "a", target: "b" }],
    });
    assert.equal(first.ok, true, "edge upsert must succeed");
    const dup = await chef.patchCanvas(workspaceId, {
      upsertEdges: [{ source: "a", target: "b" }],
    });
    assert.equal(dup.ok, true, "duplicate edge upsert must succeed");
    const edges = repo.listCanvasEdges(workspaceId).filter((e) => e.source === "a" && e.target === "b");
    assert.equal(edges.length, 1, "duplicate source->target must remain a single edge row");
  }

  // 3. delete edge
  {
    const before = repo.listCanvasEdges(workspaceId).length;
    const res = await chef.patchCanvas(workspaceId, {
      deleteEdges: [{ source: "a", target: "b" }],
    });
    assert.equal(res.ok, true, "edge delete must succeed");
    const after = repo.listCanvasEdges(workspaceId).length;
    assert.equal(after, before - 1, "edge row must be removed");
    assert.ok(!repo.listCanvasEdges(workspaceId).some((e) => e.source === "a" && e.target === "b"), "deleted edge must be gone");
  }

  // 4. delete node cascades its edges
  {
    await chef.patchCanvas(workspaceId, {
      upsertEdges: [{ source: "a", target: "b" }],
    });
    // Add a second edge touching "a" so cascade is unambiguous.
    await chef.patchCanvas(workspaceId, {
      upsertNodes: [{ id: "c", label: "Gamma", kind: "agent" }],
      upsertEdges: [{ source: "c", target: "a" }],
    });
    const res = await chef.patchCanvas(workspaceId, { deleteNodes: ["a"] });
    assert.equal(res.ok, true, "node delete must succeed");
    assert.ok(!repo.listCanvasNodes(workspaceId).some((n) => n.id === "a"), "deleted node must be gone");
    assert.ok(!repo.listCanvasEdges(workspaceId).some((e) => e.source === "a" || e.target === "a"), "edges touching deleted node must cascade");
  }

  // 5. patch with edge referencing missing node → rejected, no partial write
  {
    const nodesBefore = repo.listCanvasNodes(workspaceId).length;
    const res = await chef.patchCanvas(workspaceId, {
      upsertNodes: [{ id: "d", label: "Delta", kind: "agent" }],
      upsertEdges: [{ source: "d", target: "ghost" }],
    });
    assert.equal(res.ok, false, "edge to missing node must be rejected");
    assert.ok(res.error, "rejection must carry an error");
    // Node "d" must NOT have been partially written (transaction rolled back).
    assert.ok(!repo.listCanvasNodes(workspaceId).some((n) => n.id === "d"), "failed patch must not partially upsert node d");
    assert.equal(repo.listCanvasNodes(workspaceId).length, nodesBefore, "node count must be unchanged after rolled-back patch");
  }

  // 6. patch with non-finite position → rejected
  {
    const res = await chef.patchCanvas(workspaceId, {
      upsertNodes: [{ id: "e", label: "Epsilon", kind: "agent", position: { x: Number.NaN, y: 1 } }],
    });
    assert.equal(res.ok, false, "non-finite position must be rejected");
    assert.ok(res.error, "rejection must carry an error");
    assert.ok(!repo.listCanvasNodes(workspaceId).some((n) => n.id === "e"), "invalid-position node must not be written");
  }

  await chef.close();
  console.log("canvas-patcher: ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
