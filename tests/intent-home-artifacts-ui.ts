import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const main = await readFile(new URL("../web/src/main.tsx", import.meta.url), "utf8");
const artifacts = await readFile(new URL("../web/src/HomeMissionArtifacts.tsx", import.meta.url), "utf8");
const threadApi = await readFile(new URL("../web/src/threadApi.ts", import.meta.url), "utf8");

assert.match(main, /<HomeMissionArtifacts \/>/, "Simple Mode must mount the current-Mission artifact projection");
assert.match(artifacts, /fetch\("\/api\/artifacts"\)/, "Home artifacts must reuse the canonical durable artifact API");
assert.match(artifacts, /candidate\.metadata\?\.threadId === selectedThreadId/, "artifact Mission selection must stay inside the selected Thread");
assert.match(artifacts, /sort\(\(a, b\) => b\.createdAt - a\.createdAt\)\[0\]/, "artifact projection must use Mission creation chronology for current work");
assert.match(artifacts, /const taskIds = new Set\(mission\.taskIds\)/, "artifact projection must derive the current Mission task boundary");
assert.match(artifacts, /artifact\.taskId && taskIds\.has\(artifact\.taskId\)/, "sibling and prior-Mission artifacts must not leak onto Home");
assert.match(artifacts, /\.slice\(-MAX_HOME_ARTIFACTS\)\s+\.reverse\(\)/, "Home artifact output must remain bounded and newest-first");
assert.match(artifacts, /metadata\.summary \?\? artifact\.metadata\.preview \?\? artifact\.metadata\.description/, "artifact cards should prefer human-readable summary metadata");
assert.match(artifacts, /artifact\.uri\.startsWith\("file:"\)/, "only file-backed artifacts should expose download actions");
assert.match(artifacts, /\/api\/artifacts\/\$\{encodeURIComponent\(artifact\.id\)\}\/download/, "Home downloads must reuse the canonical artifact endpoint");
assert.match(artifacts, /Mission outputs are temporarily unavailable/, "artifact failure must degrade locally instead of breaking Home");
assert.match(threadApi, /SELECTED_THREAD_EVENT = "chef:selected-thread-changed"/, "Thread selection changes must have an immediate projection signal");
assert.match(threadApi, /previous !== threadId/, "selection events must not fire for unchanged selection");
assert.match(threadApi, /window\.dispatchEvent\(new CustomEvent\(SELECTED_THREAD_EVENT/, "saving a new Thread selection must notify sibling Home projections");
assert.match(artifacts, /window\.addEventListener\(THREAD_SELECTION_EVENT, onThreadChanged\)/, "artifact projection must refresh immediately when the selected Thread changes");

console.log("intent-home-artifacts-ui: ok");