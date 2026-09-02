export type ProjectSelectionInfo = {
  name: string;
  path: string;
};

export type ProjectSelectionTransition = {
  busy: boolean;
  pendingPath?: string | null;
};

export type ProjectSelectionSummary = {
  selected: boolean;
  transitioning: boolean;
  label: string;
  status: string | null;
  ariaLabel: string;
};

function normalizedProjectPath(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  while (normalized.length > 1 && normalized.endsWith("/") && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  const windowsPath = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//");
  return windowsPath ? normalized.toLowerCase() : normalized;
}

function projectNameFromPath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const name = normalized.split("/").filter(Boolean).at(-1)?.trim();
  return name || null;
}

export function sameSelectedProjectPath(left: string, right: string): boolean {
  return normalizedProjectPath(left) === normalizedProjectPath(right);
}

export async function waitForSelectedProject(
  expectedPath: string,
  loadProject: () => Promise<ProjectSelectionInfo>,
  delay: () => Promise<void>,
  attempts = 40,
): Promise<ProjectSelectionInfo> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await delay();
    try {
      const project = await loadProject();
      if (sameSelectedProjectPath(project.path, expectedPath)) return project;
    } catch {
      // Runtime restarts can briefly make the project endpoint unavailable.
    }
  }
  throw new Error(`Chef reopened, but the selected project did not become active: ${expectedPath}`);
}

export function projectSelectionSummary(
  project: ProjectSelectionInfo | null,
  transition: ProjectSelectionTransition = { busy: false },
): ProjectSelectionSummary {
  if (transition.busy) {
    const pendingPath = transition.pendingPath?.trim() || null;
    const pendingName = pendingPath ? projectNameFromPath(pendingPath) : null;
    return {
      selected: false,
      transitioning: true,
      label: pendingName ? `Opening ${pendingName}` : "Opening project",
      status: "Switching",
      ariaLabel: pendingPath ? `Opening project: ${pendingPath}` : "Opening project",
    };
  }

  if (!project) {
    return {
      selected: false,
      transitioning: false,
      label: "Open project",
      status: null,
      ariaLabel: "Open project",
    };
  }

  return {
    selected: true,
    transitioning: false,
    label: project.name,
    status: "Selected",
    ariaLabel: `Selected project: ${project.name} (${project.path})`,
  };
}
