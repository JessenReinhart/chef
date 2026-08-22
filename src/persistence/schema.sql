PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  summary TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_workspace_updated ON threads(workspace_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);

CREATE TABLE IF NOT EXISTS harnesses (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_harnesses_workspace ON harnesses(workspace_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  harness_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  pid INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  command TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '[]',
  cwd TEXT NOT NULL DEFAULT '',
  cols INTEGER NOT NULL DEFAULT 80,
  rows INTEGER NOT NULL DEFAULT 24,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  exit_code INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  assigned_to TEXT,
  parent_task_id TEXT,
  mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
  automation_id TEXT REFERENCES automations(id) ON DELETE SET NULL,
  automation_run_id TEXT REFERENCES automation_runs(id) ON DELETE SET NULL,
  approval_id TEXT REFERENCES approvals(id) ON DELETE SET NULL,
  context_refs_json TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0,
  workflow_node_id TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  result_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_mission ON tasks(mission_id);
CREATE INDEX IF NOT EXISTS idx_tasks_automation_run ON tasks(automation_run_id);
CREATE INDEX IF NOT EXISTS idx_tasks_approval ON tasks(approval_id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  requester TEXT NOT NULL,
  approver TEXT,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_approvals_workspace ON approvals(workspace_id);
CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_agent TEXT NOT NULL,
  to_agent TEXT,
  channel TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  reply_to TEXT,
  context_refs_json TEXT NOT NULL DEFAULT '[]',
  correlation_id TEXT,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_workspace ON messages(workspace_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  task_id TEXT,
  session_id TEXT,
  correlation_id TEXT,
  UNIQUE(workspace_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_workspace_seq ON events(workspace_id, seq);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  uri TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  task_id TEXT,
  session_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_artifacts_workspace ON artifacts(workspace_id);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  made_by TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_workspace ON decisions(workspace_id);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  tasks_json TEXT NOT NULL DEFAULT '[]',
  task_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id);

CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  task_ids_json TEXT NOT NULL DEFAULT '[]',
  plan_id TEXT,
  created_by TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_missions_workspace ON missions(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',
  node_ids_json TEXT NOT NULL DEFAULT '[]',
  edges_json TEXT NOT NULL DEFAULT '[]',
  trigger_json TEXT NOT NULL DEFAULT '{}',
  current_run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automations_workspace ON automations(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  task_ids_json TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_automation ON automation_runs(automation_id, started_at);
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  nodes_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_templates_workspace ON templates(workspace_id);

-- Orchestrator-owned canvas graph (spec §5.4)
CREATE TABLE IF NOT EXISTS canvas_nodes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  node_type TEXT NOT NULL DEFAULT 'blueprint',
  kind TEXT NOT NULL DEFAULT 'agent',
  harness_id TEXT,
  live_status TEXT NOT NULL DEFAULT 'offline',
  config_json TEXT NOT NULL DEFAULT '{}',
  position_x REAL NOT NULL DEFAULT 0,
  position_y REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canvas_nodes_workspace ON canvas_nodes(workspace_id);

CREATE TABLE IF NOT EXISTS canvas_edges (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
  target TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
  source_handle TEXT,
  target_handle TEXT,
  edge_type TEXT NOT NULL DEFAULT 'context',
  updated_at INTEGER NOT NULL,
  UNIQUE(source, target, edge_type)
);
CREATE INDEX IF NOT EXISTS idx_canvas_edges_workspace ON canvas_edges(workspace_id);

CREATE TABLE IF NOT EXISTS context_zones (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  bounds_json TEXT NOT NULL,
  context_refs_json TEXT NOT NULL DEFAULT '[]',
  policy_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_zones_workspace ON context_zones(workspace_id);

-- Membership is explicit runtime state. Canvas geometry is presentation only.
CREATE TABLE IF NOT EXISTS context_zone_members (
  zone_id TEXT NOT NULL REFERENCES context_zones(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
  PRIMARY KEY (zone_id, node_id)
);

-- Tracks only references that Context Zones added to a task. This provenance
-- lets reconciliation remove stale zone-owned refs without disturbing refs
-- supplied by plans, canvas edges, or users.
CREATE TABLE IF NOT EXISTS context_zone_task_refs (
  zone_id TEXT NOT NULL REFERENCES context_zones(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ref_key TEXT NOT NULL,
  ref_json TEXT NOT NULL,
  PRIMARY KEY (zone_id, task_id, ref_key)
);
CREATE INDEX IF NOT EXISTS idx_context_zone_task_refs_task ON context_zone_task_refs(task_id);
