import { useEffect, useState } from "react";
import { api, type ProjectInfo } from "./api";

export function ProjectSwitcher() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try { setProject(await api.project()); }
    catch { /* project surface is additive while older runtimes are upgrading */ }
  };

  useEffect(() => { void refresh(); }, []);

  const reopen = async (action: () => Promise<{ reopening?: boolean; cancelled?: boolean }>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result.cancelled) return;
      if (result.reopening) {
        setOpen(false);
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 250));
          try { await api.project(); window.location.reload(); return; } catch { /* runtime is between processes */ }
        }
        throw new Error("Chef did not reopen the selected project");
      }
      await refresh();
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to open project");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button className="inline-flex max-w-64 items-center gap-1.5 min-h-[30px] rounded-md border border-[#30363d] bg-[#010409] px-2 text-[11px] text-[#c9d1d9] hover:bg-[#161b22]" onClick={() => setOpen((value) => !value)} title={project?.path ?? "Open project"} aria-expanded={open}>
        <span className="text-cyan-300">⌘</span>
        <span className="truncate">{project?.name ?? "Open project"}</span>
        <span className="text-[#6e7681]">⌄</span>
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+.45rem)] z-[60] w-[min(25rem,calc(100vw-2rem))] rounded-xl border border-[#30363d] bg-[#0d1117]/[.98] p-3 shadow-2xl backdrop-blur">
          <div className="text-xs font-semibold">Project</div>
          {project && <div className="my-1.5 truncate font-mono text-[10px] text-[#6e7681]" title={project.path}>{project.path}</div>}
          {project?.nativePicker ? (
            <button className="w-full rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-2 text-left text-[11px] text-cyan-300 disabled:opacity-50" disabled={busy} onClick={() => void reopen(() => api.pickProject())}>
              {busy ? "Opening…" : "Open folder…"}
            </button>
          ) : project ? (
            <div className="rounded-md border border-[#30363d] bg-[#010409]/70 px-2.5 py-2 text-[10px] leading-4 text-[#8b949e]">
              Folder picker unavailable on this system. Enter a local project path below.
            </div>
          ) : null}
          <form className="mt-2 grid grid-cols-[1fr_auto] gap-1" onSubmit={(event) => { event.preventDefault(); if (path.trim()) void reopen(() => api.openProject(path.trim())); }}>
            <input className="min-w-0 rounded border border-[#30363d] bg-[#010409] px-2 py-1.5 text-[10px]" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/home/you/project or C:\\dev\\my-project" aria-label="Project directory" />
            <button className="rounded border border-[#30363d] bg-[#161b22] px-2 py-1.5 text-[10px] disabled:opacity-50" type="submit" disabled={busy || !path.trim()}>Open path</button>
          </form>
          {project?.recent.length ? (
            <div className="mt-3 grid gap-1 border-t border-[#21262d] pt-2">
              <span className="text-[9px] uppercase tracking-wider text-[#6e7681]">Recent</span>
              {project.recent.filter((item) => item.path !== project.path).slice(0, 6).map((item) => (
                <button className="grid gap-0.5 rounded px-2 py-1.5 text-left hover:bg-[#161b22] disabled:opacity-50" key={item.path} disabled={busy} onClick={() => void reopen(() => api.openProject(item.path))} title={item.path}>
                  <strong className="truncate text-[11px]">{item.name}</strong><small className="truncate text-[9px] text-[#6e7681]">{item.path}</small>
                </button>
              ))}
            </div>
          ) : null}
          {error && <div className="mt-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-[10px] text-red-300" role="alert">{error}</div>}
        </div>
      )}
    </div>
  );
}
