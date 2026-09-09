import { strict as assert } from "node:assert";

import {
  clearMissionSubmissionFailure,
  missionSubmissionAcknowledgement,
  missionSubmissionFailureRecovery,
  rememberMissionSubmissionFailure,
  takeMissionSubmissionFailure,
} from "../web/src/missionSubmissionFeedback.ts";
import {
  loadSelectedThreadId,
  saveSelectedThreadId,
  sendThreadMessage,
} from "../web/src/threadApi.ts";
import { createThreadHistoryLoader } from "../web/src/threadSelection.ts";
import {
  persistWorkspaceDepth,
  readPersistedWorkspaceDepth,
  requestedWorkspaceDepth,
} from "../web/src/canonicalWorkspaceModel.ts";
import type { ChatMessage } from "../web/src/types.ts";

const originalFetch = globalThis.fetch;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const threadARecovery = missionSubmissionFailureRecovery("Create a simple todo app", "Provider unavailable");
const threadBRecovery = missionSubmissionFailureRecovery("Create a notes app", "Provider unavailable");

try {
  rememberMissionSubmissionFailure("thread-a", threadARecovery);
  rememberMissionSubmissionFailure("thread-b", threadBRecovery);

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      dispatchEvent() { return true; },
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("Storage access denied", "SecurityError");
    },
  });

  assert.equal(
    readPersistedWorkspaceDepth(),
    "simple",
    "denied browser storage must fail safe to the canonical Simple Mode workspace instead of aborting app boot",
  );
  assert.equal(
    readPersistedWorkspaceDepth() !== "power",
    true,
    "the living workspace must remain enabled when storage access is denied",
  );
  assert.equal(
    persistWorkspaceDepth("power"),
    false,
    "workspace-depth persistence must report denial without throwing into the current session",
  );
  assert.equal(
    requestedWorkspaceDepth("simple"),
    "simple",
    "denied storage must keep Runtime details from mounting a surface that still requires browser persistence",
  );

  assert.equal(
    missionSubmissionAcknowledgement(),
    "Got it. I’m starting this now.",
    "blocked browser storage must not prevent Simple Mode from acknowledging accepted work",
  );
  assert.deepEqual(
    takeMissionSubmissionFailure("thread-a"),
    threadARecovery,
    "when Thread ownership cannot be read, acknowledgement must not guess and clear another recovery owner",
  );
  assert.deepEqual(
    takeMissionSubmissionFailure("thread-b"),
    threadBRecovery,
    "storage failure must leave unrelated Thread recovery state untouched",
  );

  assert.equal(loadSelectedThreadId(), null, "blocked storage must fail open to an empty session selection instead of throwing");
  saveSelectedThreadId("thread-a");
  assert.equal(
    loadSelectedThreadId(),
    "thread-a",
    "Thread selection must remain usable in-memory for the current session when persistent storage is denied",
  );

  const historyResolvers = new Map<string, (messages: ChatMessage[]) => void>();
  const historyLoader = createThreadHistoryLoader((threadId) => new Promise<ChatMessage[]>((resolve) => {
    historyResolvers.set(threadId, resolve);
  }));
  assert.doesNotThrow(
    () => historyLoader.snapshot(),
    "Thread-history ownership snapshots must treat denied browser storage as optional instead of crashing Simple Mode",
  );
  const threadAHistory = historyLoader.load("thread-a");
  const threadBHistory = historyLoader.load("thread-b");
  historyResolvers.get("thread-b")?.([]);
  assert.deepEqual(
    await threadBHistory,
    { current: true, messages: [] },
    "the newest explicit Thread history load must remain authoritative while storage is denied",
  );
  historyResolvers.get("thread-a")?.([]);
  assert.deepEqual(
    await threadAHistory,
    { current: false },
    "an older Thread history response must stay non-authoritative after the user moves to another Thread",
  );

  let chatRequests = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/threads/thread-a/chat")) {
      chatRequests += 1;
      return new Response(JSON.stringify({
        ok: true,
        data: {
          ok: true,
          accepted: true,
          taskIds: [],
          report: "",
          missionId: "mission-storage-blocked",
          threadId: "thread-a",
        },
      }), { status: 202, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request ${url}`);
  };

  const blockedStorageSubmission = await sendThreadMessage("thread-a", "Create a simple todo app");
  assert.equal(
    blockedStorageSubmission.missionId,
    "mission-storage-blocked",
    "canonical Thread-chat submission must reach its HTTP acknowledgement even when localStorage is denied",
  );
  assert.equal(chatRequests, 1, "blocked storage must not prevent the canonical Thread chat request from being sent");

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: undefined,
  });
  assert.equal(
    readPersistedWorkspaceDepth(),
    "simple",
    "completely unavailable browser storage must also fail safe to Simple Mode",
  );
  assert.equal(
    persistWorkspaceDepth("power"),
    false,
    "workspace-depth persistence must not report success when no storage exists",
  );
  assert.equal(
    requestedWorkspaceDepth("simple"),
    "simple",
    "unavailable storage must not authorize Runtime details when no workspace-depth value can be persisted",
  );

  const healthyStorage = new Map<string, string>([["chef:selected-thread", "thread-a"]]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        return healthyStorage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        healthyStorage.set(key, value);
      },
    },
  });

  assert.equal(
    readPersistedWorkspaceDepth() !== "power",
    true,
    "the living workspace must remain enabled when healthy storage has no Power Mode selection",
  );
  assert.equal(
    requestedWorkspaceDepth("simple"),
    "power",
    "healthy storage must still allow the user to enter Runtime details",
  );
  assert.equal(
    healthyStorage.get("chef:view-mode"),
    "power",
    "entering Runtime details must preserve the existing persisted workspace-depth contract",
  );
  assert.equal(
    readPersistedWorkspaceDepth() !== "power",
    false,
    "the living workspace must disable once healthy storage authoritatively selects Power Mode",
  );
  assert.equal(
    missionSubmissionAcknowledgement(),
    "Got it. I’m starting this now.",
    "the normal acknowledgement contract must remain unchanged when storage is available",
  );
  assert.equal(
    takeMissionSubmissionFailure("thread-a"),
    null,
    "an available selected-Thread owner must still clear its stale retry state",
  );
  assert.deepEqual(
    takeMissionSubmissionFailure("thread-b"),
    threadBRecovery,
    "clearing the selected Thread's stale retry state must not affect another Thread",
  );
} finally {
  globalThis.fetch = originalFetch;
  clearMissionSubmissionFailure("thread-a");
  clearMissionSubmissionFailure("thread-b");
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    delete (globalThis as { window?: Window }).window;
  }
}

console.log("storage-blocked-submission-ack: ok — workspace boot/depth, living workspace mode, selection, history ownership, acknowledgement, and canonical Thread chat survive denied or unavailable browser storage");
