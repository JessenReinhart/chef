import { useEffect } from "react";
import { api } from "./api";

/**
 * React Flow removes selected nodes from local state when Delete/Backspace is
 * pressed. Persist the same intent through Chef's runtime so the next state
 * refresh does not resurrect the node.
 */
export function CanvasNodeDeleteFeature() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || (event.key !== "Delete" && event.key !== "Backspace")) return;

      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='textbox']")) return;

      const selected = [...document.querySelectorAll<HTMLElement>(".react-flow__node.selected[data-id]")];
      if (selected.length === 0) return;

      for (const element of selected) {
        const nodeId = element.dataset.id;
        if (!nodeId) continue;
        void api.deleteNode(nodeId).catch(() => {
          // The authoritative canvas refresh will restore the node if deletion
          // failed. Keep this feature invisible and non-blocking.
        });
      }
    };

    // Capture before React Flow applies its local remove change so data-id is
    // still available when we persist the deletion.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return null;
}
