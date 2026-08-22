const DEFAULT_RUNTIME_URL = "";

function normalizeBase(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * Runtime origin used by the web client.
 *
 * Local bundled mode stays same-origin (`""`). A hosted Chef UI can point at
 * the machine-local runtime with `VITE_CHEF_RUNTIME_URL`, for example
 * `http://127.0.0.1:4321`.
 */
export function runtimeBaseUrl(): string {
  const configured = normalizeBase(import.meta.env.VITE_CHEF_RUNTIME_URL ?? "");
  if (configured) return configured;

  if (typeof window !== "undefined") {
    const saved = normalizeBase(window.localStorage.getItem("chef:runtime-url") ?? "");
    if (saved) return saved;
  }

  return DEFAULT_RUNTIME_URL;
}

export function runtimeUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const base = runtimeBaseUrl();
  return base ? `${base}${normalizedPath}` : normalizedPath;
}
