import { strict as assert } from "node:assert";
import {
  MAX_SHELF_RESULTS,
  MAX_VISIBLE_RESULTS,
  canDownload,
  metadataRows,
  previewText,
  provenanceLabel,
  recentArtifacts,
  type LivingArtifact,
} from "../web/src/artifactProjection.ts";

function artifact(overrides: Partial<LivingArtifact> = {}): LivingArtifact {
  return {
    id: "artifact-1",
    workspaceId: "workspace-1",
    type: "document",
    name: "Result",
    uri: "chef:artifact-1",
    version: 2,
    createdBy: "worker-1",
    taskId: "task-123456789",
    metadata: {},
    ...overrides,
  };
}

const timeline = Array.from({ length: 30 }, (_, index) => artifact({ id: `artifact-${index + 1}`, version: index + 1 }));
assert.deepEqual(
  recentArtifacts(timeline, MAX_VISIBLE_RESULTS).map((item) => item.id),
  ["artifact-30", "artifact-29", "artifact-28", "artifact-27"],
  "workspace result cards should expose the four newest durable artifacts in newest-first order",
);
assert.equal(recentArtifacts(timeline, MAX_SHELF_RESULTS).length, 24, "the shelf should remain bounded for large workspaces");
assert.equal(recentArtifacts(timeline, MAX_SHELF_RESULTS)[0]?.id, "artifact-30", "the shelf should keep the newest result first");
assert.equal(recentArtifacts(timeline, MAX_SHELF_RESULTS).at(-1)?.id, "artifact-7", "the shelf should discard only artifacts outside its recent window");

assert.equal(canDownload(artifact({ uri: "file:///tmp/report.xlsx" })), true, "file-backed artifacts should be downloadable");
assert.equal(canDownload(artifact({ uri: "chef:artifact-1" })), false, "runtime-only artifacts should remain stored without a fake download action");
assert.equal(provenanceLabel(artifact()), "v2 · by worker-1 · task task-123", "artifact provenance should include version, producer, and bounded task ownership");
assert.equal(provenanceLabel(artifact({ taskId: undefined })), "v2 · by worker-1", "artifacts without task ownership should not invent provenance");

assert.equal(previewText(artifact({ metadata: { preview: "  preview wins  ", summary: "summary" } })), "preview wins", "producer preview text should take precedence and be trimmed");
assert.equal(previewText(artifact({ metadata: { summary: "summary fallback" } })), "summary fallback", "summary text should provide the next preview fallback");
assert.equal(previewText(artifact({ metadata: { description: "description fallback" } })), "description fallback", "description should remain a supported preview fallback");
assert.equal(previewText(artifact({ metadata: { content: "content fallback" } })), "content fallback", "content should remain the final preview fallback");
assert.equal(previewText(artifact({ metadata: { preview: "   " } })), null, "blank preview metadata should not create an empty preview surface");
const longPreview = previewText(artifact({ metadata: { preview: "x".repeat(900) } }));
assert.equal(longPreview?.length, 801, "preview text should remain bounded to 800 characters plus an ellipsis");
assert.equal(longPreview?.endsWith("…"), true, "truncated preview text should be visibly marked");

const rows = metadataRows(artifact({
  metadata: {
    preview: "hidden",
    summary: "hidden",
    description: "hidden",
    content: "hidden",
    alpha: "one",
    beta: 2,
    gamma: true,
    nil: null,
    object: { ignored: true },
    delta: "four",
    epsilon: "five",
    zeta: "six",
    eta: "seven",
    theta: "eight",
    iota: "nine",
  },
}));
assert.deepEqual(rows, [
  ["alpha", "one"],
  ["beta", "2"],
  ["gamma", "true"],
  ["delta", "four"],
  ["epsilon", "five"],
  ["zeta", "six"],
  ["eta", "seven"],
  ["theta", "eight"],
], "artifact metadata should expose only simple non-preview values and stay bounded to eight rows");

console.log("artifact-shelf-ui: ok - artifact projection is behaviorally bounded, ordered, inspectable, and provenance-aware");
