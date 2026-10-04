import { strict as assert } from "node:assert";
import { boundSessionData } from "../src/runtime/session-data.ts";

const sample = "prefix-" + "🙂".repeat(10_000) + "-suffix";
const result = boundSessionData(sample, 2048);

assert.equal(result.truncated, true);
assert.equal(result.originalBytes, Buffer.byteLength(sample, "utf8"));
assert.ok(Buffer.byteLength(result.data, "utf8") <= 2048);
assert.ok(result.data.endsWith("-suffix"));

console.log("session-data-bounded-runtime-contract: ok");
