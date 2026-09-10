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
    const hasRemoteAuthority = Boolean(url.host && url.hostname.toLowerCase() !== "localhost");
    if (!hasRemoteAuthority && /^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
    if (hasRemoteAuthority) {
      if (!pathname || pathname === "/") return null;
      return `//${url.host}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
    }
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

function relativeLocationStaysWithinProject(location: string): boolean {
  let depth = 0;
  for (const segment of location.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (depth === 0) return false;
      depth -= 1;
      continue;
    }
    depth += 1;
  }
  return true;
}

function isLocalLocation(location: string): boolean {
  if (hasFileScheme(location)) return fileUriLocation(location) !== null;
  if (/^(?:\/\/|\\\\)/.test(location)) return false;
  if (/^[A-Za-z]:[\\/]/.test(location)) return true;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(location)) return false;
  if (/^[\\/]/.test(location)) return true;
  return relativeLocationStaysWithinProject(location);
}

export function canRevealArtifact(artifact: ArtifactHandoffInput): boolean {
  const explicitLocation = firstText(artifact.metadata, ["resultLocation", "path", "location"]);
  if (explicitLocation !== null) return isLocalLocation(explicitLocation);
  return fileUriLocation(artifact.uri) !== null;
}

const NON_SUCCESS_VERIFICATION_VALUES = new Set([
  "aborted",
  "blocked",
  "canceled",
  "cancelled",
  "false",
  "fail",
  "failed",
  "failure",
  "error",
  "errored",
  "no",
  "not checked",
  "not run",
  "not verified",
  "pending",
  "skipped",
  "timed out",
  "timed-out",
  "timeout",
  "unchecked",
  "unknown",
  "unverified",
]);

const NON_SUCCESS_DETAIL_SEPARATORS = [":", " - ", " — ", " – ", ";", " (", "\n", "\r\n", "\t", ".", ","];
const NON_SUCCESS_DETAIL_WORDS = new Set([
  "after",
  "because",
  "check",
  "checks",
  "checking",
  "due",
  "during",
  "on",
  "test",
  "tests",
  "testing",
  "to",
  "verification",
  "verify",
  "verified",
  "verifying",
  "while",
  "with",
]);

function negativeStatusHasFailureDetail(normalized: string, status: string): boolean {
  if (!normalized.startsWith(status)) return false;
  const suffix = normalized.slice(status.length);
  if (NON_SUCCESS_DETAIL_SEPARATORS.some((separator) => suffix.startsWith(separator))) return true;
  if (!/^\s+/.test(suffix)) return false;
  if (/\s/.test(status)) return true;
  const nextWord = suffix.trimStart().split(/\s|[:;,.()]/, 1)[0];
  return NON_SUCCESS_DETAIL_WORDS.has(nextWord);
}

function positiveVerificationText(value: string): string | null {
  const normalized = value.toLowerCase();
  if (NON_SUCCESS_VERIFICATION_VALUES.has(normalized)) return null;
  for (const status of NON_SUCCESS_VERIFICATION_VALUES) {
    if (negativeStatusHasFailureDetail(normalized, status)) return null;
  }
  return value;
}

function verificationText(metadata: Record<string, unknown>): string | null {
  const explicitVerification = firstText(metadata, ["verification"]);
  if (explicitVerification) return positiveVerificationText(explicitVerification);

  const legacyVerified = metadata.verified;
  if (legacyVerified === false) return null;
  if (typeof legacyVerified === "string") {
    const value = legacyVerified.trim();
    if (!value || !positiveVerificationText(value)) return null;
    return value;
  }

  const verifiedBy = firstText(metadata, ["verifiedBy"]);
  if (verifiedBy) {
    const verifier = positiveVerificationText(verifiedBy);
    return verifier ? `Verified by ${verifier}` : null;
  }
  return legacyVerified === true ? "Verified" : null;
}

/**
 * Project result metadata is optional, so Simple Mode degrades gracefully while
 * still exposing a named durable result and location when richer handoff data
 * is unavailable.
 */
export function artifactHandoff(artifact: ArtifactHandoffInput): ArtifactHandoff {
  const explicitLocation = firstText(artifact.metadata, ["resultLocation", "path", "location"]);
  const normalizedExplicitLocation = explicitLocation && hasFileScheme(explicitLocation)
    ? fileUriLocation(explicitLocation) ?? explicitLocation
    : explicitLocation;
  const fileLocation = fileUriLocation(artifact.uri);
  const durableLocation = normalizedExplicitLocation ?? fileLocation;
  const runCommand = firstText(artifact.metadata, ["run", "runCommand", "command"]);

  return {
    summary: summaryText(artifact, durableLocation),
    location: durableLocation,
    runCommand,
    verification: verificationText(artifact.metadata),
  };
}
