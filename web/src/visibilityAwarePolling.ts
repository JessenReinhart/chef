export interface PollingEnvironment {
  isHidden: () => boolean;
  setInterval: (handler: () => void, intervalMs: number) => number;
  clearInterval: (timer: number) => void;
  addVisibilityListener: (listener: () => void) => void;
  removeVisibilityListener: (listener: () => void) => void;
}

const browserEnvironment: PollingEnvironment = {
  isHidden: () => document.hidden,
  setInterval: (handler, intervalMs) => window.setInterval(handler, intervalMs),
  clearInterval: (timer) => window.clearInterval(timer),
  addVisibilityListener: (listener) => document.addEventListener("visibilitychange", listener),
  removeVisibilityListener: (listener) => document.removeEventListener("visibilitychange", listener),
};

export function startVisibilityAwarePolling(
  poll: () => void | Promise<void>,
  intervalMs: number,
  onTimerCreated?: (timer: number) => void,
  environment: PollingEnvironment = browserEnvironment,
): () => void {
  let timer: number | null = null;

  const stopTimer = () => {
    if (timer === null) return;
    environment.clearInterval(timer);
    timer = null;
  };

  const startTimer = () => {
    stopTimer();
    timer = environment.setInterval(() => void poll(), intervalMs);
    onTimerCreated?.(timer);
  };

  const handleVisibilityChange = () => {
    if (environment.isHidden()) {
      stopTimer();
      return;
    }

    void poll();
    startTimer();
  };

  void poll();
  if (!environment.isHidden()) startTimer();
  environment.addVisibilityListener(handleVisibilityChange);

  return () => {
    stopTimer();
    environment.removeVisibilityListener(handleVisibilityChange);
  };
}
