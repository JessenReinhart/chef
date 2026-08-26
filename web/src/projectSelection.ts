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
