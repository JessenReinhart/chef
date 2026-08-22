import { useEffect, useState } from "react";
import type { GraphNode } from "../../src/core/graph.ts";
import { api } from "./api";

interface WideInspectorProps {
  selectedNode: GraphNode | null;
}

interface NodeConfigForm {
  model: string;
  temperature: string;
  maxTokens: string;
  permissions: string[];
  retryMax: string;
  retryBackoffMs: string;
  harnessCommand: string;
  harnessArgs: string;
  harnessCwd: string;
}

const DEFAULT_FORM: NodeConfigForm = {
  model: "",
  temperature: "0.2",
  maxTokens: "4096",
  permissions: [],
  retryMax: "2",
  retryBackoffMs: "1000",
  harnessCommand: "",
  harnessArgs: "",
  harnessCwd: "",
};

function nodeConfigToForm(config: Record<string, unknown>): NodeConfigForm {
  const retry = config.retry as Record<string, unknown> | undefined;
  const harness = config.harness as Record<string, unknown> | undefined;
  const rawArgs = config.harnessArgs ?? harness?.args;
  return {
    model: (config.model as string) ?? DEFAULT_FORM.model,
    temperature: String(config.temperature ?? DEFAULT_FORM.temperature),
    maxTokens: String(config.maxTokens ?? config.max_tokens ?? DEFAULT_FORM.maxTokens),
    permissions: Array.isArray(config.permissions) ? (config.permissions as string[]) : [],
    retryMax: String(config.retryMax ?? retry?.max ?? DEFAULT_FORM.retryMax),
    retryBackoffMs: String(config.retryBackoffMs ?? retry?.backoffMs ?? DEFAULT_FORM.retryBackoffMs),
    harnessCommand: (config.harnessCommand ?? harness?.command) as string ?? DEFAULT_FORM.harnessCommand,
    harnessArgs: Array.isArray(rawArgs)
      ? (rawArgs as string[]).join(" ")
      : String(rawArgs ?? ""),
    harnessCwd: (config.harnessCwd ?? harness?.cwd) as string ?? DEFAULT_FORM.harnessCwd,
  };
}

function formToConfig(form: NodeConfigForm): Record<string, unknown> {
  return {
    model: form.model || undefined,
    temperature: Number(form.temperature),
    maxTokens: Number(form.maxTokens),
    permissions: form.permissions,
    retry: {
      max: Number(form.retryMax),
      backoffMs: Number(form.retryBackoffMs),
    },
    harness: {
      command: form.harnessCommand || undefined,
      args: form.harnessArgs ? form.harnessArgs.split(/\s+/) : undefined,
      cwd: form.harnessCwd || undefined,
    },
  };
}

function mergeConfig(existing: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const existingRetry = existing.retry && typeof existing.retry === "object"
    ? existing.retry as Record<string, unknown>
    : {};
  const existingHarness = existing.harness && typeof existing.harness === "object"
    ? existing.harness as Record<string, unknown>
    : {};
  return {
    ...existing,
    ...next,
    retry: { ...existingRetry, ...(next.retry as Record<string, unknown>) },
    harness: { ...existingHarness, ...(next.harness as Record<string, unknown>) },
  };
}

function validateForm(form: NodeConfigForm): string | null {
  const temperature = Number(form.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    return "Temperature must be between 0 and 2";
  }
  const maxTokens = Number(form.maxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    return "Max tokens must be a positive integer";
  }
  const retryMax = Number(form.retryMax);
  if (!Number.isInteger(retryMax) || retryMax < 0) {
    return "Retries must be a non-negative integer";
  }
  const retryBackoffMs = Number(form.retryBackoffMs);
  if (!Number.isInteger(retryBackoffMs) || retryBackoffMs < 0) {
    return "Retry backoff must be a non-negative integer (ms)";
  }
  return null;
}

export function WideInspector({ selectedNode }: WideInspectorProps) {
  const [form, setForm] = useState<NodeConfigForm>(DEFAULT_FORM);
  const [permissionInput, setPermissionInput] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedNode) {
      setForm(nodeConfigToForm(selectedNode.config));
      setSaveState("idle");
      setSaveError(null);
      setValidationError(null);
    }
  }, [selectedNode]);

  if (!selectedNode) {
    return (
      <div className="wb-wide-inspector" role="region" aria-label="Wide inspector">
        <div className="wb-wide-inspector__header">
          <h3 className="wb-wide-inspector__title">Node Inspector</h3>
        </div>
        <div className="wb-wide-inspector__empty">Select a node on the canvas to edit its configuration.</div>
      </div>
    );
  }

  const updateField = <K extends keyof NodeConfigForm>(key: K, value: NodeConfigForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaveState("idle");
    setValidationError(null);
  };

  const addPermission = () => {
    const trimmed = permissionInput.trim();
    if (!trimmed) return;
    if (!form.permissions.includes(trimmed)) {
      updateField("permissions", [...form.permissions, trimmed]);
    }
    setPermissionInput("");
  };

  const removePermission = (permission: string) => {
    updateField("permissions", form.permissions.filter((p) => p !== permission));
  };

  const handleSave = async () => {
    const error = validateForm(form);
    if (error) {
      setValidationError(error);
      return;
    }

    const taskId = selectedNode.taskId;

    if (!taskId) {
      // Node has no runtime task yet — the runtime is authoritative, so there
      // is nothing to persist. Keep a local draft and show a clear status.
      setSaveState("saved");
      return;
    }

    setSaveState("saving");
    setSaveError(null);
    try {
      const config = mergeConfig(selectedNode.config, formToConfig(form));
      await api.patchNode(taskId, { config });
      setSaveState("saved");
    } catch (err) {
      setSaveState("error");
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="wb-wide-inspector" role="region" aria-label="Wide inspector">
      <div className="wb-wide-inspector__header">
        <h3 className="wb-wide-inspector__title">Node Inspector</h3>
        <div className="wb-wide-inspector__node-id">{selectedNode.id}</div>
        <span className={`wb-status-dot wb-status-dot--${selectedNode.status ?? "pending"}`} />
      </div>

      {saveState === "saved" && (
        <div className="wb-wide-inspector__toast wb-wide-inspector__toast--ok" role="status">
          Config saved
        </div>
      )}
      {saveState === "error" && (
        <div className="wb-wide-inspector__toast wb-wide-inspector__toast--error" role="alert">
          Save failed: {saveError}
        </div>
      )}
      {validationError && (
        <div className="wb-wide-inspector__toast wb-wide-inspector__toast--error" role="alert">
          {validationError}
        </div>
      )}

      <div className="wb-wide-inspector__columns">
        <div className="wb-wide-inspector__column">
          <div className="wb-wide-inspector__section">
            <h4 className="wb-wide-inspector__section-title">Model</h4>
            <label className="wb-wide-inspector__field">
              <span className="wb-wide-inspector__label">Model</span>
              <input
                className="wb-wide-inspector__input"
                type="text"
                value={form.model}
                onChange={(e) => updateField("model", e.target.value)}
                placeholder="e.g. claude-sonnet-4-5"
                spellCheck={false}
              />
            </label>
            <label className="wb-wide-inspector__field">
              <span className="wb-wide-inspector__label">Temperature</span>
              <input
                className="wb-wide-inspector__input"
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={form.temperature}
                onChange={(e) => updateField("temperature", e.target.value)}
              />
            </label>
            <label className="wb-wide-inspector__field">
              <span className="wb-wide-inspector__label">Max tokens</span>
              <input
                className="wb-wide-inspector__input"
                type="number"
                step="1"
                min="1"
                value={form.maxTokens}
                onChange={(e) => updateField("maxTokens", e.target.value)}
              />
            </label>
          </div>

          <div className="wb-wide-inspector__section">
            <h4 className="wb-wide-inspector__section-title">Permissions</h4>
            <div className="wb-wide-inspector__permission-input">
              <input
                className="wb-wide-inspector__input"
                type="text"
                value={permissionInput}
                onChange={(e) => setPermissionInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addPermission();
                  }
                }}
                placeholder="e.g. bash:read, web:search"
                spellCheck={false}
              />
              <button className="wb-btn wb-btn--secondary wb-btn--sm" onClick={addPermission}>
                Add
              </button>
            </div>
            {form.permissions.length > 0 ? (
              <ul className="wb-wide-inspector__permissions-list">
                {form.permissions.map((permission) => (
                  <li key={permission} className="wb-wide-inspector__permission-tag">
                    <code>{permission}</code>
                    <button
                      className="wb-wide-inspector__permission-remove"
                      onClick={() => removePermission(permission)}
                      aria-label={`Remove permission ${permission}`}
                      title={`Remove ${permission}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="wb-wide-inspector__hint">No permissions granted yet.</p>
            )}
          </div>
        </div>

        <div className="wb-wide-inspector__column">
          <div className="wb-wide-inspector__section">
            <h4 className="wb-wide-inspector__section-title">Retry</h4>
            <label className="wb-wide-inspector__field">
              <span className="wb-wide-inspector__label">Max retries</span>
              <input
                className="wb-wide-inspector__input"
                type="number"
                step="1"
                min="0"
                value={form.retryMax}
                onChange={(e) => updateField("retryMax", e.target.value)}
              />
            </label>
            <label className="wb-wide-inspector__field">
              <span className="wb-wide-inspector__label">Backoff (ms)</span>
              <input
                className="wb-wide-inspector__input"
                type="number"
                step="100"
                min="0"
                value={form.retryBackoffMs}
                onChange={(e) => updateField("retryBackoffMs", e.target.value)}
              />
            </label>
          </div>

          <div className="wb-wide-inspector__section">
            <h4 className="wb-wide-inspector__section-title">Harness</h4>
            <label className="wb-wide-inspector__field">
              <span className="wb-wide-inspector__label">Command</span>
              <input
                className="wb-wide-inspector__input"
                type="text"
                value={form.harnessCommand}
                onChange={(e) => updateField("harnessCommand", e.target.value)}
                placeholder="e.g. /bin/sh"
                spellCheck={false}
              />
            </label>
            <label className="wb-wide-inspector__field">
              <span className="wb-wide-inspector__label">Args</span>
              <input
                className="wb-wide-inspector__input"
                type="text"
                value={form.harnessArgs}
                onChange={(e) => updateField("harnessArgs", e.target.value)}
                placeholder="e.g. -c npm test"
                spellCheck={false}
              />
            </label>
            <label className="wb-wide-inspector__field">
              <span className="wb-wide-inspector__label">Working dir</span>
              <input
                className="wb-wide-inspector__input"
                type="text"
                value={form.harnessCwd}
                onChange={(e) => updateField("harnessCwd", e.target.value)}
                placeholder="e.g. /workspace"
                spellCheck={false}
              />
            </label>
          </div>
        </div>
      </div>

      <div className="wb-wide-inspector__footer">
        <button
          className="wb-btn wb-btn--primary"
          onClick={() => void handleSave()}
          disabled={saveState === "saving"}
        >
          {saveState === "saving" ? "Saving…" : "Save Config"}
        </button>
        {!selectedNode.taskId && (
          <span className="wb-wide-inspector__hint">
            Draft only — this node has no runtime task yet; the runtime remains authoritative.
          </span>
        )}
      </div>
    </div>
  );
}
