import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { projectMissionActivity, type MissionActivitySnapshot } from "./missionActivityProjection";
import type { HarnessInfo } from "./types";

const EMPTY: MissionActivitySnapshot = { missions: [], tasks: [], events: [] };

export function MissionActivityRail() {
  const [snapshot, setSnapshot] = useState<MissionActivitySnapshot>(EMPTY);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);

  const refresh = useCallback(async () => {
    try {
      const state = await api.stateRaw();
      setSnapshot({
        missions: state.missions ?? [],
        tasks: state.tasks,
        events: state.events,
      });
    } catch {
      // The Living Workspace owns the primary error surface. Keep this rail quiet.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    void api.harnesses().then(setHarnesses).catch(() => setHarnesses([]));
  }, []);

  const activity = useMemo(() => projectMissionActivity(snapshot, harnesses), [snapshot, harnesses]);
  if (!activity) return null;

  return (
    <aside className="chef-live-activity" aria-label="Live Chef activity">
      <header>
        <div>
          <span className="chef-live-activity__eyebrow">Live activity</span>
          <strong>{activity.missionState}</strong>
        </div>
        <i data-status={activity.mission.status} />
      </header>

      <p className="chef-live-activity__goal">{activity.mission.goal}</p>

      {activity.workers.length > 0 && (
        <div className="chef-live-activity__workers">
          {activity.workers.map((worker) => (
            <div key={worker.id} className="chef-live-worker" data-status={worker.status}>
              <span className="chef-live-worker__mark">✦</span>
              <span className="chef-live-worker__copy">
                <strong>{worker.name}</strong>
                <small>{worker.title}</small>
              </span>
              <span className="chef-live-worker__status">{worker.state}</span>
            </div>
          ))}
        </div>
      )}

      <div className="chef-live-activity__feed">
        <span>What is happening</span>
        {activity.feed.length > 0
          ? activity.feed.map((line) => <p key={line}>{line}</p>)
          : <p>{activity.fallback}</p>}
      </div>
    </aside>
  );
}
