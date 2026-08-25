export type ArtifactHandoffInput = {
  uri: string;
  metadata: Record<string, unknown>;
};

export type ArtifactHandoff = {
  location: string | null;
  runCommand: string | null;
  verification: string | null;
};

function firstText(metadata: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function fileUriLocation(uri: string): string | null {
  if (!uri.startsWith("file:")) return null;
  try {
    const url = new URL(uri);
    let pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
    if (url.host) return `//${url.host}${pathname}`;
    return pathname || null;
  } catch {
    return null;
  }
}

/**
 * Project result metadata is optional, so Simple Mode degrades gracefully while
 * still exposing a file URI when that is the only durable location available.
 */
export function artifactHandoff(artifact: ArtifactHandoffInput): ArtifactHandoff {
  const explicitLocation = firstText(artifact.metadata, ["resultLocation", "path", "location"]);
  const runCommand = firstText(artifact.metadata, ["run", "runCommand", "command"]);
  const verifiedBy = firstText(artifact.metadata, ["verifiedBy"]);
  const verification = firstText(artifact.metadata, ["verification", "verified"])
    ?? (verifiedBy ? `Verified by ${verifiedBy}` : null);

  return {
    location: explicitLocation ?? fileUriLocation(artifact.uri),
    runCommand,
    verification,
  };
}
