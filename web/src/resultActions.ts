export type ClipboardWriter = {
  writeText(text: string): Promise<void>;
};

export type CopyRunCommandResult =
  | { ok: true }
  | { ok: false; error: string };

export type ArtifactRevealResult =
  | { ok: true }
  | { ok: false; error: string };

type RevealRequester = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "json">>;

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

/** Ask Chef to reveal a durable artifact location without accepting a client path or command. */
export async function revealArtifact(
  artifactId: string,
  requester: RevealRequester = fetch,
): Promise<ArtifactRevealResult> {
  if (!artifactId.trim()) return { ok: false, error: "No result is available to reveal" };

  try {
    const response = await requester(`/api/artifacts/${encodeURIComponent(artifactId)}/reveal`, {
      method: "POST",
      headers: { "x-chef-action": "reveal-artifact" },
    });
    if (response.ok) return { ok: true };

    let message = "Could not show this result in its folder";
    try {
      const body = await response.json() as { error?: unknown };
      if (typeof body.error === "string" && body.error.trim()) message = body.error.trim();
    } catch {
      // Keep the stable user-facing fallback when the server response is not JSON.
    }
    return { ok: false, error: message };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error && cause.message
        ? cause.message
        : "Could not show this result in its folder",
    };
  }
}
