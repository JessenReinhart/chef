import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadSelectedThreadId, SELECTED_THREAD_EVENT, threadMessages } from "./threadApi";
import { priorMissionResults } from "./priorMissionResults";
import type { ChatMessage, UiMission } from "./types";

type StateSnapshot = { missions?: UiMission[] };

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
