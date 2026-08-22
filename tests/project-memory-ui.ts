import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../web/src/DecisionLibraryFeature.tsx", import.meta.url), "utf8");

assert.match(source, /fetch\("\/api\/memory"\)/, "knowledge library should read the runtime-owned memory projection");
assert.match(source, /Project memory/, "knowledge library should expose a project-memory view");
assert.match(source, /Decisions/, "existing durable decision browsing should remain available");

for (const label of [
  "Requirements",
  "Known Facts",
  "Conventions",
  "Lessons",
  "Open Questions",
  "Reusable Procedures",
]) {
  assert.ok(source.includes(label), `project memory should expose ${label}`);
}

assert.match(source, /fetch\("\/api\/decisions",\s*\{[\s\S]*?method:\s*"POST"/, "knowledge library should use the runtime-owned decision write path for memory capture");
assert.match(source, /captureType:\s*"requirement"/, "requirements should map to the runtime memory category contract");
assert.match(source, /captureType:\s*"knownFact"/, "known facts should map to the runtime memory category contract");
assert.match(source, /captureType:\s*"openQuestion"/, "open questions should map to the runtime memory category contract");
assert.match(source, /captureType:\s*"reusableProcedure"/, "procedures should map to the runtime memory category contract");
assert.match(source, /maxLength=\{2000\}/, "human memory capture should respect the runtime summary bound");
assert.match(source, /Record memory/, "project memory should expose an explicit capture action");
assert.match(source, /Saved as proposed until resolved/, "open-question capture should explain its proposed status");
assert.match(source, /Saved as accepted human-authored project memory/, "durable memory capture should explain accepted human provenance");
assert.match(source, /const next = await loadMemory\(\)/, "successful capture should refresh the runtime-owned projection");
assert.match(source, /setSelectedId\(created\.id\)/, "successful capture should select the newly created durable record");

assert.match(source, /Empty categories stay empty instead of being synthesized/, "empty memory categories should remain honest projections");
assert.match(source, /Made by/, "memory details should preserve provenance");
assert.match(source, /Recorded/, "memory details should preserve timestamps");

console.log("project-memory-ui: ok — inspectable runtime memory supports bounded human capture");
