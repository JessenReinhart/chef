import { useEffect, useState } from "react";
import { api, type ProjectInfo } from "./api";

export function WorkspaceContextBar() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.project()
      .then((value) => {
        if (!cancelled) setProject(value);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Project unavailable");
      });
    return () => { cancelled = true; };
  }, []);

  async function switchProject() {
    if (switching) return;
    setSwitching(true);
    setError(null);
    try {
      const result = await api.pickProject();
      if (result.path && !result.cancelled) window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not switch project");
    } finally {
      setSwitching(false);
    }
  }

  return (
    <aside className="chef-project-context" aria-label="Active Chef project">
      <div className="chef-project-context__copy">
        <span className="chef-project-context__eyebrow">Working in</span>
        <strong>{project?.name ?? "Loading project…"}</strong>
        <span className="chef-project-context__path" title={project?.path}>{project?.path ?? ""}</span>
      </div>
      <button type="button" onClick={() => void switchProject()} disabled={switching}>
        {switching ? "Opening…" : "Change project"}
      </button>
      {error && <span className="chef-project-context__error" role="status">{error}</span>}
    </aside>
  );
}
