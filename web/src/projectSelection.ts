export type ProjectSelectionInfo = {
  name: string;
  path: string;
};

export type ProjectSelectionSummary = {
  selected: boolean;
  label: string;
  status: string | null;
  ariaLabel: string;
};

function normalizedProjectPath(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  while (normalized.length > 1 && normalized.endsWith("/") && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
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

export function projectSelectionSummary(project: ProjectSelectionInfo | null): ProjectSelectionSummary {
  if (!project) {
    return {
      selected: false,
      label: "Open project",
      status: null,
      ariaLabel: "Open project",
    };
  }

  return {
    selected: true,
    label: project.name,
    status: "Selected",
    ariaLabel: `Selected project: ${project.name} (${project.path})`,
  };
}
