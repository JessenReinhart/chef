import { randomUUID } from "node:crypto";

import type { Timestamp, WorkspaceId } from "../core/types.ts";
import type { Thread, ThreadId, ThreadStatus } from "../core/threads.ts";
import { Repository } from "./database.ts";

export interface ThreadInput {
  id?: ThreadId;
  workspaceId: WorkspaceId;
  title: string;
  status?: ThreadStatus;
  summary?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface ThreadPatch {
  title?: string;
  status?: ThreadStatus;
  /** Pass null to clear a prior rolling summary. */
  summary?: string | null;
  metadata?: Record<string, unknown>;
}

type ThreadRow = {
  id: string;
  workspace_id: string;
  title: string;
  status: ThreadStatus;
  summary: string | null;
  metadata_json: string;
  created_at: number;
  updated_at: number;
};

function mapThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    status: row.status,
    summary: row.summary ?? undefined,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (!normalized) throw new Error("Thread title must not be empty");
  return normalized;
}

function nextUpdatedAt(current: Timestamp): Timestamp {
  return Math.max(Date.now(), current + 1);
}

/** Durable Thread persistence. Runtime/API ownership checks build on this layer. */
export class ThreadRepository {
  private readonly repo: Repository;

  constructor(repo: Repository) {
    this.repo = repo;
  }

  create(input: ThreadInput): Thread {
    const id = input.id ?? randomUUID();
    const timestamp = Date.now();
    this.repo.db.prepare(
      `INSERT INTO threads
       (id, workspace_id, title, status, summary, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.workspaceId,
      normalizeTitle(input.title),
      input.status ?? "active",
      input.summary?.trim() || null,
      JSON.stringify(input.metadata ?? {}),
      input.createdAt ?? timestamp,
      input.updatedAt ?? timestamp,
    );
    return this.get(id)!;
  }

  get(id: ThreadId): Thread | null {
    const row = this.repo.db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id) as ThreadRow | undefined;
    return row ? mapThread(row) : null;
  }

  list(workspaceId: WorkspaceId): Thread[] {
    return (this.repo.db.prepare(
      `SELECT * FROM threads WHERE workspace_id = ? ORDER BY updated_at DESC, id`,
    ).all(workspaceId) as ThreadRow[]).map(mapThread);
  }

  update(id: ThreadId, patch: ThreadPatch): Thread {
    const current = this.get(id);
    if (!current) throw new Error(`Thread not found: ${id}`);

    const title = patch.title === undefined ? current.title : normalizeTitle(patch.title);
    const summary = patch.summary === undefined
      ? current.summary ?? null
      : patch.summary?.trim() || null;
    const metadata = patch.metadata ?? current.metadata;

    this.repo.db.prepare(
      `UPDATE threads
       SET title = ?, status = ?, summary = ?, metadata_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      title,
      patch.status ?? current.status,
      summary,
      JSON.stringify(metadata),
      nextUpdatedAt(current.updatedAt),
      id,
    );
    return this.get(id)!;
  }

  /** Advance recency for durable Thread activity without changing Thread content. */
  touch(id: ThreadId): Thread {
    const current = this.get(id);
    if (!current) throw new Error(`Thread not found: ${id}`);
    this.repo.db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(nextUpdatedAt(current.updatedAt), id);
    return this.get(id)!;
  }

  archive(id: ThreadId): Thread {
    return this.update(id, { status: "archived" });
  }
}

export function createThreadRepository(repo: Repository): ThreadRepository {
  return new ThreadRepository(repo);
}
