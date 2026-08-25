export type SetupChromeSurface = "home" | "workbench";

export function setupChromeFeatures(surface: SetupChromeSurface): { projectSwitcher: boolean; setupTools: boolean } {
  return {
    projectSwitcher: true,
    setupTools: surface === "workbench",
  };
}