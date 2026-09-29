import { strict as assert } from "node:assert";
import { artifactHandoff } from "../web/src/artifactHandoff.ts";

for (const [uri, resultLocation] of [
  ["https://example.com/result", undefined],
  ["file://fileserver/share/todo-app", undefined],
  ["sideband://result", "https://example.com/result"],
  ["sideband://result", "//fileserver/share/todo-app"],
  ["sideband://result", "\\\\fileserver\\share\\todo-app"],
] as const) {
  const handoff = artifactHandoff({ uri, metadata: { ...(resultLocation ? { resultLocation } : {}), run: "npm start" } });
  assert.equal(handoff.runCommand, null, `non-revealable result ${JSON.stringify(resultLocation ?? uri)} must not expose Run`);
}

for (const [uri, resultLocation] of [
  ["file:///tmp/chef-project/todo-app", undefined],
  ["file://localhost/tmp/chef-project/todo-app", undefined],
  ["file:///C:/Work/chef/todo-app", undefined],
  ["sideband://result", "dist/todo-app"],
  ["sideband://result", "C:\\Work\\chef\\todo-app"],
] as const) {
  const handoff = artifactHandoff({ uri, metadata: { ...(resultLocation ? { resultLocation } : {}), run: "npm start" } });
  assert.equal(handoff.runCommand, "npm start", `revealable result ${JSON.stringify(resultLocation ?? uri)} must retain Run`);
}

console.log("artifact run/reveal coupling behavior passed");
