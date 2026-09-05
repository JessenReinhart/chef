import { strict as assert } from "node:assert";
import { archiveThread, createThread } from "../web/src/threadApi.ts";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem(key: string) { return storage.get(key) ?? null; },
    setItem(key: string, value: string) { storage.set(key, value); },
    removeItem(key: string) { storage.delete(key); },
    clear() { storage.clear(); },
  },
});

type DeferredResponse = {
  resolve: (response: { ok: boolean; json: () => Promise<unknown> }) => void;
  promise: Promise<{ ok: boolean; json: () => Promise<unknown> }>;
};

function deferredResponse(): DeferredResponse {
  let resolve!: DeferredResponse["resolve"];
  const promise = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((done) => { resolve = done; });
  return { resolve, promise };
}

function okJson(data: unknown) {
  return { ok: true, json: async () => ({ ok: true, data }) };
}

const createdThread = {
  id: "thread-created",
  workspaceId: "workspace-1",
  title: "New thread",
  status: "active" as const,
  createdAt: 10,
  updatedAt: 10,
};
const archivedThread = {
  id: "thread-a",
  workspaceId: "workspace-1",
  title: "Thread A",
  status: "archived" as const,
  createdAt: 1,
  updatedAt: 20,
};

storage.set("chef:view-mode", "simple");
storage.set("chef:selected-thread", "thread-a");
let request = deferredResponse();
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  writable: true,
  value: async () => request.promise,
});

const lateCreate = createThread("New thread");
storage.set("chef:selected-thread", "thread-b");
request.resolve(okJson(createdThread));
await assert.rejects(
  lateCreate,
  /Thread selection changed while the action was completing/,
  "late New Thread success must not settle into a different foreground Thread",
);
assert.equal(
  storage.get("chef:selected-thread"),
  "thread-b",
  "late New Thread success must leave the user's newer foreground selection untouched",
);

storage.set("chef:selected-thread", "thread-a");
request = deferredResponse();
const currentCreate = createThread("New thread");
request.resolve(okJson(createdThread));
assert.deepEqual(
  await currentCreate,
  createdThread,
  "New Thread creation should settle normally while its initiating foreground still owns Simple Mode",
);

storage.set("chef:selected-thread", "thread-a");
request = deferredResponse();
const lateArchive = archiveThread("thread-a");
storage.set("chef:selected-thread", "thread-b");
request.resolve(okJson(archivedThread));
await assert.rejects(
  lateArchive,
  /Thread selection changed while the action was completing/,
  "late archive success must not settle into a different foreground Thread",
);
assert.equal(
  storage.get("chef:selected-thread"),
  "thread-b",
  "late archive success must leave the user's newer foreground selection untouched",
);

storage.set("chef:selected-thread", "thread-a");
request = deferredResponse();
const currentArchive = archiveThread("thread-a");
request.resolve(okJson(archivedThread));
assert.deepEqual(
  await currentArchive,
  archivedThread,
  "archive should settle normally while the archived Thread still owns the foreground",
);

storage.set("chef:view-mode", "power");
storage.set("chef:selected-thread", "thread-a");
request = deferredResponse();
const powerModeCreate = createThread("Power mode thread");
storage.set("chef:selected-thread", "thread-b");
request.resolve(okJson(createdThread));
assert.deepEqual(
  await powerModeCreate,
  createdThread,
  "Power Mode must not inherit Simple Mode foreground-settlement policy",
);

console.log("thread-action-foreground-race: ok — late successful Simple Mode Thread mutations cannot steal newer foreground selection");
