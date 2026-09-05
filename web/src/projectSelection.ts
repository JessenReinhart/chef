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

export type ProjectPickResult = {
  path?: string;
  cancelled?: boolean;
};

export type SingleFlightProjectSelectionResult<T> =
  | { accepted: true; value: T }
  | { accepted: false };

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

export function createSingleFlightProjectSelection() {
  let inFlight = false;
  return async function run<T>(action: () => Promise<T>): Promise<SingleFlightProjectSelectionResult<T>> {
    if (inFlight) return { accepted: false };
    inFlight = true;
    try {
      return { accepted: true, value: await action() };
    } finally {
      inFlight = false;
    }
  };
}

export function sameSelectedProjectPath(left: string, right: string): boolean {
  return normalizedProjectPath(left) === normalizedProjectPath(right);
}

export async function waitForSelectedProject<T extends ProjectSelectionInfo>(
  expectedPath: string,
  loadProject: () => Promise<T>,
  delay: () => Promise<void>,
  attempts = 40,
): Promise<T> {
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

/**
 * Project picker completion is only provisional. Runtime reopen can restart the
 * project endpoint, so do not present/reload the new workspace until that same
 * path is authoritative again.
 */
export async function confirmPickedProject<T extends ProjectSelectionInfo>(
  pickProject: () => Promise<ProjectPickResult>,
  loadProject: () => Promise<T>,
  delay: () => Promise<void>,
  attempts = 40,
): Promise<T | null> {
  const picked = await pickProject();
  if (picked.cancelled || !picked.path) return null;
  return waitForSelectedProject(picked.path, loadProject, delay, attempts);
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
