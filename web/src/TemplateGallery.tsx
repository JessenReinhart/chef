import { useState, useEffect, useCallback } from "react";
import { NodeIcon } from "./nodeCatalog.tsx";

export interface Template {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  nodes: unknown[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface TemplateGalleryProps {
  onSelectTemplate: (template: Template) => void;
  onCreateNew: () => void;
  mode: "simple" | "power";
}

const TEMPLATE_CATEGORIES = [
  {
    id: "financial",
    label: "Financial",
    icon: "💰",
    description: "Reporting & analysis templates",
  },
  {
    id: "operations",
    label: "Operations",
    icon: "⚙️",
    description: "Dev & ops workflow templates",
  },
];

// Map node type strings to NodeIcon categories
function mapNodeTypeToCategory(type: string): "Agents" | "Tools" | "Flow" | "Data" | "Human" {
  const mapping: Record<string, "Agents" | "Tools" | "Flow" | "Data" | "Human"> = {
    "agent.llm": "Agents",
    "tool.terminal": "Tools",
    "tool.file": "Data",
    "tool.browser": "Tools",
    "tool.transform": "Tools",
    "tool.database": "Data",
    "tool.output": "Tools",
    "control.logic": "Flow",
    "human.approval": "Human",
    "human.input": "Human",
    // Simple mode friendly names
    "task": "Tools",
    "transform": "Tools",
    "approval": "Human",
    "output": "Tools",
    "logic": "Flow",
    "fetch": "Data",
    "analyze": "Tools",
    "generate": "Tools",
    "review": "Human",
    "deliver": "Tools",
    "categorize": "Tools",
    "forecast": "Tools",
    "validate": "Tools",
    "flag": "Flow",
    "reproduce": "Tools",
    "diagnose": "Tools",
    "fix": "Tools",
    "test-gate": "Flow",
    "deploy-approval": "Human",
    "deploy": "Tools",
  };
  return mapping[type] ?? "Tools";
}

const BUILTIN_TEMPLATES: Omit<Template, "id" | "workspaceId" | "createdAt" | "updatedAt">[] = [
  {
    name: "Monthly Financial Report",
    description: "Generate a complete monthly financial report with income statement, balance sheet, and cash flow summary. Includes data validation and approval gate.",
    nodes: [
      { type: "tool.file", id: "fetch-data", config: { title: "Fetch Financial Data", description: "Pull transaction data from accounting system" } },
      { type: "tool.transform", id: "validate", config: { title: "Validate Data", description: "Check for missing entries, duplicates, anomalies" } },
      { type: "agent.llm", id: "generate-report", config: { title: "Generate Report", description: "Build income statement, balance sheet, cash flow" } },
      { type: "human.approval", id: "review", config: { title: "CFO Review", description: "Human approval before finalizing" } },
      { type: "tool.output", id: "deliver", config: { title: "Deliver Report", description: "Export PDF and email stakeholders" } },
    ],
    metadata: { category: "financial", estimatedDuration: "15 min", tags: ["monthly", "reporting", "cfo"] },
  },
  {
    name: "Cash Flow Analysis",
    description: "Analyze cash inflows/outflows, forecast runway, and identify trends. Outputs a dashboard-ready summary with alerts.",
    nodes: [
      { type: "tool.file", id: "fetch-cash", config: { title: "Fetch Cash Data", description: "Pull bank transactions and AR/AP" } },
      { type: "tool.transform", id: "categorize", config: { title: "Categorize Flows", description: "Classify operating, investing, financing" } },
      { type: "agent.llm", id: "forecast", config: { title: "Forecast Runway", description: "Project cash position 13 weeks forward" } },
      { type: "human.approval", id: "alert-review", config: { title: "Alert Review", description: "Flag negative projections for review" } },
      { type: "tool.output", id: "dashboard", config: { title: "Update Dashboard", description: "Push metrics to monitoring dashboard" } },
    ],
    metadata: { category: "financial", estimatedDuration: "10 min", tags: ["cash-flow", "forecast", "runway"] },
  },
  {
    name: "Budget vs Actual",
    description: "Compare budgeted vs actual spend by department/category. Highlights variances >10% and routes exceptions for review.",
    nodes: [
      { type: "tool.file", id: "fetch-budget", config: { title: "Fetch Budget", description: "Load approved budget from planning system" } },
      { type: "tool.file", id: "fetch-actual", config: { title: "Fetch Actuals", description: "Pull YTD actual spend from ERP" } },
      { type: "tool.transform", id: "variance", config: { title: "Calculate Variance", description: "Compute $ and % variance by line item" } },
      { type: "control.logic", id: "flag", config: { title: "Flag Exceptions", description: "Mark items exceeding 10% threshold" } },
      { type: "human.approval", id: "exception-review", config: { title: "Exception Review", description: "Department heads justify variances" } },
      { type: "tool.output", id: "variance-report", config: { title: "Variance Report", description: "Generate executive summary with charts" } },
    ],
    metadata: { category: "financial", estimatedDuration: "12 min", tags: ["budget", "variance", "department"] },
  },
  {
    name: "Developer Fix/Verify",
    description: "Standardized bug fix workflow: reproduce → fix → test → verify → deploy. Includes automated test gate and deploy approval.",
    nodes: [
      { type: "tool.terminal", id: "reproduce", config: { title: "Reproduce Issue", description: "Create minimal failing test case" } },
      { type: "agent.llm", id: "diagnose", config: { title: "Root Cause", description: "Identify and document root cause" } },
      { type: "tool.terminal", id: "fix", config: { title: "Implement Fix", description: "Write fix with unit test" } },
      { type: "control.logic", id: "test-gate", config: { title: "Test Gate", description: "Run full suite; block on failures" } },
      { type: "human.approval", id: "deploy-approval", config: { title: "Deploy Approval", description: "Lead review before production deploy" } },
      { type: "tool.terminal", id: "deploy", config: { title: "Deploy & Verify", description: "Deploy to prod and verify resolution" } },
    ],
    metadata: { category: "operations", estimatedDuration: "30 min", tags: ["bug-fix", "ci-cd", "verification"] },
  },
];

export function TemplateGallery({ onSelectTemplate, onCreateNew, mode }: TemplateGalleryProps) {
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTemplates = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/templates");
      if (!res.ok) throw new Error("Failed to load templates");
      const data = await res.json();
      setTemplates(data.data || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      // Fall back to built-in templates if API fails
      const fallback = BUILTIN_TEMPLATES.map((t, i) => ({
        ...t,
        id: `builtin-${i}`,
        workspaceId: "default",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }));
      setTemplates(fallback);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const filteredTemplates = templates.filter((t) => {
    const matchesSearch =
      !search ||
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.description.toLowerCase().includes(search.toLowerCase());
    const matchesCategory =
      selectedCategory === "all" ||
      (t.metadata.category as string) === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const categories = ["all", ...TEMPLATE_CATEGORIES.map((c) => c.id)];

  return (
    <div className="wb-template-gallery">
      <div className="wb-template-gallery__header">
        <h2 className="wb-template-gallery__title">Workflow Templates</h2>
        <p className="wb-template-gallery__subtitle">
          Choose a template to get started quickly, or create a custom workflow.
        </p>
      </div>

      <div className="wb-template-gallery__toolbar">
        <input
          type="search"
          className="wb-template-gallery__search"
          placeholder="Search templates…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search templates"
        />
        <div className="wb-template-gallery__categories" role="group" aria-label="Filter by category">
          {categories.map((cat) => (
            <button
              key={cat}
              className={`wb-template-gallery__category-btn ${cat === selectedCategory ? "wb-template-gallery__category-btn--active" : ""}`}
              onClick={() => setSelectedCategory(cat)}
            >
              {cat === "all" ? "All" : TEMPLATE_CATEGORIES.find((c) => c.id === cat)?.label ?? cat}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="wb-template-gallery__loading">Loading templates…</div>}

      {error && !loading && (
        <div className="wb-template-gallery__error" role="alert">
          <p>Using built-in templates (server unavailable)</p>
        </div>
      )}

      {!loading && (
        <div className="wb-template-gallery__grid" role="list">
          {filteredTemplates.map((template) => (
            <article
              key={template.id}
              className="wb-template-card"
              role="listitem"
              onClick={() => onSelectTemplate(template)}
              tabIndex={0}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelectTemplate(template)}
            >
              <div className="wb-template-card__thumbnail">
                <div className="wb-template-card__icon-stack">
                  {(template.nodes as Array<{ type?: string; id?: string }>).slice(0, 3).map((node, idx) => (
                    <NodeIcon
                      key={node.id ?? `node-${idx}`}
                      category={mapNodeTypeToCategory(node.type ?? "tool")}
                      size={28}
                      style={{
                        zIndex: 3 - idx,
                        transform: `translate(${idx * 8}px, ${idx * 4}px)`,
                        boxShadow: idx > 0 ? "var(--shadow-sm)" : "none",
                      }}
                    />
                  ))}
                  {(template.nodes as Array<{ type?: string }>).length > 3 && (
                    <div className="wb-template-card__more-badge">+{(template.nodes as Array<{ type?: string }>).length - 3}</div>
                  )}
                </div>
              </div>
              <div className="wb-template-card__header">
                <span className="wb-template-card__category-badge">
                  {TEMPLATE_CATEGORIES.find((c) => c.id === template.metadata.category)?.icon ?? "📋"}
                </span>
                <span className="wb-template-card__category-label">
                  {TEMPLATE_CATEGORIES.find((c) => c.id === template.metadata.category)?.label ?? "General"}
                </span>
              </div>
              <h3 className="wb-template-card__name">{template.name}</h3>
              <p className="wb-template-card__description">{template.description}</p>
              <div className="wb-template-card__meta">
                <span className="wb-template-card__duration">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden width="14" height="14">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 6v6l4 2" />
                  </svg>
                  {String(template.metadata.estimatedDuration ?? "—")}
                </span>
                <span className="wb-template-card__steps">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden width="14" height="14">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                  {Array.isArray(template.nodes) ? template.nodes.length : 0} steps
                </span>
              </div>
              <div className="wb-template-card__tags">
                {(template.metadata.tags as string[] | undefined)?.slice(0, 3).map((tag) => (
                  <span key={tag} className="wb-template-card__tag">{tag}</span>
                ))}
              </div>
            </article>
          ))}
          <button className="wb-template-card wb-template-card--new" onClick={onCreateNew} tabIndex={0}>
            <svg className="wb-template-card__new-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span className="wb-template-card__new-label">Create Custom Workflow</span>
            <span className="wb-template-card__new-hint">Start from scratch</span>
          </button>
        </div>
      )}
    </div>
  );
}