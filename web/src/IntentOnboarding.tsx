import { useState } from "react";

const ONBOARDING_KEY = "chef:intent-onboarding-complete";

const steps = [
  {
    number: "01",
    title: "Choose the project",
    body: "Confirm the local project shown in the header, or open the folder you want Chef to work in. You can switch projects without opening Workbench.",
  },
  {
    number: "02",
    title: "Tell Chef the outcome",
    body: "Describe what you want done. You do not need to design a workflow, choose nodes, or assign agents first.",
  },
  {
    number: "03",
    title: "Watch Chef work",
    body: "Send the goal once, then stay on Home for progress, approvals, blockers, and the final result. Open Workbench only when you want deeper inspection or control.",
  },
] as const;

export function IntentOnboarding() {
  const [visible, setVisible] = useState(() => localStorage.getItem(ONBOARDING_KEY) !== "true");

  if (!visible) return null;

  const finish = () => {
    localStorage.setItem(ONBOARDING_KEY, "true");
    setVisible(false);
  };

  return (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/55 px-5 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="chef-onboarding-title">
      <div className="w-full max-w-2xl rounded-3xl border border-white/10 bg-[#111114]/98 p-6 shadow-[0_30px_120px_rgba(0,0,0,0.65)] sm:p-8">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-red-300/70">First mission</div>
            <h2 id="chef-onboarding-title" className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-white sm:text-3xl">
              Chef works from your project and intent.
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-zinc-500">
              The normal path is deliberately simple. Pick the project, give Chef the outcome, then stay here unless Chef asks you for something.
            </p>
          </div>
          <button
            type="button"
            onClick={finish}
            className="shrink-0 rounded-lg px-2 py-1 text-xs text-zinc-600 transition hover:bg-white/[0.05] hover:text-zinc-300"
            aria-label="Dismiss onboarding"
          >
            Skip
          </button>
        </div>

        <div className="mt-7 grid gap-3 sm:grid-cols-3">
          {steps.map((step) => (
            <div key={step.number} className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4">
              <div className="text-[10px] font-bold tracking-[0.16em] text-red-300/60">{step.number}</div>
              <div className="mt-3 text-sm font-semibold text-zinc-100">{step.title}</div>
              <p className="mt-2 text-xs leading-5 text-zinc-500">{step.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-6 flex flex-col gap-3 border-t border-white/[0.07] pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] leading-5 text-zinc-600">
            Happy path: <span className="text-zinc-400">project → type → send → watch → respond only if asked → result</span>
          </p>
          <button
            type="button"
            onClick={finish}
            autoFocus
            className="rounded-xl bg-red-400 px-4 py-2.5 text-xs font-bold text-[#190708] transition hover:bg-red-300"
          >
            Start with Chef
          </button>
        </div>
      </div>
    </div>
  );
}