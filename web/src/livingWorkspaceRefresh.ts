export type WorkspaceRefreshErrorSink = (message: string | null) => void;

export async function runRecoverableWorkspaceRefresh<T>(
  loadState: () => Promise<T>,
  applyState: (state: T) => void,
  setRefreshError: WorkspaceRefreshErrorSink,
): Promise<void> {
  try {
    const state = await loadState();
    applyState(state);
    setRefreshError(null);
  } catch (reason) {
    setRefreshError(
      reason instanceof Error && reason.message
        ? reason.message
        : "Chef could not refresh the workspace.",
    );
  }
}
