import { strict as assert } from "node:assert";

import {
  CHAT_TAIL_FOLLOW_THRESHOLD_PX,
  shouldFollowChatTail,
  shouldScrollChatTail,
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
assert.equal(
  shouldScrollChatTail(false, false),
  false,
  "passive incoming updates must not auto-scroll after the reader leaves the live tail",
);
assert.equal(
  shouldScrollChatTail(false, true),
  true,
  "a new local user submission must force the conversation back to its newest turn",
);
assert.equal(
  shouldScrollChatTail(true, false),
  true,
  "passive incoming updates should continue following while the reader remains at the live tail",
);

console.log("chat-scroll-follow: ok — live chat follows near the tail, local submissions force the newest turn into view, and passive updates respect an intentionally scrolled-up reading position");
