import type { Artifact } from "./types.ts";
import { artifactHandoff, canRevealArtifact } from "../../web/src/artifactHandoff.ts";

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
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

function handoffView(artifact: Artifact) {
  return artifactHandoff({
    name: artifact.name,
    uri: artifact.uri,
    metadata: artifact.metadata,
  });
}

function artifactLocation(artifact: Artifact): string | undefined {
  if (!canRevealArtifact({ name: artifact.name, uri: artifact.uri, metadata: artifact.metadata })) return undefined;
  return handoffView(artifact).location ?? undefined;
}

function artifactRunCommand(artifact: Artifact): string | undefined {
  if (!artifactLocation(artifact)) return undefined;
  return singleLine(handoffView(artifact).runCommand ?? undefined);
}

function artifactVerification(artifact: Artifact): string | undefined {
  const verification = handoffView(artifact).verification;
  if (!verification) return undefined;
  return verification.replace(/^Verified\b/u, "verified");
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
 * Location revealability and verification truthfulness intentionally reuse Simple
 * Mode's existing handoff contract so the terminal note cannot promise actions or
 * evidence that the ordinary result card rejects. Run instructions remain bounded
 * to copy-safe single lines and only accompany results the user can locate/reveal.
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
