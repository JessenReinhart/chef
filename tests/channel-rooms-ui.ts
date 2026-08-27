import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const feature = await readFile(new URL("../web/src/ChannelRoomsFeature.tsx", import.meta.url), "utf8");
const main = await readFile(new URL("../web/src/main.tsx", import.meta.url), "utf8");

assert.doesNotMatch(feature, /chef:view-mode.*power/, "rooms should not own the Living Workspace depth switch");
assert.match(feature, /\/api\/messages\/channels/, "rooms should use the runtime channel index");
assert.match(feature, /\/api\/messages\?channel=/, "room contents should use durable channel messages");
assert.match(feature, /encodeURIComponent\(channel\)/, "channel names must be URL encoded");
assert.match(feature, /Rooms are a lightweight view over Chef's durable agent messages/, "empty state should explain projection semantics");
assert.match(feature, /method:\s*["']POST["']/, "rooms should expose the bounded human message write path");
assert.match(feature, /Message .* as human/, "composer should clearly identify human-authored messages");
assert.match(feature, /ctrlKey.*metaKey|metaKey.*ctrlKey/s, "composer should support Ctrl\/Cmd+Enter submission");

const powerStart = main.indexOf("{runtimeDetailsVisible ? <>");
const simpleStart = main.indexOf("</> : <>", powerStart);
assert.ok(powerStart >= 0 && simpleStart > powerStart, "Chef must keep explicit runtime-detail and Living Workspace depths");
const powerBranch = main.slice(powerStart, simpleStart);
const simpleBranch = main.slice(simpleStart);
assert.match(powerBranch, /<ChannelRoomsFeature\s*\/?>/, "Rooms should remain available under Runtime details");
assert.doesNotMatch(simpleBranch, /<ChannelRoomsFeature\s*\/?>/, "Rooms must not compete with outcome-first controls in the canonical Living Workspace");
assert.doesNotMatch(main, /if \(surface === "home"\)/, "Rooms depth must not depend on a separate Home application");

console.log("channel-rooms-ui: ok — Rooms stay available as runtime detail without creating a second Chef surface");
