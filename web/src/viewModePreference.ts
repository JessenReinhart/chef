import type { ViewMode } from "./types";

const VIEW_MODE_KEY = "chef:view-mode";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function resolveStorage(storage: StorageLike | null | undefined): StorageLike | null {
  if (storage !== undefined) return storage;
  return globalThis.localStorage;
}

export function readViewModePreference(storage?: StorageLike | null): ViewMode {
  try {
    return resolveStorage(storage)?.getItem(VIEW_MODE_KEY) === "power" ? "power" : "simple";
  } catch {
    return "simple";
  }
}

export function persistViewModePreference(mode: ViewMode, storage?: StorageLike | null): void {
  try {
    resolveStorage(storage)?.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // View mode is a presentation preference. Storage policy must never block the workspace.
  }
}
