import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const main = await readFile(new URL("../web/src/main.tsx", import.meta.url), "utf8");
const context = await readFile(new URL("../web/src/AgentContextInspector.tsx", import.meta.url), "utf8");

assert.match(main, /<AgentContextInspector \/>/, "living workspace should mount the agent context inspector feature");
assert.match(context, /What this agent knows/, "context inspector should use user-facing trust language");
assert.match(context, /\.react-flow__node\.selected/, "context inspector should follow the active living-workspace node selection");
assert.match(context, /\.power-inspector/, "context inspector should extend the active Power Mode inspector");
assert.match(context, /selectedNode\?\.kind !== "agent"/, "context disclosure should be limited to selected agent nodes");
assert.match(context, /api\.contextZones\(\)/, "context inspector should read runtime-owned Shared Context membership");
assert.match(context, /api\.stateRaw\(\)/, "context inspector should resolve current workspace provenance");
assert.match(context, /zone\.memberNodeIds\.includes\(selectedNodeId\)/, "only explicitly inherited Shared Context zones should be shown");
assert.match(context, /selectedTask\?\.contextRefs/, "task-specific context additions should remain inspectable");
assert.match(context, /describeContextReference/, "references should reuse the shared provenance resolver");
assert.match(context, /Stale or missing source/, "stale provenance should be visible instead of hidden");
assert.match(context, /MAX_CONTEXT_ROWS = 12/, "context disclosure should remain bounded");
assert.doesNotMatch(context, /dangerouslySetInnerHTML/, "context provenance must render as text");

console.log("agent-context-inspector-ui: ok - selected agents expose bounded context provenance");
