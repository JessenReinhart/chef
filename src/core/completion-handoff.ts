import type { Artifact } from "./types.ts";

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const NON_SUCCESS_VERIFICATION = /\b(?:aborted|blocked|cancelled|canceled|error|errored|fail|failed|failure|pending|skipped|timeout|timed out|unchecked|unknown|unverified|not checked|not run|not verified)\b/iu;
const MAX_SUMMARY_LENGTH = 240;

function metadataText(artifact: Artifact, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = artifact.metadata[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function singleLine(value: string | undefined): string | undefined {
  if (!value || CONTROL_CHARS.test(value)) return undefined;
  return value.trim() || undefined;
}

function compactSummary(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact) return undefined;
  return compact.length > MAX_SUMMARY_LENGTH ? `${compact.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : compact;
}

function hasFileScheme(value: string): boolean {
  return /^file:/iu.test(value);
}

function fileUriLocation(uri: string): string | undefined {
  if (!hasFileScheme(uri)) return undefined;
  try {
    const url = new URL(uri);
    if (url.host && url.hostname.toLowerCase() !== "localhost") return undefined;
    let pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//u.test(pathname)) pathname = pathname.slice(1);
    return singleLine(pathname);
  } catch {
    return undefined;
  }
}

function relativeLocationStaysWithinProject(location: string): boolean {
  let depth = 0;
  for (const segment of location.replace(/\\/gu, "/").split("/")) {
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

function isRevealableLocation(location: string): boolean {
  if (hasFileScheme(location)) return fileUriLocation(location) !== undefined;
  if (/^(?:\/\/|\\\\)/u.test(location)) return false;
  if (/^[A-Za-z]:[\\/]/u.test(location)) return true;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(location)) return false;
  if (/^[\\/]/u.test(location)) return true;
  return relativeLocationStaysWithinProject(location);
}

function artifactLocation(artifact: Artifact): string | undefined {
  const explicit = singleLine(metadataText(artifact, ["resultLocation", "path", "location"]));
  if (explicit && isRevealableLocation(explicit)) {
    return hasFileScheme(explicit) ? fileUriLocation(explicit) : explicit;
  }
  return fileUriLocation(artifact.uri);
}

function artifactRunCommand(artifact: Artifact): string | undefined {
  return singleLine(metadataText(artifact, ["run", "runCommand", "command"]));
}

function positiveVerification(value: string | undefined): string | undefined {
  const compact = compactSummary(value);
  if (!compact || NON_SUCCESS_VERIFICATION.test(compact)) return undefined;
  return compact;
}

function artifactVerification(artifact: Artifact): string | undefined {
  const explicit = positiveVerification(metadataText(artifact, ["verification"]));
  if (explicit) return explicit;
  const verifiedBy = positiveVerification(metadataText(artifact, ["verifiedBy"]));
  if (verifiedBy) return `verified by ${verifiedBy}`;
  return artifact.metadata.verified === true ? "verified" : undefined;
}

function handoffScore(artifact: Artifact): number {
  let score = artifact.type === "result" ? 1 : 0;
  if (artifactLocation(artifact)) score += 3;
  if (artifactRunCommand(artifact)) score += 2;
  if (artifactVerification(artifact)) score += 1;
  return score;
}

/**
 * Enrich a terminal Mission report with one bounded, truthful result handoff.
 * Only explicit artifact metadata is surfaced; locations must support Chef's
 * ordinary local result reveal behavior, while unsafe run commands and negative
 * verification claims are deliberately ignored.
 */
export function completionHandoffReport(report: string, artifacts: readonly Artifact[]): string {
  const primary = artifacts
    .map((artifact, index) => ({ artifact, index, score: handoffScore(artifact) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)[0]?.artifact;
  if (!primary) return report;

  const summary = compactSummary(metadataText(primary, ["summary", "content", "description", "preview"])) ?? primary.name.trim();
  const location = artifactLocation(primary);
  const runCommand = artifactRunCommand(primary);
  const verification = artifactVerification(primary);
  const handoff: string[] = [];

  if (summary) handoff.push(`Result: ${summary}`);
  if (location) handoff.push(`Location: ${location}`);
  if (runCommand) handoff.push(`Run: ${runCommand}`);
  if (verification) handoff.push(`Verification: ${verification}`);
  if (handoff.length === 0) return report;

  return `${report}\n\nHandoff:\n${handoff.map((line) => `- ${line}`).join("\n")}`;
}
