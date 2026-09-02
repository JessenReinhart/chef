import { useEffect, useState } from "react";
import { api, type ProjectInfo } from "./api";
import { projectSelectionSummary, waitForSelectedProject } from "./projectSelection";

export function ProjectSwitcher() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try { setProject(await api.project()); }
    catch { /* project surface is additive while older runtimes are upgrading */ }
  };

  useEffect(() => { void refresh(); }, []);

  const reopen = async (
    action: () => Promise<{ path?: string; reopening?: boolean; cancelled?: boolean }>,
    requestedPath?: string,
  ) => {
    setBusy(true);
    setPendingPath(requestedPath?.trim() || null);
    setError(null);
    try {
      const result = await action();
      if (result.cancelled) return;
      if (result.reopening) {
        if (!result.path) throw new Error("Chef did not report which project it is reopening");
        setPendingPath(result.path);
        await waitForSelectedProject(
          result.path,
          () => api.project(),
          () => new Promise((resolve) => window.setTimeout(resolve, 250)),
        );
        window.location.reload();
        return;
      }
      await refresh();
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to open project");
    } finally {
      setBusy(false);
      setPendingPath(null);
    }
  };

  const selection = projectSelectionSummary(project, { busy, pendingPath });

  return (
    <div className="relative">
      <button
        className="inline-flex max-w-64 items-center gap-1.5 min-h-[30px] rounded-md border border-[#30363d] bg-[#010409] px-2 text-[11px] text-[#c9d1d9] hover:bg-[#161b22] disabled:cursor-wait disabled:opacity-80"
        onClick={() => setOpen((value) => !value)}
        title={pendingPath ?? project?.path ?? "Open project"}
        aria-label={selection.ariaLabel}
        aria-expanded={open}
        aria-busy={busy}
        disabled={busy}
      >
        <span className={selection.selected ? "text-green-300" : "text-cyan-300"} aria-hidden="true">{selection.transitioning ? "↻" : selection.selected ? "✓" : "⌘"}</span>
        <span className="truncate">{selection.label}</span>
        {selection.status && <span className={`shrink-0 text-[9px] font-semibold uppercase tracking-wide ${selection.transitioning ? "text-cyan-300" : "text-green-300"}`}>{selection.status}</span>}
        {!selection.transitioning && <span className="text-[#6e7681]" aria-hidden="true">⌄</span>}
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+.45rem)] z-[60] w-[min(25rem,calc(100vw-2rem))] rounded-xl border border-[#30363d] bg-[#0d1117]/[.98] p-3 shadow-2xl backdrop-blur">
          <div className="text-xs font-semibold">Project</div>
          {busy ? (
            <div className="my-1.5 truncate font-mono text-[10px] text-cyan-300" title={pendingPath ?? "Opening project"}>
              {pendingPath ? `Opening ${pendingPath}` : "Opening project…"}
            </div>
          ) : project ? (
            <div className="my-1.5 truncate font-mono text-[10px] text-[#6e7681]" title={project.path}>{project.path}</div>
          ) : null}
          {project?.nativePicker ? (
            <button className="w-full rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-2 text-left text-[11px] text-cyan-300 disabled:opacity-50" disabled={busy} onClick={() => void reopen(() => api.pickProject())}>
              {busy ? "Opening…" : "Open folder…"}
            </button>
          ) : project ? (
            <div className="rounded-md border border-[#30363d] bg-[#010409]/70 px-2.5 py-2 text-[10px] leading-4 text-[#8b949e]">
              Folder picker unavailable on this system. Enter a local project path below.
            </div>
          ) : null}
          <form className="mt-2 grid grid-cols-[1fr_auto] gap-1" onSubmit={(event) => { event.preventDefault(); const requestedPath = path.trim(); if (requestedPath) void reopen(() => api.openProject(requestedPath), requestedPath); }}>
            <input className="min-w-0 rounded border border-[#30363d] bg-[#010409] px-2 py-1.5 text-[10px]" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/home/you/project or C:\\dev\\my-project" aria-label="Project directory" disabled={busy} />
            <button className="rounded border border-[#30363d] bg-[#161b22] px-2 py-1.5 text-[10px] disabled:opacity-50" type="submit" disabled={busy || !path.trim()}>Open path</button>
          </form>
          {project?.recent.length ? (
            <div className="mt-3 grid gap-1 border-t border-[#21262d] pt-2">
              <span className="text-[9px] uppercase tracking-wider text-[#6e7681]">Recent</span>
              {project.recent.filter((item) => item.path !== project.path).slice(0, 6).map((item) => (
                <button className="grid gap-0.5 rounded px-2 py-1.5 text-left hover:bg-[#161b22] disabled:opacity-50" key={item.path} disabled={busy} onClick={() => void reopen(() => api.openProject(item.path), item.path)} title={item.path}>
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
