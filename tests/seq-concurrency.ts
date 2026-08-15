/**
 * Multi-connection event append regression: two Repository instances over the
 * same SQLite file must never produce duplicate seq values. appendEvent now
 * allocates seq atomically in one INSERT..SELECT..RETURNING statement; before
 * that, two connections could read the same MAX(seq) and one insert failed
 * (or, with a busy retry, both committed duplicate-adjacent rows is prevented
 * only by the UNIQUE constraint).
 *
 * Exercises the exact failure the old nextSeq() had: interleaved writes from
 * separate DatabaseSync connections to one file.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { Repository } from "../src/persistence/database.ts";

const dir = mkdtempSync(join(tmpdir(), "chef-seq-test-"));
const dbPath = join(dir, "test.db");

const repoA = new Repository(dbPath);
const repoB = new Repository(dbPath);
const workspaceId = repoA.createWorkspace({ name: "seq-test", rootPath: dir }).id;

const eventsPerWriter = 25;
const sourceA = { type: "test", id: "a" } as const;
const sourceB = { type: "test", id: "b" } as const;

// Interleave appends from both connections — synchronous loop interleaves
// naturally on one thread, exactly the two-connection MAX+1 race.
for (let i = 0; i < eventsPerWriter; i++) {
  repoA.appendEvent({ workspaceId, source: sourceA, type: "ping", payload: { writer: "a", i } });
  repoB.appendEvent({ workspaceId, source: sourceB, type: "ping", payload: { writer: "b", i } });
}

const events = repoA.listEvents(workspaceId);
const seqs = events.map((e) => e.seq);
const unique = new Set(seqs);
if (unique.size !== seqs.length) {
  throw new Error(`duplicate seqs: ${seqs.length} events, ${unique.size} unique`);
}
if (seqs.length !== eventsPerWriter * 2) {
  throw new Error(`expected ${eventsPerWriter * 2} events, got ${seqs.length}`);
}
for (let i = 0; i < seqs.length; i++) {
  if (seqs[i] !== i + 1) {
    throw new Error(`seq discontinuity at index ${i}: expected ${i + 1}, got ${seqs[i]}`);
  }
}

repoA.close();
repoB.close();
rmSync(dir, { recursive: true, force: true });

console.log(`seq-concurrency: ok — ${seqs.length} events, seqs 1..${seqs.length}, no duplicates`);
