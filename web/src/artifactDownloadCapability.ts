type CapabilityResponse = Pick<Response, "ok" | "status" | "headers">;

type CapabilityRequester = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<CapabilityResponse>;

type CapabilityWatcherOptions = {
  requester?: CapabilityRequester;
  retryDelayMs?: number;
};

/**
 * Check whether an exact durable artifact version can be downloaded as a file
 * without downloading it or triggering any desktop side effect.
 *
 * `null` means the capability is temporarily unknown and should be retried;
 * deterministic 4xx responses mean the artifact is not downloadable.
 */
export async function probeArtifactDownloadability(
  artifactId: string,
  artifactVersion: number,
  requester: CapabilityRequester = fetch,
): Promise<boolean | null> {
  if (!artifactId.trim() || !Number.isFinite(artifactVersion)) return false;

  try {
    const response = await requester(`/api/artifacts/${encodeURIComponent(artifactId)}/download`, {
      method: "HEAD",
      headers: { "x-chef-artifact-version": String(artifactVersion) },
    });
    if (response.ok) {
      return response.headers.get("x-chef-artifact-version") === String(artifactVersion) ? true : null;
    }
    if (response.status >= 400 && response.status < 500) return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * Keep probing through transient/network uncertainty until the exact artifact
 * version resolves to a durable yes/no answer. Returns a cancellation hook for
 * callers whose visible artifact set changes while a retry is pending.
 */
export function watchArtifactDownloadability(
  artifactId: string,
  artifactVersion: number,
  onResolved: (downloadable: boolean) => void,
  options: CapabilityWatcherOptions = {},
): () => void {
  const requester = options.requester ?? fetch;
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 2_000);
  let cancelled = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const probe = async () => {
    const downloadable = await probeArtifactDownloadability(artifactId, artifactVersion, requester);
    if (cancelled) return;
    if (downloadable === null) {
      retryTimer = setTimeout(() => void probe(), retryDelayMs);
      return;
    }
    onResolved(downloadable);
  };

  void probe();
  return () => {
    cancelled = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
  };
}
