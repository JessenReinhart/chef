export type ClipboardWriter = {
  writeText(text: string): Promise<void>;
};

export type CopyRunCommandResult =
  | { ok: true }
  | { ok: false; error: string };

export type ArtifactRevealResult =
  | { ok: true }
  | { ok: false; error: string };

export type ArtifactRevealDisplayState = "idle" | "opening" | "opened" | "error";

type RevealRequester = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "json">>;

type ArtifactRevealer = (artifactId: string) => Promise<ArtifactRevealResult>;

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

export function artifactRevealLabel(state: ArtifactRevealDisplayState): string {
  if (state === "opening") return "Opening…";
  if (state === "opened") return "Result shown";
  return "Show result";
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

    let message = "Could not show this result";
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
        : "Could not show this result",
    };
  }
}

/**
 * Keep one reveal action in flight per durable artifact.
 *
 * Opening a desktop file manager is an external side effect. Repeated clicks
 * while the first request is still pending must share that request instead of
 * spawning duplicate windows. A settled action is removed so a later retry is
 * still possible after success or failure.
 */
export function createSingleFlightArtifactRevealer(
  revealer: ArtifactRevealer = revealArtifact,
): ArtifactRevealer {
  const inFlight = new Map<string, Promise<ArtifactRevealResult>>();

  return (artifactId) => {
    const existing = inFlight.get(artifactId);
    if (existing) return existing;

    const request = Promise.resolve()
      .then(() => revealer(artifactId))
      .finally(() => {
        if (inFlight.get(artifactId) === request) inFlight.delete(artifactId);
      });
    inFlight.set(artifactId, request);
    return request;
  };
}
