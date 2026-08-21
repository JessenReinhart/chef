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

assert.match(source, /Empty categories stay empty instead of being synthesized/, "empty memory categories should remain honest projections");
assert.match(source, /Made by/, "memory details should preserve provenance");
assert.match(source, /Recorded/, "memory details should preserve timestamps");
assert.doesNotMatch(source, /fetch\("\/api\/memory"[\s\S]{0,200}method:\s*"POST"/, "project memory UI should remain read-only");

console.log("project-memory-ui: ok — inspectable runtime memory is exposed without a write path");
