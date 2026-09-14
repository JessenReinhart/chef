import { strict as assert } from "node:assert";

import {
  CHAT_TAIL_FOLLOW_THRESHOLD_PX,
  shouldFollowChatTail,
} from "../web/src/chatScrollFollow.ts";

const viewport = (distanceFromTail: number) => ({
  scrollHeight: 1_000,
  scrollTop: 1_000 - 400 - distanceFromTail,
  clientHeight: 400,
});

assert.equal(shouldFollowChatTail(viewport(0)), true, "a reader already at the live tail should keep following incoming Mission updates");
assert.equal(
  shouldFollowChatTail(viewport(CHAT_TAIL_FOLLOW_THRESHOLD_PX)),
  true,
  "small layout/rounding drift near the live tail should not disable follow mode",
);
assert.equal(
  shouldFollowChatTail(viewport(CHAT_TAIL_FOLLOW_THRESHOLD_PX + 1)),
  false,
  "once the reader intentionally moves above the live tail, passive updates must stop stealing their scroll position",
);
assert.equal(
  shouldFollowChatTail({ scrollHeight: 300, scrollTop: 10, clientHeight: 400 }),
  true,
  "short conversations that do not overflow should remain in follow mode",
);
assert.equal(
  shouldFollowChatTail(viewport(20), 0),
  false,
  "callers can require an exact-bottom policy when needed",
);

console.log("chat-scroll-follow: ok — live chat follows near the tail without stealing an intentionally scrolled-up reading position");
