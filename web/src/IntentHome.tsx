import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import {
  archiveThread,
  createThread,
  listThreads,
  loadSelectedThreadId,
  renameThread,
  saveSelectedThreadId,
  sendThreadMessage,
  threadMessages,
  type UiThread,
} from "./threadApi";
import type { ChatMessage, UiMission, UiTask } from "./types";

type Approval = { id: string; reason: string; taskId: string; status: string };
type HomeState = "ready" | "working" | "attention" | "done";

function taskPresentation(status: UiTask["status"]): { label: string; dot: string; text: string } {
  if (status === "completed") return { label: "Done", dot: "bg-emerald-400", text: "text-emerald-300" };
  if (status === "failed" || status === "blocked" || status === "cancelled") {
    return { label: "Needs attention", dot: "bg-rose-400", text: "text-rose-300" };
  }
  if (status === "running" || status === "assigned" || status === "spawning") {
    return { label: "Working", dot: "bg-red-400", text: "text-red-300" };
  }
  return { label: "Waiting", dot: "bg-slate-500", text: "text-slate-400" };
}

function missionPresentation(state: HomeState): { label: string; dot: string; ring: string } {
  if (state === "working") return { label: "Chef is working", dot: "bg-red-400", ring: "shadow-[0_0_0_5px_rgba(248,113,113,0.10)]" };
  if (state === "attention") return { label: "Needs your attention", dot: "bg-amber-300", ring: "shadow-[0_0_0_5px_rgba(252,211,77,0.10)]" };
  if (state === "done") return { label: "Work complete", dot: "bg-emerald-400", ring: "shadow-[0_0_0_5px_rgba(52,211,153,0.10)]" };
  return { label: "Ready", dot: "bg-slate-500", ring: "" };
}

function titleFromMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.length <= 48 ? normalized : `${normalized.slice(0, 45)}…`;
}

export function IntentHome({ onOpenWorkbench }: { onOpenWorkbench: () => void }) {
  const [tasks, setTasks] = useState<UiTask[]>([]);
  const [missions, setMissions] = useState<UiMission[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [threads, setThreads] = useState<UiThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(() => loadSelectedThreadId());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [goal, setGoal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [creatingThread, setCreatingThread] = useState(false);
  const [managingThread, setManagingThread] = useState(false);
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastReport, setLastReport] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [snapshot, listedThreads] = await Promise.all([api.stateRaw(), listThreads()]);
      const activeThreads = listedThreads.filter((thread) => thread.status === "active");
      const rememberedId = selectedThreadId ?? loadSelectedThreadId();
      const selected = activeThreads.find((thread) => thread.id === rememberedId) ?? activeThreads[0] ?? null;
      const selectedMessages = selected ? await threadMessages(selected.id) : [];

      setTasks(snapshot.tasks);
      setMissions(snapshot.missions ?? []);
      setApprovals(snapshot.approvals.filter((approval) => approval.status === "pending"));
      setThreads(listedThreads);
      setMessages(selectedMessages);
      setSelectedThreadId(selected?.id ?? null);
      saveSelectedThreadId(selected?.id ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chef could not refresh the workspace");
    }
  }, [selectedThreadId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1800);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [selectedThreadId, threads],
  );

  const threadMissions = useMemo(() => {
    if (!selectedThreadId) return [];
    return missions.filter((mission) => mission.metadata?.threadId === selectedThreadId);
  }, [missions, selectedThreadId]);

  const latestMission = useMemo(
    () => [...threadMissions].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null,
    [threadMissions],
  );

  const missionTasks = useMemo(() => {
    if (!latestMission) return [];
    const ids = new Set(latestMission.taskIds);
    return tasks.filter((task) => ids.has(task.id)).slice(-6).reverse();
  }, [latestMission, tasks]);

  const missionApprovals = useMemo(() => {
    if (!latestMission) return [];
    const ids = new Set(latestMission.taskIds);
    return approvals.filter((approval) => ids.has(approval.taskId));
  }, [approvals, latestMission]);

  const approvalTaskIds = useMemo(
    () => new Set(missionApprovals.map((approval) => approval.taskId)),
    [missionApprovals],
  );

  const homeState = useMemo<HomeState>(() => {
    if (missionApprovals.length > 0 || missionTasks.some((task) => task.status === "failed" || task.status === "blocked")) return "attention";
    if (missionTasks.some((task) => task.status === "running" || task.status === "assigned" || task.status === "spawning")) return "working";
    if (latestMission?.status === "completed" || (missionTasks.length > 0 && missionTasks.every((task) => task.status === "completed"))) return "done";
    return "ready";
  }, [latestMission?.status, missionApprovals.length, missionTasks]);

  const status = missionPresentation(homeState);
  const latestAssistantMessage = useMemo(
    () => [...messages].reverse().find((message) => message.role === "assistant")?.content ?? null,
    [messages],
  );

  async function selectThread(threadId: string) {
    saveSelectedThreadId(threadId);
    setSelectedThreadId(threadId);
    setLastReport(null);
    try {
      setMessages(await threadMessages(threadId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chef could not open this Thread");
    }
  }

  async function startNewThread() {
    if (creatingThread) return;
    setCreatingThread(true);
    setError(null);
    try {
      const thread = await createThread("New thread");
      setThreads((current) => [...current, thread]);
      saveSelectedThreadId(thread.id);
      setSelectedThreadId(thread.id);
      setMessages([]);
      setLastReport(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chef could not create a Thread");
    } finally {
      setCreatingThread(false);
    }
  }

  async function renameSelectedThread() {
    if (!selectedThread || managingThread) return;
    const nextTitle = window.prompt("Rename Thread", selectedThread.title)?.trim();
    if (!nextTitle || nextTitle === selectedThread.title) return;
    setManagingThread(true);
    setError(null);
    try {
      const updated = await renameThread(selectedThread.id, nextTitle);
      setThreads((current) => current.map((thread) => thread.id === updated.id ? updated : thread));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chef could not rename this Thread");
    } finally {
      setManagingThread(false);
    }
  }

  async function archiveSelectedThread() {
    if (!selectedThread || managingThread) return;
    if (!window.confirm(`Archive “${selectedThread.title}”? You can keep its history, but it will leave the active Thread list.`)) return;
    setManagingThread(true);
    setError(null);
    try {
      const archived = await archiveThread(selectedThread.id);
      const nextThreads = threads.map((thread) => thread.id === archived.id ? archived : thread);
      const nextActive = nextThreads.find((thread) => thread.status === "active") ?? null;
      setThreads(nextThreads);
      setSelectedThreadId(nextActive?.id ?? null);
      saveSelectedThreadId(nextActive?.id ?? null);
      setMessages(nextActive ? await threadMessages(nextActive.id) : []);
      setLastReport(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chef could not archive this Thread");
    } finally {
      setManagingThread(false);
    }
  }

  async function submitGoal() {
    const message = goal.trim();
    if (!message || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      let threadId = selectedThreadId;
      if (!threadId) {
        const thread = await createThread(titleFromMessage(message));
        setThreads((current) => [...current, thread]);
        threadId = thread.id;
        saveSelectedThreadId(thread.id);
        setSelectedThreadId(thread.id);
      }
      const result = await sendThreadMessage(threadId, message);
      setGoal("");
      setLastReport(result.report || null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chef could not start this work");
    } finally {
      setSubmitting(false);
    }
  }

  async function decideApproval(id: string, decision: "accept" | "reject") {
    try {
      await api.approve(id, decision);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chef could not update the approval");
    }
  }

  async function retryTask(taskId: string) {
    if (retryingTaskId) return;
    setRetryingTaskId(taskId);
    setError(null);
    try {
      await api.retryNode(taskId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chef could not retry this work");
    } finally {
      setRetryingTaskId(null);
    }
  }

  return (
    <div className="relative h-screen w-screen overflow-auto bg-[#09090b] text-zinc-100 selection:bg-red-400 selection:text-black">
      <div
        className="pointer-events-none fixed inset-0 opacity-80"
        style={{ background: "radial-gradient(circle at 50% -10%, rgba(239,68,68,0.16), transparent 36%), radial-gradient(circle at 12% 78%, rgba(255,255,255,0.035), transparent 28%)" }}
      />

      <header className="relative z-10 mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <div className="grid h-8 w-8 place-items-center rounded-xl border border-red-400/20 bg-red-400/10 shadow-[0_0_24px_rgba(248,113,113,0.08)]">
            <span className="text-sm font-black text-red-300">C</span>
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight">Chef</div>
            <div className="text-[10px] text-zinc-600">Local AI workspace</div>
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenWorkbench}
          className="rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2 text-xs font-medium text-zinc-400 transition hover:border-white/20 hover:bg-white/[0.07] hover:text-zinc-100"
        >
          Open Workbench
        </button>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-4xl flex-col px-6 pb-16 pt-[7vh] sm:pt-[9vh]">
        <section className="mx-auto w-full max-w-3xl text-center">
          <div className="mb-4 flex items-center justify-center gap-2 overflow-x-auto pb-1" aria-label="Conversation Threads">
            {threads.filter((thread) => thread.status === "active").map((thread) => (
              <button
                key={thread.id}
                type="button"
                onClick={() => void selectThread(thread.id)}
                aria-pressed={thread.id === selectedThreadId}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-[11px] transition ${
                  thread.id === selectedThreadId
                    ? "border-red-300/30 bg-red-300/[0.09] text-red-200"
                    : "border-white/[0.08] bg-black/20 text-zinc-500 hover:border-white/15 hover:text-zinc-300"
                }`}
              >
                {thread.title}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void startNewThread()}
              disabled={creatingThread}
              className="shrink-0 rounded-full border border-dashed border-white/10 px-3 py-1.5 text-[11px] text-zinc-500 transition hover:border-red-300/30 hover:text-red-200 disabled:opacity-40"
            >
              {creatingThread ? "Creating…" : "+ New thread"}
            </button>
          </div>

          <div className="mb-3 flex items-center justify-center gap-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-black/20 px-3 py-1.5 text-[11px] font-medium text-zinc-400 backdrop-blur">
              <span className={`h-1.5 w-1.5 rounded-full ${status.dot} ${status.ring}`} />
              {status.label}
              {selectedThread && <span className="text-zinc-600">· {selectedThread.title}</span>}
            </div>
            {selectedThread && (
              <div className="flex items-center gap-1" aria-label="Selected Thread actions">
                <button
                  type="button"
                  onClick={() => void renameSelectedThread()}
                  disabled={managingThread}
                  className="rounded-lg border border-white/[0.08] px-2 py-1 text-[10px] text-zinc-500 transition hover:border-white/15 hover:text-zinc-200 disabled:opacity-40"
                >
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => void archiveSelectedThread()}
                  disabled={managingThread}
                  className="rounded-lg border border-white/[0.08] px-2 py-1 text-[10px] text-zinc-600 transition hover:border-rose-300/20 hover:text-rose-300 disabled:opacity-40"
                >
                  Archive
                </button>
              </div>
            )}
          </div>
          <h1 className="text-balance text-4xl font-semibold tracking-[-0.04em] text-white sm:text-5xl">
            What are we doing?
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-6 text-zinc-500">
            Give Chef the outcome. Chef keeps this conversation and its work together in the selected Thread.
          </p>

          <form
            className="mt-8 rounded-2xl border border-white/10 bg-[#111114]/95 p-2 text-left shadow-[0_30px_90px_rgba(0,0,0,0.38)] backdrop-blur"
            onSubmit={(event) => {
              event.preventDefault();
              void submitGoal();
            }}
          >
            <textarea
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submitGoal();
                }
              }}
              rows={3}
              placeholder="Fix the login bug, investigate the report, prepare a summary…"
              className="block w-full resize-none bg-transparent px-4 py-3 text-[15px] leading-6 text-zinc-100 outline-none placeholder:text-zinc-700"
              aria-label="Tell Chef what you want to accomplish"
            />
            <div className="flex items-center justify-between border-t border-white/[0.06] px-2 pt-2">
              <span className="px-2 text-[10px] text-zinc-700">Enter to send · Shift+Enter for a new line</span>
              <button
                type="submit"
                disabled={!goal.trim() || submitting}
                className="rounded-xl bg-red-400 px-4 py-2 text-xs font-bold text-[#190708] transition hover:bg-red-300 disabled:cursor-not-allowed disabled:opacity-30"
              >
                {submitting ? "Starting…" : "Give to Chef"}
              </button>
            </div>
          </form>

          {messages.length > 0 && (
            <div className="mt-4 rounded-2xl border border-white/[0.07] bg-black/20 p-4 text-left" aria-label="Selected Thread history">
              <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-600">Recent conversation</div>
              <div className="space-y-2">
                {messages.slice(-4).map((message, index) => (
                  <div key={`${message.timestamp}-${index}`} className="flex gap-2 text-xs leading-5">
                    <span className="w-9 shrink-0 text-[10px] font-semibold uppercase text-zinc-600">{message.role === "user" ? "You" : "Chef"}</span>
                    <span className="line-clamp-2 text-zinc-400">{message.content}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] px-4 py-3 text-left text-xs text-rose-300" role="alert">
              {error}
            </div>
          )}
        </section>

        {(latestMission || missionApprovals.length > 0 || missionTasks.length > 0 || latestAssistantMessage || lastReport) && (
          <section className="mt-12 grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-600">Current work</div>
                  <h2 className="mt-2 truncate text-base font-semibold text-zinc-100">
                    {latestMission?.goal ?? "Thread activity"}
                  </h2>
                </div>
                <div className="flex shrink-0 items-center gap-2 rounded-full border border-white/[0.07] px-2.5 py-1 text-[10px] text-zinc-500">
                  <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                  {status.label}
                </div>
              </div>

              <div className="mt-5 space-y-1">
                {missionTasks.length > 0 ? missionTasks.map((task) => {
                  const presentation = taskPresentation(task.status);
                  const canRetry = task.status === "failed" || (task.status === "blocked" && !approvalTaskIds.has(task.id));
                  return (
                    <div key={task.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition hover:bg-white/[0.025]">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${presentation.dot}`} />
                      <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">{task.title}</span>
                      {canRetry ? (
                        <button
                          type="button"
                          onClick={() => void retryTask(task.id)}
                          disabled={retryingTaskId !== null}
                          className="rounded-lg border border-rose-300/20 bg-rose-300/[0.05] px-2.5 py-1 text-[10px] font-semibold text-rose-200 transition hover:bg-rose-300/[0.1] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {retryingTaskId === task.id ? "Retrying…" : "Retry"}
                        </button>
                      ) : (
                        <span className={`text-[10px] font-medium ${presentation.text}`}>{presentation.label}</span>
                      )}
                    </div>
                  );
                }) : (
                  <div className="rounded-xl border border-dashed border-white/[0.07] px-4 py-6 text-center text-xs text-zinc-600">
                    Chef is ready for a new goal in this Thread.
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={onOpenWorkbench}
                className="mt-4 text-[11px] font-medium text-zinc-500 transition hover:text-zinc-200"
              >
                Inspect work in Workbench →
              </button>
            </div>

            <div className="space-y-4">
              {missionApprovals.length > 0 && (
                <div className="rounded-2xl border border-amber-300/20 bg-amber-300/[0.05] p-5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300/60">Needs your attention</div>
                  {missionApprovals.slice(0, 2).map((approval) => (
                    <div key={approval.id} className="mt-3 border-t border-amber-200/10 pt-3 first:border-0 first:pt-0">
                      <p className="text-xs leading-5 text-zinc-300">{approval.reason}</p>
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          onClick={() => void decideApproval(approval.id, "accept")}
                          className="rounded-lg bg-amber-200 px-3 py-1.5 text-[10px] font-bold text-amber-950"
                        >
                          Allow
                        </button>
                        <button
                          type="button"
                          onClick={() => void decideApproval(approval.id, "reject")}
                          className="rounded-lg border border-white/10 px-3 py-1.5 text-[10px] font-medium text-zinc-400 hover:text-zinc-100"
                        >
                          Deny
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {(lastReport || latestAssistantMessage) && (
                <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-600">Latest from Chef</div>
                  <p className="mt-3 line-clamp-6 whitespace-pre-wrap text-xs leading-5 text-zinc-400">
                    {lastReport ?? latestAssistantMessage}
                  </p>
                </div>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
