import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const feature = await readFile(new URL("../web/src/LivingArtifactFeature.tsx", import.meta.url), "utf8");
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

console.log("artifact-shelf-ui: ok - Simple Mode keeps durable outputs spatial, previewable, and inspectable without owning runtime geometry");
