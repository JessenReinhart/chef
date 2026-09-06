export type ClipboardWriter = {
  writeText(text: string): Promise<void>;
};

export type CopyRunCommandResult =
  | { ok: true }
  | { ok: false; error: string };

export type ArtifactRevealResult =
  | { ok: true }
  | { ok: false; error: string };

export type ArtifactDownloadResult =
  | { ok: true; blob: Blob; fileName: string }
  | { ok: false; error: string };

export type ArtifactRevealDisplayState = "idle" | "opening" | "opened" | "error";

type RevealRequester = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "json">>;

type DownloadRequester = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "json" | "blob" | "headers">>;

type ArtifactRevealer = (artifactId: string, artifactVersion: number) => Promise<ArtifactRevealResult>;
type ArtifactDownloader = (artifactId: string, artifactVersion: number) => Promise<ArtifactDownloadResult>;
type VersionOwnedArtifactRevealer = (artifactId: string, artifactVersion: number, actionKey?: string) => Promise<ArtifactRevealResult>;
type VersionOwnedArtifactDownloader = (artifactId: string, artifactVersion: number, actionKey?: string) => Promise<ArtifactDownloadResult>;

/** Scope transient UI feedback to the exact durable result version it describes. */
export function artifactActionStateKey(artifactId: string, version: number): string {
  return `${artifactId}:${version}`;
}

function artifactActionHeaders(action: string, artifactVersion?: number): Record<string, string> {
  const headers: Record<string, string> = { "x-chef-action": action };
  if (artifactVersion !== undefined && Number.isInteger(artifactVersion) && artifactVersion > 0) {
    headers["x-chef-artifact-version"] = String(artifactVersion);
  }
  return headers;
}

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

/** Ask Chef to reveal the exact displayed durable artifact version without accepting a client path or command. */
export async function revealArtifact(
  artifactId: string,
  requester: RevealRequester = fetch,
  artifactVersion?: number,
): Promise<ArtifactRevealResult> {
  if (!artifactId.trim()) return { ok: false, error: "No result is available to reveal" };

  try {
    const response = await requester(`/api/artifacts/${encodeURIComponent(artifactId)}/reveal`, {
      method: "POST",
      headers: artifactActionHeaders("reveal-artifact", artifactVersion),
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

function downloadFileName(headers: Pick<Headers, "get">): string {
  const disposition = headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  let candidate = "chef-result";
  if (encoded) {
    try {
      candidate = decodeURIComponent(encoded);
    } catch {
      candidate = encoded;
    }
  } else {
    const plain = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
    if (plain) candidate = plain;
  }
  return candidate.split(/[\\/]/).filter(Boolean).at(-1) || "chef-result";
}

/** Download the exact displayed durable file result without navigating Simple Mode away on failure. */
export async function downloadArtifact(
  artifactId: string,
  requester: DownloadRequester = fetch,
  artifactVersion?: number,
): Promise<ArtifactDownloadResult> {
  if (!artifactId.trim()) return { ok: false, error: "No result is available to save" };

  try {
    const response = await requester(`/api/artifacts/${encodeURIComponent(artifactId)}/download`, {
      headers: artifactActionHeaders("download-artifact", artifactVersion),
    });
    if (!response.ok) {
      let message = "Could not save this result";
      try {
        const body = await response.json() as { error?: unknown };
        if (typeof body.error === "string" && body.error.trim()) {
          message = /does not point to a file/i.test(body.error)
            ? "This result is a folder. Use Show result to open it."
            : body.error.trim();
        }
      } catch {
        // Keep the stable user-facing fallback when the server response is not JSON.
      }
      return { ok: false, error: message };
    }

    return {
      ok: true,
      blob: await response.blob(),
      fileName: downloadFileName(response.headers),
    };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error && cause.message
        ? cause.message
        : "Could not save this result",
    };
  }
}

/**
 * Keep one reveal action in flight per exact result version.
 *
 * Opening a desktop file manager is an external side effect. Repeated clicks
 * for the same artifact version share that request, while a newly published
 * version gets its own version-bound action instead of inheriting an older
 * version's pending side effect.
 */
export function createSingleFlightArtifactRevealer(
  revealer: ArtifactRevealer = (artifactId, artifactVersion) => revealArtifact(artifactId, fetch, artifactVersion),
): VersionOwnedArtifactRevealer {
  const inFlight = new Map<string, Promise<ArtifactRevealResult>>();

  return (artifactId, artifactVersion, actionKey = artifactActionStateKey(artifactId, artifactVersion)) => {
    const existing = inFlight.get(actionKey);
    if (existing) return existing;

    const request = Promise.resolve()
      .then(() => revealer(artifactId, artifactVersion))
      .finally(() => {
        if (inFlight.get(actionKey) === request) inFlight.delete(actionKey);
      });
    inFlight.set(actionKey, request);
    return request;
  };
}

/** Keep one Save copy request in flight per exact result version while allowing later retries. */
export function createSingleFlightArtifactDownloader(
  downloader: ArtifactDownloader = (artifactId, artifactVersion) => downloadArtifact(artifactId, fetch, artifactVersion),
): VersionOwnedArtifactDownloader {
  const inFlight = new Map<string, Promise<ArtifactDownloadResult>>();

  return (artifactId, artifactVersion, actionKey = artifactActionStateKey(artifactId, artifactVersion)) => {
    const existing = inFlight.get(actionKey);
    if (existing) return existing;

    const request = Promise.resolve()
      .then(() => downloader(artifactId, artifactVersion))
      .finally(() => {
        if (inFlight.get(actionKey) === request) inFlight.delete(actionKey);
      });
    inFlight.set(actionKey, request);
    return request;
  };
}
