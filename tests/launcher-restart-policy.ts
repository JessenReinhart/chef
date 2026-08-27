import { strict as assert } from "node:assert";
import { shouldRejectOtherProjectRuntime } from "../scripts/launcher-policy.mjs";

assert.equal(shouldRejectOtherProjectRuntime({
  existingProjectPath: "/home/jessen/brain",
  currentProjectPath: "/home/jessen/chef",
  restart: true,
  platform: "linux",
}), false, "--restart must be allowed to replace a Chef runtime serving another project");

assert.equal(shouldRejectOtherProjectRuntime({
  existingProjectPath: "/home/jessen/brain",
  currentProjectPath: "/home/jessen/chef",
  restart: false,
  platform: "linux",
}), true, "without --restart, Chef must refuse to steal another project's runtime");

assert.equal(shouldRejectOtherProjectRuntime({
  existingProjectPath: "/home/jessen/chef",
  currentProjectPath: "/home/jessen/chef",
  restart: false,
  platform: "linux",
}), false, "the current project's runtime is not a cross-project conflict");

assert.equal(shouldRejectOtherProjectRuntime({
  existingProjectPath: "C:\\Work\\Chef",
  currentProjectPath: "c:\\work\\chef",
  restart: false,
  platform: "win32",
}), false, "Windows project comparison must remain case-insensitive");

console.log("launcher-restart-policy: ok");
