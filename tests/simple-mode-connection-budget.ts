import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { workspaceSurfacePlan } from "../web/src/canonicalWorkspaceModel.ts";
import { createMissionProgressRefreshHub, missionProgressEventStreamUrl } from "../web/src/missionProgressStream.ts";

const livingWorkspacePath = fileURLToPath(new URL("../web/src/LivingWorkspaceFeature.tsx", import.meta.url));
const livingArtifactPath = fileURLToPath(new URL("../web/src/LivingArtifactFeature.tsx", import.meta.url));
const [livingWorkspace, livingArtifact] = await Promise.all([
  readFile(livingWorkspacePath, "utf8"),
  readFile(livingArtifactPath, "utf8"),
]);

const simple = workspaceSurfacePlan("simple");
assert.equal(simple.runtimeApp, false, "normal depth must not activate the advanced streaming tree");
assert.equal(simple.rooms, false, "Rooms must not consume a hidden connection in normal depth");
assert.equal(simple.agentContext, false, "agent inspection must not consume a hidden connection in normal depth");
assert.equal(simple.livingWorkspace, true);
assert.equal(simple.livingArtifacts, true);

// Counting persistent EventSource constructors is a static architecture check,
// not a product-shape assertion: the HTTP/1.1 browser connection ceiling is the
// invariant that previously caused normal POST requests to queue indefinitely.
const eventSourceCount = (livingWorkspace.match(/new EventSource\(/g) ?? []).length
  + (livingArtifact.match(/new EventSource\(/g) ?? []).length;
assert.ok(eventSourceCount <= 4,
  `normal workspace must stay below the browser per-origin SSE budget; found ${eventSourceCount} EventSource streams`);

let openedStreams = 0;
let closedStreams = 0;
let requestedUrl = "";
const fakeStream = {
  onmessage: null as ((event: MessageEvent) => void) | null,
  close() { closedStreams += 1; },
};
const subscribeSharedProgress = createMissionProgressRefreshHub((url) => {
  openedStreams += 1;
  requestedUrl = url;
  return fakeStream;
});
let activityRefreshes = 0;
let resultRefreshes = 0;
const unsubscribeActivity = subscribeSharedProgress(() => { activityRefreshes += 1; });
const unsubscribeResults = subscribeSharedProgress(() => { resultRefreshes += 1; });

assert.equal(openedStreams, 1, "Simple Mode progress projections must share one worker-aware EventSource instead of opening duplicates");
assert.equal(requestedUrl, missionProgressEventStreamUrl());
assert.ok(fakeStream.onmessage, "the shared progress hub must attach its runtime event handler");
fakeStream.onmessage?.({} as MessageEvent);
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(activityRefreshes, 1, "the activity projection must receive shared runtime evidence");
assert.equal(resultRefreshes, 1, "the result projection must receive the same shared runtime evidence");
unsubscribeActivity();
assert.equal(closedStreams, 0, "the shared EventSource must stay open while another Simple Mode projection is mounted");
unsubscribeResults();
assert.equal(closedStreams, 1, "the final subscriber must release the shared EventSource");

console.log(`simple-mode-connection-budget: ok — depth behavior isolates advanced streams, keeps ${eventSourceCount} normal SSE streams, and shares the worker-aware progress connection`);
