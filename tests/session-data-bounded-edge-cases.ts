import { strict as assert } from "node:assert";
import { boundSessionData } from "../src/runtime/session-data.ts";

const text = "header-" + "🙂".repeat(20_000) + "-tail";
const bounded = boundSessionData(text, 1024);

assert.equal(bounded.truncated, true);
assert.equal(bounded.originalBytes, Buffer.byteLength(text, "utf8"));
assert.ok(Buffer.byteLength(bounded.data, "utf8") <= 1024);
assert.ok(bounded.data.endsWith("-tail"));
assert.doesNotThrow(() => Buffer.from(bounded.data, "utf8"));

assert.throws(() => boundSessionData("x", 0), RangeError);
assert.throws(() => boundSessionData("x", 1.5), RangeError);

console.log("session-data-bounded-edge-cases: ok");
