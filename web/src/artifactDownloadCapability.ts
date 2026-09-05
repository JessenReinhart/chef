type CapabilityResponse = Pick<Response, "ok" | "status">;

type CapabilityRequester = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<CapabilityResponse>;

/**
 * Check whether an exact durable artifact can be downloaded as a file without
 * downloading it or triggering any desktop side effect.
 *
 * `null` means the capability is temporarily unknown and should be retried;
 * deterministic 4xx responses mean the artifact is not downloadable.
 */
export async function probeArtifactDownloadability(
  artifactId: string,
  requester: CapabilityRequester = fetch,
): Promise<boolean | null> {
  if (!artifactId.trim()) return false;

  try {
    const response = await requester(`/api/artifacts/${encodeURIComponent(artifactId)}/download`, {
      method: "HEAD",
    });
    if (response.ok) return true;
    if (response.status >= 400 && response.status < 500) return false;
    return null;
  } catch {
    return null;
  }
}
