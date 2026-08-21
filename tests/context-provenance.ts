import { strict as assert } from "node:assert";
import { describeContextReference } from "../web/src/contextProvenance.ts";

const snapshot = {
  artifacts: [{
    id: "artifact-1",
    workspaceId: "ws",
    type: "document" as const,
    name: "Release report",
    uri: "file:///release.pdf",
    version: 3,
    createdBy: "reviewer",
    metadata: {},
  }],
  decisions: [{
    id: "decision-1",
    workspaceId: "ws",
    type: "architecture",
    summary: "Keep runtime authoritative",
    payload: {},
    madeBy: "orchestrator",
    timestamp: 1,
    status: "accepted" as const,
  }],
  tasks: [{
    id: "task-1",
    workspaceId: "ws",
    title: "Verify release",
    description: "",
    status: "running" as const,
    assignedTo: "verifier",
    dependencies: [],
    contextRefs: [],
    priority: 0,
    retryCount: 0,
    createdAt: 1,
    updatedAt: 1,
  }],
  events: [{
    id: "event-1",
    workspaceId: "ws",
    seq: 12,
    timestamp: 1,
    source: { type: "agent", id: "verifier" },
    type: "verification.completed",
    payload: {},
  }],
};

const artifact = describeContextReference({ type: "artifact", id: "artifact-1", relevance: 0.9 }, snapshot);
assert.equal(artifact.label, "Release report");
assert.match(artifact.detail, /reviewer/);
assert.equal(artifact.relevance, 0.9);
assert.equal(artifact.stale, false);

const decision = describeContextReference({ type: "decision", id: "decision-1" }, snapshot);
assert.match(decision.detail, /accepted/);
assert.match(decision.detail, /orchestrator/);

const task = describeContextReference({ type: "task", id: "task-1" }, snapshot);
assert.equal(task.label, "Verify release");
assert.match(task.detail, /running/);
assert.match(task.detail, /verifier/);

const event = describeContextReference({ type: "event", id: "event-1" }, snapshot);
assert.equal(event.label, "verification.completed");
assert.match(event.detail, /#12/);
assert.match(event.detail, /agent:verifier/);

const stale = describeContextReference({ type: "artifact", id: "missing" }, snapshot);
assert.equal(stale.stale, true);
assert.match(stale.detail, /no longer present/);

const externalFile = describeContextReference({ type: "file", id: "README.md" }, snapshot);
assert.equal(externalFile.stale, false);
assert.equal(externalFile.detail, "File reference");

console.log("context-provenance: ok");
