import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadSelectedThreadId, SELECTED_THREAD_EVENT, threadMessages } from "./threadApi";
import type { ChatMessage, UiMission } from "./types";

const MAX_PRIOR_MISSIONS = 3;
const MAX_PREVIEW_LENGTH = 220;

type StateSnapshot = { missions?: UiMission[] };

type PriorMissionResult = {
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

  const priorMissions = chronology.slice(1, MAX_PRIOR_MISSIONS + 1);
  return priorMissions.flatMap((mission) => {
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

export function HomePriorMissionResults() {
  const [target, setTarget] = useState<Element | null>(null);
  const [missions, setMissions] = useState<UiMission[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const refreshSequence = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    const selectedThreadId = loadSelectedThreadId();
    setTarget(document.querySelector('[aria-label="Recent Mission outcomes"]'));
    if (!selectedThreadId) {
      setMissions([]);
      setMessages([]);
      return;
    }

    try {
      const [stateResponse, selectedMessages] = await Promise.all([
        fetch("/api/state"),
        threadMessages(selectedThreadId),
      ]);
      if (!stateResponse.ok) return;
      const state = await stateResponse.json() as StateSnapshot;
      if (sequence !== refreshSequence.current || loadSelectedThreadId() !== selectedThreadId) return;
      setMissions(state.missions ?? []);
      setMessages(selectedMessages);
      setTarget(document.querySelector('[aria-label="Recent Mission outcomes"]'));
    } catch {
      if (sequence !== refreshSequence.current) return;
      setMissions([]);
      setMessages([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1800);
    const onThreadChanged = () => void refresh();
    window.addEventListener(SELECTED_THREAD_EVENT, onThreadChanged);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(SELECTED_THREAD_EVENT, onThreadChanged);
    };
  }, [refresh]);

  const selectedThreadId = loadSelectedThreadId();
  const results = useMemo(
    () => selectedThreadId ? priorMissionResults(missions, messages, selectedThreadId) : [],
    [missions, messages, selectedThreadId],
  );

  if (!target || results.length === 0) return null;

  return createPortal(
    <div className="mt-3 space-y-2 border-t border-white/[0.05] pt-3" aria-label="Earlier Mission results">
      {results.map(({ mission, result }) => (
        <div key={mission.id} className="rounded-xl bg-black/15 px-3 py-2.5">
          <div className="truncate text-[10px] font-medium text-zinc-500">{mission.goal}</div>
          <p className="mt-1 line-clamp-3 text-[11px] leading-4 text-zinc-400">{result}</p>
        </div>
      ))}
    </div>,
    target,
  );
}
