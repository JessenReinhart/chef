import type { Mission, MissionId } from "../core/types.ts";
import type { Repository } from "./database.ts";

/**
 * Re-open exactly one failed Mission for an explicit user-requested retry.
 *
 * Repository.updateMission intentionally treats every terminal status as
 * immutable. Recovery is the one bounded exception: failed work may re-enter
 * active execution, while completed/cancelled history must remain final.
 * Keeping the exception here avoids weakening the general Mission transition
 * table or allowing arbitrary callers to mutate terminal history.
 */
export function reactivateFailedMission(repository: Repository, missionId: MissionId): Mission {
  return repository.transaction(() => {
    const current = repository.getMission(missionId);
    if (!current) throw new Error(`Mission not found: ${missionId}`);
    if (current.status !== "failed") {
      throw new Error(`Mission ${missionId} is not recoverable from status ${current.status}`);
    }

    const result = repository.db.prepare(
      `UPDATE missions
       SET status = 'active', updated_at = ?, completed_at = NULL
       WHERE id = ? AND status = 'failed'`,
    ).run(Date.now(), missionId);
    if (result.changes !== 1) throw new Error(`Mission ${missionId} changed concurrently`);
    return repository.getMission(missionId)!;
  });
}
