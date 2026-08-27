import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { workspaceSurfacePlan } from "../web/src/canonicalWorkspaceModel.ts";

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

console.log(`simple-mode-connection-budget: ok — depth behavior isolates advanced streams and keeps ${eventSourceCount} normal SSE streams`);
