import { strict as assert } from "node:assert";
import { runDoctor, formatDoctor } from "../src/doctor.ts";

const windowsAccessible = new Set([
  "C:\\work\\chef",
  "C:\\bin\\git.exe",
  "C:\\tools\\claude.cmd",
  "C:\\tools\\codex.exe",
]);

const ready = await runDoctor({
  platform: "win32",
  nodeVersion: "24.7.0",
  cwd: "C:\\work\\chef",
  path: "C:\\bin;C:\\tools",
  canAccess: async (candidate) => {
    if (!windowsAccessible.has(candidate)) throw new Error("missing");
  },
});

assert.equal(ready.ok, true, "missing optional harnesses should not block Chef startup");
assert.equal(ready.checks.find((check) => check.id === "node")?.status, "pass");
assert.equal(ready.checks.find((check) => check.id === "git")?.status, "pass");
assert.equal(ready.checks.find((check) => check.id === "claude-code")?.status, "pass");
assert.equal(ready.checks.find((check) => check.id === "codex")?.status, "pass");
assert.equal(ready.checks.find((check) => check.id === "pi")?.status, "warn");
assert.match(formatDoctor(ready), /Environment is ready for Chef\./);

const blocked = await runDoctor({
  platform: "linux",
  nodeVersion: "22.14.0",
  cwd: "/work/chef",
  path: "/usr/bin:/opt/bin",
  canAccess: async (candidate) => {
    if (candidate !== "/work/chef") throw new Error("missing");
  },
});

assert.equal(blocked.ok, false, "unsupported Node should be a blocking diagnostic");
assert.equal(blocked.checks.find((check) => check.id === "node")?.status, "fail");
assert.equal(blocked.checks.find((check) => check.id === "workspace")?.status, "pass");
assert.equal(blocked.checks.find((check) => check.id === "git")?.status, "warn");
assert.match(formatDoctor(blocked), /Chef has blocking environment problems\./);

console.log("doctor: ok — cross-platform prerequisite and harness diagnostics are deterministic");
