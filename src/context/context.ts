import type { ContextReference, WorkspaceId } from "../core/types.ts";
import type { Repository } from "../persistence/database.ts";
import { SidebandDirectory } from "../harness/sideband.ts";

export interface ResolvedContextItem {
  reference: ContextReference;
  payload: unknown;
}

export interface ResolvedContext {
  items: ResolvedContextItem[];
}

/** Selective, reference-based context resolver for P0 workers. */
export class ContextManager {
  readonly #repository: Repository;

  constructor(repository: Repository) {
    this.#repository = repository;
  }

  resolve(references: ContextReference[], workspaceId: WorkspaceId): ResolvedContext {
    const items: ResolvedContextItem[] = [];
    for (const reference of references) {
      let payload: unknown = null;
      switch (reference.type) {
        case "artifact": {
          const artifact = this.#repository.getArtifact(reference.id);
          if (artifact) payload = artifact;
          break;
        }
        case "task": {
          const task = this.#repository.getTask(reference.id);
          if (task) payload = task;
          break;
        }
        case "event": {
          const events = this.#repository.listEvents(workspaceId, { limit: 1000 });
          payload = events.find((event) => event.id === reference.id) ?? null;
          break;
        }
        case "message": {
          const messages = this.#repository.listMessages(workspaceId);
          payload = messages.find((message) => message.id === reference.id) ?? null;
          break;
        }
        case "decision":
        case "file":
        default:
          payload = { type: reference.type, id: reference.id };
      }
      if (payload !== null && payload !== undefined) {
        items.push({ reference, payload });
      }
    }
    return { items };
  }

  async materialize(sessionId: string, references: ContextReference[], workspaceId: WorkspaceId): Promise<string> {
    const resolved = this.resolve(references, workspaceId);
    const sideband = new SidebandDirectory(sessionId);
    return sideband.writeInbox(resolved, { kind: "context", contextRefs: references });
  }
}
