import { resolve } from "node:path";

export function normalizedProjectPath(path, platform = process.platform) {
  const normalized = resolve(path);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function shouldRejectOtherProjectRuntime({ existingProjectPath, currentProjectPath, restart, platform = process.platform }) {
  if (restart) return false;
  return normalizedProjectPath(existingProjectPath, platform) !== normalizedProjectPath(currentProjectPath, platform);
}
