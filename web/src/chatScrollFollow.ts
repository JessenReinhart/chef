export const CHAT_TAIL_FOLLOW_THRESHOLD_PX = 48;

export type ChatScrollViewport = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

/**
 * Preserve the reader's position once they move away from the live tail, while
 * treating small layout/rounding differences near the bottom as still following.
 */
export function shouldFollowChatTail(
  viewport: ChatScrollViewport,
  threshold = CHAT_TAIL_FOLLOW_THRESHOLD_PX,
): boolean {
  const distanceFromTail = Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight);
  return distanceFromTail <= Math.max(0, threshold);
}

/** A local user submission is authoritative intent to return to the live turn. */
export function shouldScrollChatTail(followTail: boolean, forceTail: boolean): boolean {
  return forceTail || followTail;
}
