import type { UiMission } from "./types";

export type ChefReportPresentation = "compact" | "expanded";

type ChefReportPresentationInput = {
  missionStatus?: UiMission["status"] | null;
  directReport?: boolean;
  starting: boolean;
};

const EXPANDED_MISSION_STATUSES = new Set<UiMission["status"]>([
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "paused",
  "waiting_for_approval",
]);

export function chefReportPresentation({
  missionStatus,
  directReport = false,
  starting,
}: ChefReportPresentationInput): ChefReportPresentation {
  if (starting) return "compact";
  if (directReport) return "expanded";
  if (!missionStatus) return "expanded";
  return EXPANDED_MISSION_STATUSES.has(missionStatus) ? "expanded" : "compact";
}
