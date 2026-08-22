import { strict as assert } from "node:assert";
import { HarnessRegistry, type DetectableHarness } from "../src/runtime/harness-registry.ts";

function fakeHarness(input: { id: string; type: string; name: string; command: string; available: boolean; taskCapable?: boolean }): DetectableHarness {
  return {
    id: input.id,
    type: input.type,
    name: input.name,
    command: input.command,
    args: [],
    cwd: process.cwd(),
    taskCapable: input.taskCapable,
    detect: async () => input.available,
    spawn: async () => ({ id: "session", pid: 1 }),
    writeContextRefs: async () => "",
    writeMessage: async () => "",
    events: async function* () {},
    send: async () => undefined,
    interrupt: async () => undefined,
    resize: async () => undefined,
    terminate: async () => undefined,
    forget: async () => undefined,
    close: async () => undefined,
  };
}

const registry = new HarnessRegistry({ includeDefaults: false });
registry.register("ready", "Ready CLI", () => fakeHarness({ id: "ready", type: "coding-agent", name: "Ready CLI", command: "ready-cli", available: true, taskCapable: true }));
registry.register("missing", "Missing CLI", () => fakeHarness({ id: "missing", type: "coding-agent", name: "Missing CLI", command: "missing-cli", available: false }));

const first = await registry.initialize();
assert.deepEqual(first, [
  { id: "ready", name: "Ready CLI", type: "coding-agent", command: "ready-cli", available: true, taskCapable: true },
  { id: "missing", name: "Missing CLI", type: "coding-agent", command: "missing-cli", available: false, taskCapable: false },
]);
assert.equal(registry.get("ready")?.command, "ready-cli");
assert.equal(registry.get("missing"), undefined);
assert.deepEqual(registry.taskCapableIds(), ["ready"]);

const cached = registry.detections();
assert.deepEqual(cached, first, "registry should retain the last discovery snapshot");
cached[0].command = "mutated";
assert.equal(registry.detections()[0].command, "ready-cli", "callers must not mutate cached discovery state");

await registry.close();
console.log("harness-discovery-metadata: ok");
