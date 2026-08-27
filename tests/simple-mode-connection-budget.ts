import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../web/src/main.tsx", import.meta.url));
const livingWorkspacePath = fileURLToPath(new URL("../web/src/LivingWorkspaceFeature.tsx", import.meta.url));
const livingArtifactPath = fileURLToPath(new URL("../web/src/LivingArtifactFeature.tsx", import.meta.url));

const [main, livingWorkspace, livingArtifact] = await Promise.all([
  readFile(mainPath, "utf8"),
  readFile(livingWorkspacePath, "utf8"),
  readFile(livingArtifactPath, "utf8"),
]);

const conditionalStart = main.indexOf("{runtimeDetailsVisible ? <>");
const simpleBranchStart = main.indexOf("</> : <>", conditionalStart);
const conditionalEnd = main.indexOf("</>}\n", simpleBranchStart);
assert.ok(conditionalStart >= 0 && simpleBranchStart > conditionalStart && conditionalEnd > simpleBranchStart,
  "workbench must explicitly separate power and simple surface mounts");

const powerBranch = main.slice(conditionalStart, simpleBranchStart);
const simpleBranch = main.slice(simpleBranchStart, conditionalEnd);

assert.match(powerBranch, /<App key="power" \/>/, "power mode owns the legacy/advanced App tree");
assert.doesNotMatch(simpleBranch, /<App\b/, "simple mode must not mount the hidden advanced App tree");
assert.match(simpleBranch, /<LivingWorkspaceFeature \/>/, "simple mode mounts the Living Workspace");
assert.match(simpleBranch, /<LivingArtifactFeature \/>/, "simple mode mounts the Living Artifact projection");
assert.doesNotMatch(simpleBranch, /<(ContextScopeFeature|CanvasNodeDeleteFeature|DecisionLibraryFeature|MissionArtifactsFeature|ChannelRoomsFeature|AgentContextInspector)\b/,
  "simple mode must not mount hidden power-mode projections that open their own streams/pollers");

const eventSourceCount = (livingWorkspace.match(/new EventSource\(/g) ?? []).length
  + (livingArtifact.match(/new EventSource\(/g) ?? []).length;
assert.ok(eventSourceCount <= 4,
  `simple mode must stay below the browser HTTP/1.1 per-origin connection ceiling; found ${eventSourceCount} EventSource streams`);

console.log(`simple-mode-connection-budget: ok — simple mode mounts only its active surfaces with ${eventSourceCount} SSE streams`);
