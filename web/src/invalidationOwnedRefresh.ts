import { createMissionProgressRefreshQueue } from "./missionProgressStream.ts";

export type InvalidationOwnedRefreshQueue = {
  trigger(): void;
  close(): void;
};

/**
 * Coalesce refresh work without letting an older in-flight read publish after a
 * newer invalidation has already arrived.
 */
export function createInvalidationOwnedRefreshQueue(
  refresh: (isCurrent: () => boolean) => Promise<void> | void,
): InvalidationOwnedRefreshQueue {
  let closed = false;
  let invalidationVersion = 0;
  const queue = createMissionProgressRefreshQueue(async () => {
    const refreshVersion = invalidationVersion;
    await refresh(() => !closed && refreshVersion === invalidationVersion);
  });

  return {
    trigger() {
      if (closed) return;
      invalidationVersion += 1;
      queue.trigger();
    },
    close() {
      if (closed) return;
      closed = true;
      invalidationVersion += 1;
      queue.close();
    },
  };
}
