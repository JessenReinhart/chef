import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const main = await readFile(new URL("../web/src/main.tsx", import.meta.url), "utf8");
const home = await readFile(new URL("../web/src/IntentHome.tsx", import.meta.url), "utf8");

assert.match(main, /localStorage\.getItem\("chef:surface"\) === "workbench" \? "workbench" : "home"/, "fresh Chef sessions should default to the intent home");
assert.match(main, /if \(surface === "home"\)/, "home and Workbench must be explicit product surfaces");
assert.match(main, /<IntentHome onOpenWorkbench=\{openWorkbench\} \/>/, "the default surface should mount the intent-first home");
assert.match(main, /<App key=\{viewMode\} \/>/, "the existing graph UI should remain available as the Workbench");
assert.match(home, /What are we doing\?/, "the home should lead with user intent rather than graph controls");
assert.match(home, /api\.chat\(message\)/, "the primary composer must use the existing Orchestrator chat path");
assert.match(home, /Open Workbench/, "advanced inspection should stay deliberately reachable");
assert.match(home, /Needs your attention/, "approval and failure states should be surfaced in plain language");
assert.match(home, /Chef is working/, "active work should collapse to a human-readable status");
assert.match(home, /Work complete/, "completed work should collapse to a human-readable status");
assert.doesNotMatch(home, /NodePalette|ChannelRooms|AgentContextInspector|Power Mode|PTY|sessionId/, "default home must not expose Workbench/runtime machinery");

const chatCalls = home.match(/api\.chat\(/g) ?? [];
assert.equal(chatCalls.length, 1, "the default home should have one authoritative Chef intent submission path");

console.log("intent-home-ui: ok — Chef defaults to one intent surface with Workbench behind progressive depth");
