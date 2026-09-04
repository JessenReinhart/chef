export function stateRefreshErrorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : "Failed to load state";
}

/** Keep explicit user-action failures ahead of recoverable background refresh warnings. */
export function visibleAppError(
  actionError: string | null,
  stateRefreshError: string | null,
): string | null {
  return actionError ?? stateRefreshError;
}

export type DismissedAppError = {
  actionError: string | null;
  stateRefreshError: string | null;
};

/** Dismiss only the error the user can currently see. */
export function dismissVisibleAppError(
  actionError: string | null,
  stateRefreshError: string | null,
): DismissedAppError {
  if (actionError) return { actionError: null, stateRefreshError };
  return { actionError, stateRefreshError: null };
}
