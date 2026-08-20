import { useEffect, useState } from "react";
import { api, type OrchestratorProviderSettings } from "./api";

export function OrchestratorSettings({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<OrchestratorProviderSettings | null>(null);
  const [provider, setProvider] = useState("openai");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.orchestratorProvider().then((value) => {
      setSettings(value); setProvider(value.provider ?? "openai"); setModel(value.model); setBaseUrl(value.baseUrl ?? "");
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const save = async () => {
    setSaving(true); setError(null);
    try {
      await api.saveOrchestratorProvider({ provider, model, baseUrl, apiKey });
      for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        try { await api.orchestratorProvider(); window.location.reload(); return; } catch { /* restarting */ }
      }
      window.location.reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-4" onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}>
      <section className="w-full max-w-lg rounded-xl border border-[#30363d] bg-[#0d1117] p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div><h2 className="text-sm font-semibold">Orchestrator AI</h2><p className="mt-1 text-xs text-[#8b949e]">Only Chef's orchestrator uses this direct provider. CLI workers keep their own auth and model configuration.</p></div>
          <button onClick={onClose} className="text-[#8b949e] hover:text-white">×</button>
        </div>
        <div className="mt-4 grid gap-3 text-xs">
          <label>Provider<select value={provider} onChange={(e) => setProvider(e.target.value)} className="mt-1 w-full rounded border border-[#30363d] bg-[#010409] p-2"><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic</option><option value="custom">Custom OpenAI-compatible</option></select></label>
          <label>Model<input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-5.6 / claude-sonnet / provider model id" className="mt-1 w-full rounded border border-[#30363d] bg-[#010409] p-2" /></label>
          <label>Base URL <span className="text-[#6e7681]">(optional for built-in providers)</span><input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://openrouter.ai/api/v1" className="mt-1 w-full rounded border border-[#30363d] bg-[#010409] p-2" /></label>
          <label>API key<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={settings?.hasApiKey ? "Saved securely; leave blank to keep" : "API key"} className="mt-1 w-full rounded border border-[#30363d] bg-[#010409] p-2" /></label>
          <p className="text-[11px] text-[#6e7681]">On Windows, Chef encrypts the saved key with DPAPI for the current Windows user. Provider settings are machine-scoped, not stored in your project.</p>
          {error && <p className="rounded border border-red-500/30 bg-red-500/10 p-2 text-red-300">{error}</p>}
          <div className="flex justify-end gap-2"><button onClick={onClose} className="rounded border border-[#30363d] px-3 py-2">Cancel</button><button disabled={saving || !model.trim()} onClick={() => void save()} className="rounded bg-cyan-500 px-3 py-2 font-medium text-[#010409] disabled:opacity-50">{saving ? "Restarting Chef…" : "Save & restart"}</button></div>
        </div>
      </section>
    </div>
  );
}
