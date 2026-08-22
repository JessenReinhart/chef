import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const feature = await readFile(new URL("../web/src/ChannelRoomsFeature.tsx", import.meta.url), "utf8");
const main = await readFile(new URL("../web/src/main.tsx", import.meta.url), "utf8");

assert.doesNotMatch(feature, /chef:view-mode.*power/, "rooms should no longer depend on the legacy Simple/Power persona switch");
assert.match(feature, /\/api\/messages\/channels/, "rooms should use the runtime channel index");
assert.match(feature, /\/api\/messages\?channel=/, "room contents should use durable channel messages");
assert.match(feature, /encodeURIComponent\(channel\)/, "channel names must be URL encoded");
assert.match(feature, /Rooms are a lightweight view over Chef's durable agent messages/, "empty state should explain projection semantics");
assert.match(feature, /method:\s*["']POST["']/, "rooms should expose the bounded human message write path");
assert.match(feature, /Message .* as human/, "composer should clearly identify human-authored messages");
assert.match(feature, /ctrlKey.*metaKey|metaKey.*ctrlKey/s, "composer should support Ctrl\/Cmd+Enter submission");
assert.match(main, /<ChannelRoomsFeature\s*\/?>/, "rooms feature should remain mounted in the Workbench shell");
assert.match(main, /if \(surface === "home"\)/, "Chef Home should remain a separate surface so Rooms stay at Workbench depth");

console.log("channel-rooms-ui: ok — Workbench can browse rooms and send bounded human messages without legacy persona gating");
