export type ThreadScopedRefreshResult<T> =
  | { current: true; value: T }
  | { current: false };

/**
 * Resolve an authoritative read only when the foreground Thread still owns it.
 * Slow state reads may settle after the user switches Threads; those results are
 * background history, not valid Simple Mode foreground state.
 */
export async function loadForSelectedThread<T>(
  requestThreadId: string | null,
  selectedThreadId: () => string | null,
  load: () => Promise<T>,
): Promise<ThreadScopedRefreshResult<T>> {
  const value = await load();
  if (selectedThreadId() !== requestThreadId) return { current: false };
  return { current: true, value };
}
