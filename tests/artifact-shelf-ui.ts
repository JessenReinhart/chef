import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const feature = await readFile(new URL("../web/src/LivingArtifactFeature.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/living-artifact.css", import.meta.url), "utf8");

assert.match(feature, /Artifact shelf/, "Simple Mode should expose a durable artifact shelf");
assert.match(feature, /aria-expanded=\{shelfOpen\}/, "artifact shelf disclosure should expose its expanded state");
assert.match(feature, /MAX_SHELF_RESULTS = 24/, "artifact shelf should remain bounded for large workspaces");
assert.match(feature, /artifact\.taskId\.slice\(0, 8\)/, "artifact provenance should include task ownership when available");
assert.match(feature, /\/api\/artifacts\/\$\{encodeURIComponent\(artifact\.id\)\}\/download/, "file artifacts should keep the runtime-owned download path");
assert.match(feature, /EventSource\("\/api\/events\?types=artifact\.\*"\)/, "artifact shelf should refresh from artifact events");
assert.match(styles, /\.chef-artifact-shelf\s*\{/, "artifact shelf should have a dedicated workspace surface");
assert.doesNotMatch(feature, /dangerouslySetInnerHTML/, "artifact metadata must render as text");

console.log("artifact-shelf-ui: ok - Simple Mode keeps durable outputs inspectable without switching modes");
