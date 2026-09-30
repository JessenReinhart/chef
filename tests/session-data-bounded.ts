import { strict as assert } from "node:assert";
import { boundSessionData } from "../src/runtime/session-data.ts";

const noisy = "🙂".repeat(20_000);
const result = boundSessionData(noisy);

assert.equal(result.truncated, true);
assert.ok(Buffer.byteLength(result.data, "utf8") <= 32 * 1024);
assert.equal(result.originalBytes, Buffer.byteLength(noisy, "utf8"));
console.log("session-data-bounded: ok");
