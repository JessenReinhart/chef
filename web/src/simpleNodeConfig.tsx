import { useState, useEffect, useCallback } from "react";
import type { GraphNode } from "../../src/core/graph.ts";
import { NODE_LIBRARY } from "./nodeCatalog.tsx";

// Simple mode field types for each node type
export interface SimpleField {
  key: string;
  label: string;
  type: "text" | "number" | "file" | "select" | "checkbox" | "textarea" | "recipients";
  required?: boolean;
  placeholder?: string;
  options?: { value: string; label: string }[];
  help?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface SimpleConfigRendererProps {
  node: GraphNode;
  mode: "simple" | "power";
  onChange: (key: string, value: unknown) => void;
  values: Record<string, unknown>;
}

// Get simple fields for a node type
export function getSimpleFields(nodeType: string): SimpleField[] {
  switch (nodeType) {
    case "task": // Agent Task (maps to agent.llm)
      return [
        {
          key: "prompt",
          label: "Task Instructions",
          type: "textarea",
          required: true,
          placeholder: "What should this agent do? (e.g., 'Analyze the monthly financial data and identify variances')",
          help: "Plain-language instructions for the AI agent.",
        },
      ];

    case "file": // File / Data (maps to tool.file)
      return [
        {
          key: "source",
          label: "Bank Statement File",
          type: "file",
          required: true,
          placeholder: "Select Excel/CSV file",
          help: "Upload your monthly bank statement or financial export.",
        },
        {
          key: "operation",
          label: "Operation",
          type: "select",
          required: true,
          options: [
            { value: "read", label: "Read data" },
            { value: "transform", label: "Transform/clean data" },
          ],
          help: "Choose what to do with the file.",
        },
        {
          key: "format",
          label: "File Format",
          type: "select",
          options: [
            { value: "auto", label: "Auto-detect" },
            { value: "xlsx", label: "Excel (.xlsx)" },
            { value: "csv", label: "CSV (.csv)" },
            { value: "json", label: "JSON (.json)" },
          ],
          help: "Format hint for the parser (auto-detect works for most files).",
        },
      ];

    case "approval": // Approval Gate (maps to human.approval)
      return [
        {
          key: "request",
          label: "Approval Request",
          type: "textarea",
          required: true,
          placeholder: "Describe what needs approval (e.g., 'Approve the monthly financial report before sending to stakeholders')",
          help: "This message is shown to the human reviewer.",
        },
        {
          key: "timeoutMs",
          label: "Auto-expire after (hours)",
          type: "number",
          min: 0,
          max: 168,
          step: 1,
          help: "0 = no timeout. Max 168 hours (1 week).",
        },
        {
          key: "required",
          label: "Approval required to continue",
          type: "checkbox",
          help: "If unchecked, workflow continues even if no one responds.",
        },
      ];

    case "logic": // Logic (maps to control.logic)
      return [
        {
          key: "conditionType",
          label: "Logic Type",
          type: "select",
          required: true,
          options: [
            { value: "if", label: "If / Else" },
            { value: "switch", label: "Switch / Case" },
            { value: "loop", label: "Repeat (Loop)" },
          ],
          help: "Choose the branching behavior.",
        },
        {
          key: "expression",
          label: "Condition",
          type: "text",
          required: true,
          placeholder: "e.g., variance > 5000 OR status == 'over_budget'",
          help: "Simple expression using previous node outputs. Use 'true'/'false' for basic checks.",
        },
        {
          key: "maxIterations",
          label: "Max iterations (loops only)",
          type: "number",
          min: 1,
          max: 1000,
          step: 1,
          help: "Safety limit for loops. Ignored for if/switch.",
        },
      ];

    case "output": // Output (maps to tool.output)
      return [
        {
          key: "format",
          label: "Output Format",
          type: "select",
          required: true,
          options: [
            { value: "pdf", label: "PDF Report" },
            { value: "excel", label: "Excel Workbook" },
            { value: "email", label: "Email" },
            { value: "markdown", label: "Markdown" },
            { value: "json", label: "JSON" },
          ],
          help: "How to format the final deliverable.",
        },
        {
          key: "recipients",
          label: "Recipients",
          type: "recipients",
          placeholder: "stakeholder@company.com, manager@company.com",
          help: "Comma-separated email addresses for email delivery.",
        },
        {
          key: "template",
          label: "Template (optional)",
          type: "text",
          placeholder: "monthly-report-template",
          help: "Named template for PDF/Excel formatting.",
        },
      ];

    case "browser": // Browser (maps to tool.browser)
      return [
        {
          key: "url",
          label: "Website URL",
          type: "text",
          required: true,
          placeholder: "https://example.com",
          help: "Starting URL for web research.",
        },
        {
          key: "action",
          label: "Action",
          type: "select",
          required: true,
          options: [
            { value: "navigate", label: "Open page" },
            { value: "extract", label: "Extract text/data" },
            { value: "screenshot", label: "Take screenshot" },
          ],
          help: "What to do on the page.",
        },
        {
          key: "selector",
          label: "CSS Selector (for extract/click)",
          type: "text",
          placeholder: ".price-table, #main-content",
          help: "Target element for extract or click actions.",
        },
      ];

    case "transform": // Transform (maps to tool.transform)
      return [
        {
          key: "script",
          label: "Transform Script",
          type: "textarea",
          required: true,
          placeholder: "// input is the data from previous node\nreturn input.filter(row => row.amount > 1000);",
          help: "JavaScript function receiving 'input' and returning transformed data.",
        },
        {
          key: "format",
          label: "Input Format",
          type: "select",
          options: [
            { value: "auto", label: "Auto-detect" },
            { value: "json", label: "JSON" },
            { value: "csv", label: "CSV" },
          ],
          help: "Format hint for incoming data.",
        },
      ];

    default:
      return [];
  }
}

// Render a single simple field
export function SimpleField({
  field,
  value,
  onChange,
  error,
}: {
  field: SimpleField;
  value: unknown;
  onChange: (value: unknown) => void;
  error?: string;
}) {
  const [localValue, setLocalValue] = useState(value);

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleChange = useCallback(
    (newValue: unknown) => {
      setLocalValue(newValue);
      onChange(newValue);
    },
    [onChange]
  );

  const inputClass = "wb-simple__input";
  const errorClass = error ? " wb-simple__input--error" : "";

  switch (field.type) {
    case "text":
      return (
        <div className="wb-simple__field">
          <label className="wb-simple__label" htmlFor={field.key}>
            {field.label} {field.required && <span className="wb-simple__required">*</span>}
          </label>
          <input
            id={field.key}
            type="text"
            className={inputClass + errorClass}
            value={localValue as string}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={field.placeholder}
            required={field.required}
          />
          {field.help && <span className="wb-simple__help">{field.help}</span>}
          {error && <span className="wb-simple__error">{error}</span>}
        </div>
      );

    case "number":
      return (
        <div className="wb-simple__field">
          <label className="wb-simple__label" htmlFor={field.key}>
            {field.label} {field.required && <span className="wb-simple__required">*</span>}
          </label>
          <input
            id={field.key}
            type="number"
            className={inputClass + errorClass}
            value={localValue as string | number}
            onChange={(e) => handleChange(e.target.value === "" ? undefined : Number(e.target.value))}
            placeholder={field.placeholder}
            min={field.min}
            max={field.max}
            step={field.step}
            required={field.required}
          />
          {field.help && <span className="wb-simple__help">{field.help}</span>}
          {error && <span className="wb-simple__error">{error}</span>}
        </div>
      );

    case "textarea":
      return (
        <div className="wb-simple__field">
          <label className="wb-simple__label" htmlFor={field.key}>
            {field.label} {field.required && <span className="wb-simple__required">*</span>}
          </label>
          <textarea
            id={field.key}
            className={inputClass + errorClass}
            value={localValue as string}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={field.placeholder}
            required={field.required}
            rows={4}
          />
          {field.help && <span className="wb-simple__help">{field.help}</span>}
          {error && <span className="wb-simple__error">{error}</span>}
        </div>
      );

    case "select":
      return (
        <div className="wb-simple__field">
          <label className="wb-simple__label" htmlFor={field.key}>
            {field.label} {field.required && <span className="wb-simple__required">*</span>}
          </label>
          <select
            id={field.key}
            className={inputClass + errorClass}
            value={localValue as string}
            onChange={(e) => handleChange(e.target.value)}
            required={field.required}
          >
            <option value="">— Select —</option>
            {field.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {field.help && <span className="wb-simple__help">{field.help}</span>}
          {error && <span className="wb-simple__error">{error}</span>}
        </div>
      );

    case "checkbox":
      return (
        <div className="wb-simple__field wb-simple__field--checkbox">
          <label className="wb-simple__checkbox-label">
            <input
              id={field.key}
              type="checkbox"
              className="wb-simple__checkbox"
              checked={localValue as boolean}
              onChange={(e) => handleChange(e.target.checked)}
            />
            <span className="wb-simple__checkbox-text">{field.label}</span>
          </label>
          {field.help && <span className="wb-simple__help">{field.help}</span>}
        </div>
      );

    case "file":
      return (
        <div className="wb-simple__field">
          <label className="wb-simple__label" htmlFor={field.key}>
            {field.label} {field.required && <span className="wb-simple__required">*</span>}
          </label>
          <div className="wb-simple__file-wrapper">
            <input
              id={field.key}
              type="file"
              className="wb-simple__file-input"
              accept=".xlsx,.xls,.csv,.json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  handleChange(file);
                }
              }}
              required={field.required}
            />
            <span className="wb-simple__file-text">
              {localValue instanceof File ? localValue.name : field.placeholder || "Choose file..."}
            </span>
          </div>
          {field.help && <span className="wb-simple__help">{field.help}</span>}
          {error && <span className="wb-simple__error">{error}</span>}
        </div>
      );

    case "recipients":
      return (
        <div className="wb-simple__field">
          <label className="wb-simple__label" htmlFor={field.key}>
            {field.label} {field.required && <span className="wb-simple__required">*</span>}
          </label>
          <textarea
            id={field.key}
            className={inputClass + errorClass}
            value={localValue as string}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={field.placeholder}
            required={field.required}
            rows={2}
          />
          {field.help && <span className="wb-simple__help">{field.help}</span>}
          {error && <span className="wb-simple__error">{error}</span>}
        </div>
      );

    default:
      return null;
  }
}

// Main renderer component for simple mode config
export function SimpleConfigRenderer({
  node,
  mode,
  onChange,
  values,
}: SimpleConfigRendererProps) {
  if (mode === "power") {
    return null; // Power mode uses the full JSON editor
  }

  const fields = getSimpleFields(node.type);
  const libraryEntry = NODE_LIBRARY.find((entry) => entry.type === node.type);

  if (fields.length === 0) {
    return (
      <div className="wb-simple__empty">
        <p>No simple configuration for this node type.</p>
        <p style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 4 }}>
          Switch to Power Mode for full config.
        </p>
      </div>
    );
  }

  // Validate required fields
  const errors: Record<string, string> = {};
  fields.forEach((field) => {
    if (field.required && (!values[field.key] || String(values[field.key]).trim() === "")) {
      errors[field.key] = `${field.label} is required`;
    }
  });

  return (
    <div className="wb-simple__config">
      <div className="wb-simple__header">
        <span className="wb-simple__node-type">{libraryEntry?.label ?? node.type}</span>
        <span className="wb-simple__badge">Simple Mode</span>
      </div>
      <div className="wb-simple__fields">
        {fields.map((field) => (
          <SimpleField
            key={field.key}
            field={field}
            value={values[field.key]}
            onChange={(val) => onChange(field.key, val)}
            error={errors[field.key]}
          />
        ))}
      </div>
      {Object.keys(errors).length > 0 && (
        <div className="wb-simple__validation-note">
          ⚠ Complete required fields before running.
        </div>
      )}
    </div>
  );
}

// Map simple mode field keys to runtime config keys
export function mapSimpleToRuntime(nodeType: string, simpleValues: Record<string, unknown>): Record<string, unknown> {
  const runtimeConfig: Record<string, unknown> = {};

  switch (nodeType) {
    case "task": // agent.llm
      runtimeConfig.model = "default";
      runtimeConfig.temperature = 0.2;
      runtimeConfig.maxTokens = 4096;
      runtimeConfig.systemPrompt = simpleValues.prompt as string || "";
      runtimeConfig.tools = [];
      runtimeConfig.permissionPolicy = "ask";
      break;

    case "file": // tool.file
      runtimeConfig.basePath = ".";
      runtimeConfig.allowedExtensions = [];
      runtimeConfig.maxSizeBytes = 10 * 1024 * 1024;
      // Store source file reference in inputs, not config
      break;

    case "approval": // human.approval
      runtimeConfig.timeoutMs = (simpleValues.timeoutMs as number || 0) * 3600 * 1000; // hours to ms
      runtimeConfig.required = simpleValues.required !== false;
      runtimeConfig.options = [];
      break;

    case "logic": // control.logic
      runtimeConfig.conditionType = simpleValues.conditionType as string || "if";
      runtimeConfig.expression = simpleValues.expression as string || "";
      runtimeConfig.maxIterations = simpleValues.maxIterations as number || 100;
      break;

    case "output": // tool.output
      runtimeConfig.defaultFormat = simpleValues.format as string || "markdown";
      runtimeConfig.templates = simpleValues.template ? [simpleValues.template as string] : [];
      runtimeConfig.deliveryChannels = (simpleValues.recipients as string || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      break;

    case "browser": // tool.browser
      runtimeConfig.headless = true;
      runtimeConfig.timeoutMs = 30_000;
      runtimeConfig.viewport = { width: 1280, height: 720 };
      runtimeConfig.userAgent = "";
      break;

    case "transform": // tool.transform
      runtimeConfig.language = "js";
      runtimeConfig.allowedImports = [];
      runtimeConfig.timeoutMs = 10_000;
      break;

    default:
      break;
  }

  return runtimeConfig;
}

// Map runtime config to simple mode values
export function mapRuntimeToSimple(nodeType: string, runtimeConfig: Record<string, unknown>): Record<string, unknown> {
  const simpleValues: Record<string, unknown> = {};

  switch (nodeType) {
    case "task":
      simpleValues.prompt = runtimeConfig.systemPrompt as string || "";
      break;

    case "approval":
      simpleValues.timeoutMs = Math.round(((runtimeConfig.timeoutMs as number) || 0) / (3600 * 1000));
      simpleValues.required = runtimeConfig.required !== false;
      break;

    case "logic":
      simpleValues.conditionType = runtimeConfig.conditionType as string || "if";
      simpleValues.expression = runtimeConfig.expression as string || "";
      simpleValues.maxIterations = runtimeConfig.maxIterations as number || 100;
      break;

    case "output":
      simpleValues.format = runtimeConfig.defaultFormat as string || "markdown";
      simpleValues.template = (runtimeConfig.templates as string[])?.[0] || "";
      simpleValues.recipients = (runtimeConfig.deliveryChannels as string[])?.join(", ") || "";
      break;

    default:
      break;
  }

  return simpleValues;
}