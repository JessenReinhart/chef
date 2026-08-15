import { useState, useCallback } from "react";
import { NODE_LIBRARY, NodeIcon } from "./nodeCatalog.tsx";

interface NavigationPanelProps {
  onDragStart: (type: string, event: React.DragEvent) => void;
}

export function NavigationPanel({ onDragStart }: NavigationPanelProps) {
  const [search, setSearch] = useState("");
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({
    Agents: true,
    Tools: true,
    Flow: true,
    Data: true,
    Human: true,
  });

  const filtered = NODE_LIBRARY.filter((node) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      node.label.toLowerCase().includes(q) ||
      node.description.toLowerCase().includes(q) ||
      node.type.toLowerCase().includes(q)
    );
  });

  const categories = ["Agents", "Tools", "Flow", "Data", "Human"] as const;

  const handleDragStart = useCallback(
    (type: string, event: React.DragEvent<HTMLButtonElement>) => {
      event.dataTransfer.setData("text/chef-node-type", type);
      event.dataTransfer.effectAllowed = "copy";
      (event.currentTarget as HTMLElement).classList.add("wb-nav__node--dragging");
    },
    []
  );

  const handleDragEnd = useCallback((event: React.DragEvent<HTMLButtonElement>) => {
    (event.currentTarget as HTMLElement).classList.remove("wb-nav__node--dragging");
  }, []);

  return (
    <nav className="wb-nav" role="navigation" aria-label="Node library">
      <div className="wb-nav__header">
        <h2 className="wb-nav__title">Node Library</h2>
      </div>
      <input
        className="wb-nav__search"
        type="search"
        placeholder="Search nodes…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Search node library"
      />
      <div className="wb-nav__list" role="list">
        {categories.map((cat) => {
          const nodesInCat = filtered.filter((n) => n.category === cat);
          if (nodesInCat.length === 0) return null;
          return (
            <div key={cat} className="wb-nav__category">
              <button
                className="wb-nav__category-label"
                onClick={() => setExpandedCategories((prev) => ({ ...prev, [cat]: !prev[cat] }))}
                aria-expanded={expandedCategories[cat]}
                style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", textAlign: "left", width: "100%" }}
              >
                {cat} <span style={{ marginLeft: "auto" }}>{expandedCategories[cat] ? "▼" : "▶"}</span>
              </button>
              {expandedCategories[cat] && (
                <div role="list">
                  {nodesInCat.map((node) => (
                    <button
                      key={node.type}
                      className="wb-nav__node"
                      onDragStart={(e) => handleDragStart(node.type, e)}
                      onDragEnd={handleDragEnd}
                      draggable
                      title={node.description}
                      aria-label={`${node.label}, ${node.category}`}
                    >
                      <span className="wb-nav__node-icon">
                        <NodeIcon category={node.category} size={20} />
                      </span>
                      <span className="wb-nav__node-label">{node.label}</span>
                      <span className="wb-nav__node-kind">{node.kind}</span>
                      {!node.implemented && (
                        <span
                          style={{
                            fontSize: 10,
                            padding: "1px 4px",
                            background: "var(--bg-hover)",
                            borderRadius: 4,
                            color: "var(--fg-muted)",
                            textTransform: "uppercase",
                          }}
                        >
                          Soon
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
