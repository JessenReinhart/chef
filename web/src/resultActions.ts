export type ClipboardWriter = {
  writeText(text: string): Promise<void>;
};

export type CopyRunCommandResult =
  | { ok: true }
  | { ok: false; error: string };

/** Copy the exact durable run instruction and report failure truthfully. */
export async function copyRunCommand(
  command: string,
  clipboard: ClipboardWriter | null | undefined,
): Promise<CopyRunCommandResult> {
  if (!command.trim()) return { ok: false, error: "No run command is available" };
  if (!clipboard) return { ok: false, error: "Clipboard access is unavailable" };

  try {
    await clipboard.writeText(command);
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error && cause.message
        ? cause.message
        : "Could not copy the run command",
    };
  }
}
