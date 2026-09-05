type CapabilityResponse = Pick<Response, "ok" | "status" | "headers">;

type CapabilityRequester = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<CapabilityResponse>;

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
