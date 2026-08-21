import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const feature = await readFile(new URL("../web/src/ChannelRoomsFeature.tsx", import.meta.url), "utf8");
const main = await readFile(new URL("../web/src/main.tsx", import.meta.url), "utf8");

assert.match(feature, /chef:view-mode.*power/, "rooms should stay behind Advanced mode");
assert.match(feature, /\/api\/messages\/channels/, "rooms should use the runtime channel index");
assert.match(feature, /\/api\/messages\?channel=/, "room contents should use durable channel messages");
assert.match(feature, /encodeURIComponent\(channel\)/, "channel names must be URL encoded");
assert.match(feature, /Rooms are a lightweight view over Chef's durable agent messages/, "empty state should explain projection semantics");
assert.match(feature, /method:\s*["']POST["']/, "rooms should expose the bounded human message write path");
assert.match(feature, /Message .* as human/, "composer should clearly identify human-authored messages");
assert.match(feature, /ctrlKey.*metaKey|metaKey.*ctrlKey/s, "composer should support Ctrl\/Cmd+Enter submission");
assert.match(main, /<ChannelRoomsFeature\s*\/?>/, "rooms feature should be mounted in the product shell");

console.log("channel-rooms-ui: ok — Advanced mode can browse rooms and send bounded human messages");
