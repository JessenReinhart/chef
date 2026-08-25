import type { ChatMessage, UiMission } from "./types";

const MAX_PRIOR_MISSIONS = 3;
const MAX_PREVIEW_LENGTH = 220;

export type PriorMissionResult = {
  mission: UiMission;
  result: string;
};

export function priorMissionResults(
  missions: UiMission[],
  messages: ChatMessage[],
  selectedThreadId: string,
): PriorMissionResult[] {
  const chronology = missions
    .filter((mission) => mission.metadata?.threadId === selectedThreadId)
    .sort((a, b) => b.createdAt - a.createdAt);

  return chronology.slice(1, MAX_PRIOR_MISSIONS + 1).flatMap((mission) => {
    const message = [...messages].reverse().find(
      (candidate) => candidate.role === "assistant" && candidate.metadata?.missionId === mission.id,
    );
    const normalized = message?.content.replace(/\s+/g, " ").trim();
    if (!normalized) return [];
    return [{
      mission,
      result: normalized.length <= MAX_PREVIEW_LENGTH
        ? normalized
        : `${normalized.slice(0, MAX_PREVIEW_LENGTH - 1)}…`,
    }];
  });
}
