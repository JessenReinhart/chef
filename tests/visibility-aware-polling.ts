import { strict as assert } from "node:assert";
import { startVisibilityAwarePolling, type PollingEnvironment } from "../web/src/visibilityAwarePolling.ts";

function createEnvironment(hidden = false) {
  let nextTimer = 1;
  const timers = new Map<number, () => void>();
  const listeners = new Set<() => void>();
  const environment: PollingEnvironment = {
    isHidden: () => hidden,
    setInterval: (handler) => {
      const timer = nextTimer++;
      timers.set(timer, handler);
      return timer;
    },
    clearInterval: (timer) => {
      timers.delete(timer);
    },
    addVisibilityListener: (listener) => listeners.add(listener),
    removeVisibilityListener: (listener) => listeners.delete(listener),
  };

  return {
    environment,
    setHidden(value: boolean) {
      hidden = value;
      for (const listener of [...listeners]) listener();
    },
    fireTimers() {
      for (const handler of [...timers.values()]) handler();
    },
    activeTimerCount: () => timers.size,
    listenerCount: () => listeners.size,
  };
}

const visible = createEnvironment();
let polls = 0;
const stop = startVisibilityAwarePolling(() => {
  polls += 1;
}, 1500, undefined, visible.environment);

assert.equal(polls, 1, "visible polling should perform an initial refresh");
assert.equal(visible.activeTimerCount(), 1, "visible polling should schedule one interval");
assert.equal(visible.listenerCount(), 1, "visibility changes should be observed");
visible.fireTimers();
assert.equal(polls, 2, "the interval should continue refreshing while visible");

visible.setHidden(true);
assert.equal(visible.activeTimerCount(), 0, "hidden tabs should stop the polling timer");
visible.fireTimers();
assert.equal(polls, 2, "hidden tabs should not keep refreshing from a stale timer");

visible.setHidden(false);
assert.equal(polls, 3, "returning to a visible tab should refresh immediately");
assert.equal(visible.activeTimerCount(), 1, "returning to a visible tab should restart one interval");
stop();
assert.equal(visible.activeTimerCount(), 0, "cleanup should clear the active interval");
assert.equal(visible.listenerCount(), 0, "cleanup should remove the visibility listener");

const hidden = createEnvironment(true);
let hiddenPolls = 0;
const stopHidden = startVisibilityAwarePolling(() => {
  hiddenPolls += 1;
}, 2000, undefined, hidden.environment);
assert.equal(hiddenPolls, 1, "mounting while hidden should still perform the authoritative initial refresh");
assert.equal(hidden.activeTimerCount(), 0, "mounting while hidden should not start background polling");
hidden.setHidden(false);
assert.equal(hiddenPolls, 2, "becoming visible should refresh the hidden mount before resuming polling");
stopHidden();

console.log("visibility-aware polling behavior passed");
