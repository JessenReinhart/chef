// This acceptance exercises browser-owned Simple Mode semantics through the shared API.
// Node's runtime test process has no `window`, so install the minimal browser ownership
// signal before importing the real scenario. Individual storage behavior remains owned
// by simple-mode-submission-feedback.ts itself.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

try {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dispatchEvent() { return true; } },
  });
  await import("./simple-mode-submission-feedback.ts");
} finally {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else delete (globalThis as { window?: unknown }).window;
}
