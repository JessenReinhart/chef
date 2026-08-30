export type ArtifactHandoffInput = {
  name?: string;
  uri: string;
  metadata: Record<string, unknown>;
};

export type ArtifactHandoff = {
  summary: string | null;
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

function compactSummary(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 140 ? normalized : `${normalized.slice(0, 137)}…`;
}

function hasFileScheme(value: string): boolean {
  return /^file:/i.test(value);
}

export function isFileUriArtifact(artifact: Pick<ArtifactHandoffInput, "uri">): boolean {
  return hasFileScheme(artifact.uri);
}

function fileUriLocation(uri: string): string | null {
  if (!hasFileScheme(uri)) return null;
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

function resultNameFromLocation(location: string | null): string | null {
  if (!location) return null;
  const normalized = location.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1)?.trim() || null;
}

function summaryText(artifact: ArtifactHandoffInput, durableLocation: string | null): string | null {
  const supplied = firstText(artifact.metadata, ["summary", "preview", "description", "content"]);
  if (supplied) return compactSummary(supplied);

  const name = artifact.name?.trim() || resultNameFromLocation(durableLocation);
  return name ? compactSummary(`Chef produced ${name}.`) : null;
}

function isLocalLocation(location: string): boolean {
  if (hasFileScheme(location)) return true;
  if (/^[A-Za-z]:[\\/]/.test(location)) return true;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(location);
}

export function canRevealArtifact(artifact: ArtifactHandoffInput): boolean {
  if (isFileUriArtifact(artifact)) return true;
  const location = firstText(artifact.metadata, ["resultLocation", "path", "location"]);
  return location !== null && isLocalLocation(location);
}

/**
 * Project result metadata is optional, so Simple Mode degrades gracefully while
 * still exposing a named durable result and location when richer handoff data
 * is unavailable.
 */
export function artifactHandoff(artifact: ArtifactHandoffInput): ArtifactHandoff {
  const explicitLocation = firstText(artifact.metadata, ["resultLocation", "path", "location"]);
  const fileLocation = fileUriLocation(artifact.uri);
  const durableLocation = explicitLocation ?? fileLocation;
  const runCommand = firstText(artifact.metadata, ["run", "runCommand", "command"]);
  const verifiedBy = firstText(artifact.metadata, ["verifiedBy"]);
  const explicitVerification = firstText(artifact.metadata, ["verification", "verified"]);
  const verification = explicitVerification
    ?? (verifiedBy ? `Verified by ${verifiedBy}` : artifact.metadata.verified === true ? "Verified" : null);

  return {
    summary: summaryText(artifact, durableLocation),
    location: durableLocation,
    runCommand,
    verification,
  };
}
