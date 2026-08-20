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
    <div className="project-switcher">
      <button className="project-switcher__current" onClick={() => setOpen((value) => !value)} title={project?.path ?? "Open project"} aria-expanded={open}>
        <span className="project-switcher__icon">⌘</span>
        <span className="project-switcher__name">{project?.name ?? "Open project"}</span>
        <span className="project-switcher__chevron">⌄</span>
      </button>
      {open && (
        <div className="project-switcher__menu">
          <div className="project-switcher__heading">Project</div>
          {project && <div className="project-switcher__path" title={project.path}>{project.path}</div>}
          {project?.nativePicker && (
            <button className="project-switcher__primary" disabled={busy} onClick={() => void reopen(() => api.pickProject())}>
              {busy ? "Opening…" : "Open folder…"}
            </button>
          )}
          <form onSubmit={(event) => { event.preventDefault(); if (path.trim()) void reopen(() => api.openProject(path.trim())); }}>
            <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="C:\\dev\\my-project" aria-label="Project directory" />
            <button type="submit" disabled={busy || !path.trim()}>Open path</button>
          </form>
          {project?.recent.length ? (
            <div className="project-switcher__recent">
              <span>Recent</span>
              {project.recent.filter((item) => item.path !== project.path).slice(0, 6).map((item) => (
                <button key={item.path} disabled={busy} onClick={() => void reopen(() => api.openProject(item.path))} title={item.path}>
                  <strong>{item.name}</strong><small>{item.path}</small>
                </button>
              ))}
            </div>
          ) : null}
          {error && <div className="project-switcher__error" role="alert">{error}</div>}
        </div>
      )}
    </div>
  );
}
