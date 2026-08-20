/**
 * Chef Workbench — Setup Wizard for Simple Mode templates.
 *
 * Guided step-by-step flow for template parameters with plain language labels,
 * progressive disclosure, and a review step before adding the setup to the workspace.
 */

import { useState, useEffect, useCallback } from "react";
import type { Template } from "../../src/persistence/database.ts";
import { NodeIcon, NODE_LIBRARY } from "./nodeCatalog.tsx";
import { getSimpleFields, mapSimpleToRuntime, SimpleField } from "./simpleNodeConfig.tsx";
import "./workbench.css";

// ---------------------------------------------------------------------------
// Types (aligned with TemplateGallery and simpleNodeConfig)
// ---------------------------------------------------------------------------

/** A user-facing parameter for a template node (matches SimpleField). */
export interface WizardParameter {
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  nodeDescription: string;
  key: string;
  label: string;
  description: string;
  type: "file" | "text" | "number" | "select" | "multiselect" | "boolean" | "recipients" | "textarea" | "checkbox";
  required: boolean;
  options?: { value: string; label: string }[];
  defaultValue?: unknown;
  advanced?: boolean;
  help?: string;
  validation?: (value: unknown) => string | undefined;
}

/** Collected answers for a template (per-node key/value). */
export interface WizardAnswers {
  [nodeId: string]: Record<string, unknown>;
}

/** Draft template ready to be instantiated. */
export interface TemplateDraft {
  templateId: string;
  name: string;
  description: string;
  answers: WizardAnswers;
  previewGraph: {
    nodes: Array<{
      id: string;
      type: string;
      label: string;
      config: Record<string, unknown>;
    }>;
    edges: Array<{ source: string; target: string; kind: string }>;
  };
}

/** Template with expanded parameter definitions. */
export interface TemplateWithParams extends Template {
  parameters: WizardParameter[];
}

/** Validation result. */
export interface ValidationResult {
  valid: boolean;
  errors: Array<{ nodeId: string; key: string; message: string }>;
}

// ---------------------------------------------------------------------------
// Node type mapping (template runtime types -> simple config types)
// ---------------------------------------------------------------------------

const SIMPLE_TYPE_MAP: Record<string, string> = {
  "agent.llm": "task",
  "tool.file": "file",
  "tool.transform": "transform",
  "tool.browser": "browser",
  "tool.output": "output",
  "tool.terminal": "terminal",
  "tool.database": "database",
  "control.logic": "logic",
  "human.approval": "approval",
  "human.input": "input",
};

function toSimpleType(nodeType: string): string {
  return SIMPLE_TYPE_MAP[nodeType] ?? nodeType;
}

// ---------------------------------------------------------------------------
// Parameter definitions using simpleNodeConfig
// ---------------------------------------------------------------------------

export function getTemplateParameters(template: Template): WizardParameter[] {
  const params: WizardParameter[] = [];

  // Get the nodes from template
  const templateNodes = (template.nodes as Array<{ id: string; type: string; title?: string; config?: Record<string, unknown> }>) ?? [];

  templateNodes.forEach((node) => {
    const simpleType = toSimpleType(node.type);
    const fields = getSimpleFields(simpleType);

    fields.forEach((field) => {
      params.push({
        nodeId: node.id,
        nodeType: node.type,
        nodeLabel: (node.config?.title as string) || node.type,
        nodeDescription: (node.config?.description as string) || "",
        key: `${node.id}.${field.key}`,
        label: field.label,
        description: field.help || "",
        type: field.type,
        required: field.required ?? false,
        options: field.options,
        defaultValue: field.placeholder,
        advanced: false,
        help: field.help,
        validation:
          field.type === "number" && (field.min !== undefined || field.max !== undefined)
            ? (value: unknown) => {
                const num = Number(value);
                if (Number.isNaN(num)) return "Must be a number";
                if (field.min !== undefined && num < field.min) return `Must be at least ${field.min}`;
                if (field.max !== undefined && num > field.max) return `Must be at most ${field.max}`;
                return undefined;
              }
            : undefined,
      });
    });
  });

  return params;
}

// ---------------------------------------------------------------------------
// Preview graph generator using mapSimpleToRuntime
// ---------------------------------------------------------------------------

function generatePreviewGraph(template: Template, answers: WizardAnswers): TemplateDraft["previewGraph"] {
  const templateNodes = (template.nodes as Array<{ id: string; type: string; title?: string; config?: Record<string, unknown> }>) ?? [];
  const edges: TemplateDraft["previewGraph"]["edges"] = [];

  // Chain nodes in template order (simple mode hides wiring; runtime
  // resolves data flow from node inputs/outputs).
  for (let i = 0; i < templateNodes.length - 1; i++) {
    edges.push({
      source: templateNodes[i].id,
      target: templateNodes[i + 1].id,
      kind: "data",
    });
  }

  const nodes = templateNodes.map((node) => {
    const nodeAnswers = answers[node.id] || {};
    const simpleType = toSimpleType(node.type);

    // Convert simple answers to runtime config (validated by NODE_DEFINITIONS)
    const runtimeConfig = mapSimpleToRuntime(simpleType, nodeAnswers);

    // Keep template-provided title/description on the node config
    const baseConfig = (node.config ?? {}) as Record<string, unknown>;
    const config: Record<string, unknown> = {
      ...runtimeConfig,
      ...(baseConfig.title !== undefined ? { title: baseConfig.title } : {}),
      ...(baseConfig.description !== undefined ? { description: baseConfig.description } : {}),
    };

    return {
      id: node.id,
      type: node.type,
      label: (baseConfig.title as string) || node.type,
      config,
    };
  });

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateDraft(draft: TemplateDraft): ValidationResult {
  const errors: ValidationResult["errors"] = [];
  const template = {
    id: draft.templateId,
    workspaceId: "",
    name: draft.name,
    description: draft.description,
    nodes: draft.previewGraph.nodes.map((n) => ({ id: n.id, type: n.type, title: n.label, config: n.config })),
    metadata: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Template;

  const params = getTemplateParameters(template);

  params.forEach((param) => {
    if (!param.required) return;
    const nodeAnswers = draft.answers[param.nodeId] || {};
    const value = nodeAnswers[param.key.split(".")[1]];

    if (value === undefined || value === null || value === "") {
      errors.push({
        nodeId: param.nodeId,
        key: param.key,
        message: `${param.label} is required`,
      });
    } else if (param.validation) {
      const err = param.validation(value);
      if (err) {
        errors.push({ nodeId: param.nodeId, key: param.key, message: err });
      }
    }
  });

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// SetupWizard Component
// ---------------------------------------------------------------------------

export interface SetupWizardProps {
  template: TemplateWithParams;
  onComplete: (draft: TemplateDraft) => void;
  onCancel?: () => void;
}

export function SetupWizard({ template, onComplete, onCancel }: SetupWizardProps) {
  const params = getTemplateParameters(template);
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<WizardAnswers>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [validation, setValidation] = useState<ValidationResult>({ valid: true, errors: [] });
  const [showPreview, setShowPreview] = useState(false);

  // One step per node that has parameters, in template order.
  const nodesWithParams = params
    .map((p) => p.nodeId)
    .filter((nodeId, index, all) => all.indexOf(nodeId) === index);

  const currentNodeId = nodesWithParams[currentStep];
  const currentNodeParams = params.filter((p) => p.nodeId === currentNodeId && (showAdvanced || !p.advanced));
  const currentNodeLabel = currentNodeParams[0]?.nodeLabel || "Configuration";

  // Validate as answers change.
  useEffect(() => {
    const draft: TemplateDraft = {
      templateId: template.id,
      name: template.name,
      description: template.description,
      answers,
      previewGraph: generatePreviewGraph(template, answers),
    };
    setValidation(validateDraft(draft));
  }, [answers, template]);

  const handleAnswerChange = useCallback((key: string, value: unknown) => {
    setAnswers((prev) => {
      const [nodeId, paramKey] = key.split(".");
      return {
        ...prev,
        [nodeId]: { ...prev[nodeId], [paramKey]: value },
      };
    });
  }, []);

  const buildDraft = (): TemplateDraft => ({
    templateId: template.id,
    name: template.name,
    description: template.description,
    answers,
    previewGraph: generatePreviewGraph(template, answers),
  });

  const nextStep = () => {
    if (currentStep < nodesWithParams.length - 1) {
      setCurrentStep((s) => s + 1);
    } else {
      setShowPreview(true);
    }
  };

  const prevStep = () => {
    if (currentStep > 0) setCurrentStep((s) => s - 1);
  };

  const handleComplete = () => {
    const draft = buildDraft();
    if (validateDraft(draft).valid) {
      onComplete(draft);
    }
  };

  if (showPreview) {
    return (
      <PreviewModal
        draft={buildDraft()}
        validation={validation}
        onClose={() => setShowPreview(false)}
        onConfirm={handleComplete}
        onBack={() => setShowPreview(false)}
      />
    );
  }

  const isFirstStep = currentStep === 0;
  const isLastStep = currentStep === nodesWithParams.length - 1;
  const progress = nodesWithParams.length === 0 ? 100 : ((currentStep + 1) / nodesWithParams.length) * 100;

  return (
    <div className="wb-wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
      <div className="wb-wizard__header">
        <div className="wb-wizard__progress">
          <div
            className="wb-wizard__progress-bar"
            style={{ width: `${progress}%` }}
            role="progressbar"
            aria-valuenow={Math.round(progress)}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
        <h2 id="wizard-title" className="wb-wizard__title">
          {template.name}
        </h2>
        <p className="wb-wizard__subtitle">{template.description}</p>
        <div className="wb-wizard__step-indicator">
          Step {currentStep + 1} of {nodesWithParams.length}: {currentNodeLabel}
        </div>
      </div>

      <div className="wb-wizard__content">
        {currentNodeParams.length === 0 ? (
          <div className="wb-wizard__empty">
            <NodeIcon category="Flow" size={32} />
            <p>No configuration needed for this step.</p>
          </div>
        ) : (
          <form className="wb-wizard__form" onSubmit={(e) => e.preventDefault()}>
            {currentNodeParams.map((param) => (
              <WizardField
                key={param.key}
                param={param}
                value={answers[param.nodeId]?.[param.key.split(".")[1]]}
                onChange={handleAnswerChange}
                error={validation.errors.find((e) => e.nodeId === param.nodeId && e.key === param.key)?.message}
              />
            ))}

            {params.some((p) => p.nodeId === currentNodeId && p.advanced) && (
              <div className="wb-wizard__advanced-toggle">
                <label>
                  <input
                    type="checkbox"
                    checked={showAdvanced}
                    onChange={(e) => setShowAdvanced(e.target.checked)}
                  />
                  Show advanced settings
                </label>
              </div>
            )}
          </form>
        )}
      </div>

      <div className="wb-wizard__footer">
        <button
          className="wb-btn wb-btn--ghost"
          onClick={prevStep}
          disabled={isFirstStep}
          aria-disabled={isFirstStep}
        >
          Back
        </button>
        <div style={{ flex: 1 }} />
        <button
          className="wb-btn wb-btn--primary"
          onClick={nextStep}
          disabled={!validation.valid && isLastStep}
          aria-disabled={!validation.valid && isLastStep}
        >
          {isLastStep ? "Review setup" : "Next"}
        </button>
        <button className="wb-btn wb-btn--ghost" onClick={onCancel} style={{ marginLeft: "var(--space-2)" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WizardField Component (delegates rendering to SimpleField for consistency)
// ---------------------------------------------------------------------------

interface WizardFieldProps {
  param: WizardParameter;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
  error?: string;
}

function WizardField({ param, value, onChange, error }: WizardFieldProps) {
  // SimpleField accepts a narrower type set; normalize wizard types.
  const simpleType = param.type === "boolean"
    ? "checkbox"
    : param.type === "multiselect"
      ? "select"
      : param.type;
  const simpleField = {
    key: param.key.split(".")[1],
    label: param.label,
    type: simpleType as "checkbox" | "file" | "number" | "recipients" | "select" | "text" | "textarea",
    required: param.required,
    placeholder: typeof param.defaultValue === "string" ? param.defaultValue : undefined,
    options: param.options,
    help: param.help,
  };

  return (
    <div className="wb-wizard__field">
      <label htmlFor={param.key} className="wb-wizard__label">
        {param.label}
        {param.required && <span className="wb-wizard__required" aria-hidden="true">*</span>}
      </label>
      {param.description && (
        <p id={param.key + "-desc"} className="wb-wizard__description">
          {param.description}
        </p>
      )}
      <SimpleField field={simpleField} value={value} onChange={(val) => onChange(param.key, val)} error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// PreviewModal Component
// ---------------------------------------------------------------------------

interface PreviewModalProps {
  draft: TemplateDraft;
  validation: ValidationResult;
  onClose: () => void;
  onConfirm: () => void;
  onBack: () => void;
}

function PreviewModal({ draft, validation, onClose, onConfirm, onBack }: PreviewModalProps) {
  return (
    <div className="wb-wizard__modal-overlay" onClick={onClose}>
      <div className="wb-wizard__modal" onClick={(e) => e.stopPropagation()}>
        <div className="wb-wizard__modal-header">
          <h3>Review workspace setup</h3>
          <button className="wb-btn wb-btn--ghost wb-wizard__close" onClick={onClose} aria-label="Close review">
            ✕
          </button>
        </div>

        <div className="wb-wizard__modal-body">
          {validation.errors.length > 0 && (
            <div className="wb-wizard__validation-summary" role="alert">
              <strong>Please fix the following before adding this setup:</strong>
              <ul>
                {validation.errors.map((err, i) => (
                  <li key={i}>{err.message}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="wb-wizard__preview-graph">
            {draft.previewGraph.nodes.map((node, idx) => (
              <div key={node.id} className="wb-wizard__preview-node">
                <div className="wb-wizard__preview-node-header">
                  <NodeIcon category={NODE_LIBRARY.find((e) => e.type === node.type)?.category || "Flow"} size={16} />
                  <span className="wb-wizard__preview-node-label">{node.label}</span>
                  <span className="wb-wizard__preview-node-type">{node.type}</span>
                </div>
                <div className="wb-wizard__preview-node-config">
                  {Object.entries(node.config).map(([k, v]) => (
                    <div key={k} className="wb-wizard__preview-config-row">
                      <span className="wb-wizard__preview-config-key">{k}</span>
                      <span className="wb-wizard__preview-config-value">{String(v)}</span>
                    </div>
                  ))}
                </div>
                {idx < draft.previewGraph.nodes.length - 1 && (
                  <div className="wb-wizard__preview-arrow">↓</div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="wb-wizard__modal-footer">
          <button className="wb-btn wb-btn--ghost" onClick={onBack}>
            Back
          </button>
          <div style={{ flex: 1 }} />
          <button
            className="wb-btn wb-btn--primary"
            onClick={onConfirm}
            disabled={!validation.valid}
            aria-disabled={!validation.valid}
          >
            Add to workspace
          </button>
        </div>
      </div>
    </div>
  );
}
