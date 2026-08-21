import { useCallback, useEffect, useState } from "react";
import { loadHarnessReadiness, type HarnessReadinessItem } from "./harnessReadinessApi";

export function HarnessReadinessPanel({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<HarnessReadinessItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await loadHarnessReadiness());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const cliItems = items.filter((item) => item.kind === "cli");
  const availableCliCount = cliItems.filter((item) => item.available).length;

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="w-full max-w-xl rounded-xl border border-[#30363d] bg-[#0d1117] p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">Agent harnesses</h2>
            <p className="mt-1 text-xs text-[#8b949e]">
              Chef can host terminal-native agents already installed on this machine. Their own CLI keeps control of login, API keys, models, and provider settings.
            </p>
          </div>
          <button onClick={onClose} className="text-[#8b949e] hover:text-white">×</button>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-[#30363d] bg-[#010409] px-3 py-2">
          <div>
            <p className="text-xs font-medium">{loading ? "Checking installed harnesses…" : `${availableCliCount} CLI harness${availableCliCount === 1 ? "" : "es"} ready`}</p>
            <p className="mt-0.5 text-[11px] text-[#6e7681]">Availability means Chef found the configured executable. Authentication state is intentionally not probed.</p>
          </div>
          <button disabled={loading} onClick={() => void refresh()} className="rounded border border-[#30363d] px-2.5 py-1.5 text-xs text-[#c9d1d9] hover:bg-white/5 disabled:opacity-50">Refresh</button>
        </div>

        {error && <p className="mt-3 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">Could not load harness readiness: {error}</p>}

        <div className="mt-3 grid gap-2">
          {items.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-4 rounded-lg border border-[#21262d] bg-[#010409] px-3 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${item.available ? "bg-emerald-400" : "bg-[#484f58]"}`} />
                  <span className="truncate text-xs font-medium text-[#f0f6fc]">{item.name}</span>
                  <span className="rounded bg-[#161b22] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#8b949e]">{item.kind}</span>
                </div>
                <p className="mt-1 truncate pl-4 text-[11px] text-[#6e7681]">
                  {item.command ? <>Command: <code className="text-[#8b949e]">{item.command}</code></> : "Built-in generic terminal fallback"}
                </p>
              </div>
              <span className={`shrink-0 text-[11px] font-medium ${item.available ? "text-emerald-300" : "text-[#8b949e]"}`}>{item.available ? "Ready" : "Not found"}</span>
            </div>
          ))}

          {!loading && !error && items.length === 0 && (
            <p className="rounded-lg border border-[#21262d] p-3 text-xs text-[#8b949e]">No harness readiness data is available yet.</p>
          )}
        </div>

        <p className="mt-3 text-[11px] text-[#6e7681]">You do not need to configure Chef's Orchestrator AI provider to use a ready CLI harness.</p>
      </section>
    </div>
  );
}
