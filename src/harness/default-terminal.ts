import { SpecializedCliHarness } from "./specialized.ts";

export function defaultTerminalCommand(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  if (platform === "win32") {
    const command = env.COMSPEC?.trim();
    return command || "cmd.exe";
  }

  const shell = env.SHELL?.trim();
  return shell || "/bin/sh";
}

/** Generic interactive terminal backed by the user's default operating-system shell. */
export class DefaultTerminalHarness extends SpecializedCliHarness {
  constructor(runtime: { workspaceId?: string; cwd?: string } = {}) {
    super({
      id: "generic",
      type: "generic",
      name: "Generic Terminal",
      binary: defaultTerminalCommand(),
      workspaceId: runtime.workspaceId,
      cwd: runtime.cwd,
    });
  }
}
