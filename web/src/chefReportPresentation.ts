import type { UiMission } from "./types";

export type ChefReportPresentation = "compact" | "expanded";

type ChefReportPresentationInput = {
  missionStatus?: UiMission["status"] | null;
  directReport: boolean;
  starting: boolean;
};

const TERMINAL_MISSION_STATUSES = new Set<UiMission["status"]>([
  "completed",
  "failed",
  "blocked",
  "cancelled",
]);

export function chefReportPresentation({
  missionStatus,
  directReport,
  starting,
}: ChefReportPresentationInput): ChefReportPresentation {
  if (starting) return "compact";
  if (directReport) return "expanded";
  if (!missionStatus) return "expanded";
  return TERMINAL_MISSION_STATUSES.has(missionStatus) ? "expanded" : "compact";
}
