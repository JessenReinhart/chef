import { strict as assert } from "node:assert";
import { DefaultTerminalHarness, defaultTerminalCommand } from "../src/harness/default-terminal.ts";

assert.equal(
  defaultTerminalCommand("win32", { COMSPEC: "C:\\Windows\\System32\\cmd.exe" }),
  "C:\\Windows\\System32\\cmd.exe",
  "Windows should use COMSPEC when it is configured",
);
assert.equal(defaultTerminalCommand("win32", {}), "cmd.exe", "Windows should fall back to cmd.exe");
assert.equal(defaultTerminalCommand("linux", { SHELL: "/bin/bash" }), "/bin/bash", "POSIX should use SHELL when configured");
assert.equal(defaultTerminalCommand("linux", {}), "/bin/sh", "POSIX should fall back to /bin/sh");

const harness = new DefaultTerminalHarness({ workspaceId: "test", cwd: process.cwd() });
assert.equal(harness.command, defaultTerminalCommand(), "generic terminal should expose the current OS shell command");
assert.equal(await harness.detect(), true, `default terminal shell should be executable: ${harness.command}`);
await harness.close();

console.log(`default-terminal: ok — ${process.platform} uses ${harness.command}`);
