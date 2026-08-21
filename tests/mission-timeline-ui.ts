import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const panel = await readFile(new URL("../web/src/MissionPanel.tsx", import.meta.url), "utf8");
const timeline = await readFile(new URL("../web/src/MissionTimelineFeature.tsx", import.meta.url), "utf8");

assert.match(panel, /MissionTimelineFeature missionId=\{mission\.id\} mode=\{mode\}/, "Mission overview should mount the timeline for the active Mission");
assert.match(timeline, /\/api\/missions\/\$\{encodeURIComponent\(missionId\)\}\/timeline/, "timeline should use the runtime-owned Mission timeline projection");
assert.match(timeline, /events\.slice\(-8\)\.reverse\(\)/, "timeline should show a bounded newest-first activity window");
assert.match(timeline, /Meaningful Mission activity, newest first\./, "Simple Mode should frame the surface as meaningful activity instead of raw logs");
assert.match(timeline, /mode === "power"/, "Power Mode should retain technical event metadata");
assert.match(timeline, /Mission history is temporarily unavailable\./, "timeline failures should degrade honestly without breaking Mission controls");
assert.doesNotMatch(timeline, /dangerouslySetInnerHTML/, "event payloads must render as text, not executable HTML");

console.log("mission-timeline-ui: ok — Mission history is visible with progressive disclosure");
