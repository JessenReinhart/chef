import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const feature = await readFile(new URL("../web/src/LivingArtifactFeature.tsx", import.meta.url), "utf8");
const missionFeature = await readFile(new URL("../web/src/MissionArtifactsFeature.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/living-artifact.css", import.meta.url), "utf8");
const previewStyles = await readFile(new URL("../web/src/artifact-preview.css", import.meta.url), "utf8");

assert.match(feature, /Artifact shelf/, "Simple Mode should expose a durable artifact shelf");
assert.match(feature, /aria-expanded=\{shelfOpen\}/, "artifact shelf disclosure should expose its expanded state");
assert.match(feature, /MAX_VISIBLE_RESULTS = 4/, "spatial result projection should stay bounded");
assert.match(feature, /MAX_SHELF_RESULTS = 24/, "artifact shelf should remain bounded for large workspaces");
assert.match(feature, /SPATIAL_RESULT_SLOTS = \["near", "upper", "outer", "lower"\]/, "recent results should use deterministic presentation-only spatial slots");
assert.match(feature, /data-result-slot=\{SPATIAL_RESULT_SLOTS\[index\]\}/, "spatial slots should be projected without mutating artifact state");
assert.match(feature, /MAX_PREVIEW_LENGTH = 800/, "artifact previews should remain bounded");
assert.match(feature, /MAX_METADATA_ROWS = 8/, "artifact metadata disclosure should remain bounded");
assert.match(feature, /artifact\.taskId\.slice\(0, 8\)/, "artifact provenance should include task ownership when available");
assert.match(feature, /metadata\.preview/, "artifact preview should prefer producer-supplied preview text");
assert.match(feature, /metadata\.summary/, "artifact preview should fall back to producer-supplied summaries");
assert.match(feature, /Artifact preview for/, "artifact shelf should expose an inspectable preview surface");
assert.match(feature, /\/api\/artifacts\/\$\{encodeURIComponent\(artifact\.id\)\}\/download/, "file artifacts should keep the runtime-owned download path");
assert.match(feature, /EventSource\("\/api\/events\?types=artifact\.\*"\)/, "artifact shelf should refresh from artifact events");
assert.match(styles, /\.chef-result-card\[data-result-slot="near"\]/, "desktop results should have a near-work spatial slot");
assert.match(styles, /\.chef-result-card\[data-result-slot="lower"\]/, "desktop results should have a lower spatial slot");
assert.match(styles, /@media \(max-width: 980px\)/, "spatial results should collapse before narrow layouts become crowded");
assert.match(styles, /\.chef-artifact-shelf\s*\{/, "artifact shelf should have a dedicated workspace surface");
assert.match(previewStyles, /\.chef-artifact-preview\s*\{/, "artifact preview should have a dedicated inspectable surface");
assert.doesNotMatch(feature, /patchCanvas|updateArtifact|POST/, "friendly result placement must remain projection-only");
assert.doesNotMatch(feature, /dangerouslySetInnerHTML/, "artifact metadata and previews must render as text");

assert.match(missionFeature, /Mission artifacts/, "Mission overview should expose Mission-scoped durable outputs");
assert.match(missionFeature, /MAX_MISSION_ARTIFACTS = 6/, "Mission artifact disclosure should remain bounded");
assert.match(missionFeature, /new Set\(mission\.taskIds\)/, "Mission work records should derive scope from durable Mission task membership");
assert.match(missionFeature, /taskIds\.has\(artifact\.taskId\)/, "workspace artifacts should be filtered to the current Mission");
assert.match(missionFeature, /fetch\("\/api\/artifacts"\)/, "Mission artifacts should reuse the runtime-owned artifact projection");
assert.match(missionFeature, /\/api\/artifacts\/\$\{encodeURIComponent\(artifact\.id\)\}\/download/, "Mission file artifacts should preserve runtime-owned downloads");

assert.match(missionFeature, /Mission decisions/, "Mission overview should expose durable decisions tied to its tasks");
assert.match(missionFeature, /MAX_MISSION_DECISIONS = 6/, "Mission decision disclosure should remain bounded");
assert.match(missionFeature, /fetch\("\/api\/decisions"\)/, "Mission decisions should reuse the runtime-owned decision projection");
assert.match(missionFeature, /function decisionTaskId/, "Mission decision scope should require explicit task provenance");
assert.match(missionFeature, /const taskId = payload\.taskId/, "Mission decision provenance should come from the durable decision payload");
assert.match(missionFeature, /taskId !== null && taskIds\.has\(taskId\)/, "workspace decisions should be filtered to durable Mission task membership");
assert.match(missionFeature, /EventSource\("\/api\/events\?types=artifact\.\*,orchestrator\.task\.evaluated"\)/, "Mission work records should refresh from artifact and task-evaluation events through one stream");
assert.doesNotMatch(missionFeature, /mission\.createdAt.*decision\.timestamp|decision\.timestamp.*mission\.createdAt/, "Mission decisions must not be inferred from timestamps");
assert.doesNotMatch(missionFeature, /patchCanvas|updateArtifact|POST|dangerouslySetInnerHTML/, "Mission work-record projection must remain read-only and text-safe");

console.log("artifact-shelf-ui: ok - durable outputs and decisions remain bounded, inspectable, and Mission-scoped without owning runtime state");
