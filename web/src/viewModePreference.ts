import type { ViewMode } from "./types";

const VIEW_MODE_KEY = "chef:view-mode";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function readViewModePreference(storage: StorageLike | null | undefined = globalThis.localStorage): ViewMode {
  try {
    return storage?.getItem(VIEW_MODE_KEY) === "power" ? "power" : "simple";
  } catch {
    return "simple";
  }
}

export function persistViewModePreference(mode: ViewMode, storage: StorageLike | null | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // View mode is a presentation preference. Storage policy must never block the workspace.
  }
}
