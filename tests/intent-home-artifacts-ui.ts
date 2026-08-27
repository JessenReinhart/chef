import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const main = await readFile(new URL("../web/src/main.tsx", import.meta.url), "utf8");
const artifacts = await readFile(new URL("../web/src/LivingArtifactFeature.tsx", import.meta.url), "utf8");
const projection = await readFile(new URL("../web/src/artifactProjection.ts", import.meta.url), "utf8");

assert.match(main, /<LivingArtifactFeature \/>/, "the canonical Living Workspace must mount its durable result projection");
assert.doesNotMatch(main, /<HomeMissionArtifacts \/>/, "artifacts must not require the retired Intent Home surface");
assert.match(artifacts, /fetch\("\/api\/artifacts"\)/, "Living Workspace results must reuse the canonical durable artifact API");
assert.match(artifacts, /document\.querySelector\("\.chef-living-stage"\)/, "results must render inside the same Living Workspace instead of a second page");
assert.match(artifacts, /recentArtifacts\(artifacts, MAX_VISIBLE_RESULTS\)/, "default result cards must remain bounded");
assert.match(artifacts, /recentArtifacts\(artifacts, MAX_SHELF_RESULTS\)/, "the expanded result shelf must remain bounded");
assert.match(artifacts, /artifact\.uri/, "result cards must preserve durable artifact location/provenance");
assert.match(artifacts, /canDownload\(artifact\)/, "download affordances must be derived from the artifact contract");
assert.match(artifacts, /\/api\/artifacts\/\$\{encodeURIComponent\(artifact\.id\)\}\/download/, "downloads must reuse the canonical artifact endpoint");
assert.match(artifacts, /Artifact shelf/, "older durable results must remain inspectable from the same workspace");
assert.match(artifacts, /Artifact preview/, "results must be inspectable without leaving the canonical workspace");
assert.match(artifacts, /new EventSource\("\/api\/events\?types=artifact\.\*"\)/, "artifact changes must refresh promptly while the Living Workspace is active");
assert.match(artifacts, /if \(!enabled\)/, "the result projection must release its surface when runtime details replace the Living Workspace");
assert.match(projection, /export function recentArtifacts/, "artifact ordering and bounding must remain a shared deterministic projection");

console.log("intent-home-artifacts-ui: ok — durable results stay inside the canonical Living Workspace");
