-- Yield D1 schema
-- Apply with:  npm run db:init        (remote)
--              npm run db:init:local  (local dev)

-- ── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,            -- ulid/uuid
  email         TEXT UNIQUE,
  name          TEXT,
  avatar_url    TEXT,
  provider      TEXT NOT NULL,               -- 'email' | 'github' | 'google'
  provider_id   TEXT NOT NULL,               -- id at the provider (email addr for 'email')
  password_hash TEXT,                         -- pbkdf2 hash for email/password users
  plan          TEXT NOT NULL DEFAULT 'free',-- 'free' | 'priority'
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  plan_renews_at         INTEGER,            -- unix seconds; subscription period end
  -- Separate "Yield Security" product subscription (sold apart from Priority).
  security_active           INTEGER NOT NULL DEFAULT 0,
  security_subscription_id  TEXT,
  -- GitHub code storage (token is AES-GCM encrypted at rest with SESSION_SECRET).
  github_login           TEXT,
  github_token_enc       TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (provider, provider_id)
);

-- ── Projects (one generated app per row) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'Untitled app',
  -- The generated app is a single self-contained HTML document (HTML+CSS+JS).
  code        TEXT NOT NULL DEFAULT '',
  model       TEXT,                          -- model id used for last generation
  is_public   INTEGER NOT NULL DEFAULT 0,
  -- GitHub sync: which repo this project's code is pushed to.
  github_repo    TEXT,                       -- "owner/name"
  github_url     TEXT,                       -- html url of the repo
  github_branch  TEXT,                       -- default branch
  github_synced_at INTEGER,                  -- unix seconds of last push
  slug         TEXT,                          -- readable share id (/p/<slug>)
  logo         TEXT,                          -- auto-generated inline SVG app logo
  description  TEXT,                          -- auto-generated one-line app description
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);

-- ── Security audit metadata (NEVER stores source code) ───────────────────────
-- Only the run summary (score + severity counts) and per-finding metadata are kept;
-- the analyzed code is discarded immediately after the scan.
CREATE TABLE IF NOT EXISTS audit_runs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT,
  user_id     TEXT,
  source      TEXT,                          -- "project:<id>" or "repo:<owner/name>"
  level       TEXT NOT NULL,                 -- 'basic' | 'detailed' | 'compliance'
  score       INTEGER NOT NULL,              -- codeHealthScore 0..100
  critical    INTEGER NOT NULL DEFAULT 0,
  high        INTEGER NOT NULL DEFAULT 0,
  medium      INTEGER NOT NULL DEFAULT 0,
  low         INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_runs_project ON audit_runs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_findings (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  project_id  TEXT,
  type        TEXT NOT NULL,                 -- e.g. "SQL_INJECTION"
  severity    TEXT NOT NULL,                 -- CRITICAL | HIGH | MEDIUM | LOW
  cwe         TEXT,
  file        TEXT,                          -- filename only (no code)
  line        INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_findings_run ON audit_findings(run_id);

-- Triage: findings a user marked ignored / accepted-risk (filtered from future scans).
CREATE TABLE IF NOT EXISTS audit_ignores (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  source      TEXT NOT NULL,                 -- "project:<id>" or "repo:<owner/name>"
  type        TEXT NOT NULL,
  file        TEXT NOT NULL,
  line        INTEGER,                        -- NULL = ignore this type anywhere in the file
  reason      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ignores_source ON audit_ignores(source);

-- Continuous monitoring: repos watched for scan-on-push + scheduled re-scans.
CREATE TABLE IF NOT EXISTS security_monitors (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  repo         TEXT NOT NULL,                 -- "owner/name"
  branch       TEXT NOT NULL DEFAULT 'main',
  hook_id      INTEGER,                        -- GitHub webhook id (for cleanup)
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_scan_at INTEGER,
  last_score   INTEGER,
  created_at   INTEGER NOT NULL,
  UNIQUE (user_id, repo)
);
CREATE INDEX IF NOT EXISTS idx_monitors_repo ON security_monitors(repo);

-- Outbound integrations (Slack / Jira / GitHub PR comments) per user.
CREATE TABLE IF NOT EXISTS security_integrations (
  user_id           TEXT PRIMARY KEY,
  slack_webhook     TEXT,
  jira_base         TEXT,
  jira_email        TEXT,
  jira_token_enc    TEXT,                       -- AES-GCM encrypted Jira API token
  jira_project      TEXT,
  post_pr_comments  INTEGER NOT NULL DEFAULT 1,
  post_commit_status INTEGER NOT NULL DEFAULT 1,
  updated_at        INTEGER NOT NULL
);

-- ── Files (multi-file projects: one row per file in a project) ───────────────
CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,                 -- e.g. "index.html", "src/app.js"
  content     TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL,
  UNIQUE (project_id, path)
);
CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);

-- ── Chat / build history per project ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,                 -- 'user' | 'assistant' | 'system'
  content     TEXT NOT NULL,
  model       TEXT,                          -- resolved model for assistant turns
  flagged     INTEGER NOT NULL DEFAULT 0,    -- 1 if jailbreak guard blocked it
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, created_at);

-- ── Usage ledger (audit + monthly/daily aggregation backstop) ────────────────
-- Fast counters live in KV; this table is the durable audit trail.
CREATE TABLE IF NOT EXISTS usage_events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,                          -- null for anonymous
  kind        TEXT NOT NULL,                 -- 'generate' | 'edit' | 'route' | 'blocked'
  model       TEXT,
  tokens_in   INTEGER DEFAULT 0,
  tokens_out  INTEGER DEFAULT 0,
  high_usage  INTEGER NOT NULL DEFAULT 0,    -- 1 if served during high-usage mode
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at);

-- ── AI Agents (reusable AIs the user defines; callable from generated apps) ───
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  project_id    TEXT NOT NULL DEFAULT '',         -- '' = account-level, else per-app
  name          TEXT NOT NULL,
  description   TEXT,
  system_prompt TEXT NOT NULL,
  model         TEXT NOT NULL DEFAULT 'glm-5.1',  -- friendly model id
  is_public     INTEGER NOT NULL DEFAULT 1,       -- runnable from a generated app
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);

-- ── Secrets (config; values AES-GCM encrypted at rest; per-app or account) ────
CREATE TABLE IF NOT EXISTS secrets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  project_id  TEXT NOT NULL DEFAULT '',           -- '' = account-level, else per-app
  name        TEXT NOT NULL,
  value_enc   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_secrets_user ON secrets(user_id);

-- ── App data / entities (fallback store when a project isn't GitHub-linked) ───
-- When a project IS linked, records live as JSON in the repo (.yield/data/*.json).
CREATE TABLE IF NOT EXISTS app_data (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  entity      TEXT NOT NULL,
  data        TEXT NOT NULL,                 -- JSON record
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_data ON app_data(project_id, entity);

-- ── Yield Roblox (AI-built Roblox games, synced to a Roblox Studio plugin) ─────
-- The plugin never talks to the web session — it authenticates with a bearer token
-- minted at pairing time and looked up in KV (roblox_token:<token> -> {projectId}),
-- same pattern as web sessions (KV-backed opaque tokens). This table holds only
-- non-secret pairing status; the token itself is never persisted in D1.
CREATE TABLE IF NOT EXISTS roblox_projects (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title               TEXT NOT NULL DEFAULT 'Untitled game',
  model               TEXT,                  -- last coder model id used
  paired              INTEGER NOT NULL DEFAULT 0,
  place_name          TEXT,                  -- reported by the plugin
  place_id            TEXT,
  paired_at           INTEGER,
  last_seen_at        INTEGER,               -- last plugin pull/snapshot
  -- Optional: the user's own Roblox Open Cloud API key (AES-GCM encrypted), enabling
  -- live free-model marketplace search. Without it, the asset library is manual-only
  -- (paste an asset id) and map generation still works with procedural parts.
  roblox_api_key_enc  TEXT,
  roblox_creator_type TEXT,                  -- 'User' | 'Group'
  roblox_creator_id   TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roblox_projects_user ON roblox_projects(user_id, updated_at DESC);

-- One row per Roblox Instance the AI (or the plugin's "push") has written — mirrors
-- the web builder's `files` table, but path segments are a DataModel hierarchy
-- (e.g. "ServerScriptService/Combat/DamageHandler") and class_name picks the
-- Script/LocalScript/ModuleScript the plugin creates.
CREATE TABLE IF NOT EXISTS roblox_files (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES roblox_projects(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  class_name  TEXT NOT NULL DEFAULT 'Script', -- Script | LocalScript | ModuleScript
  source      TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL,
  UNIQUE (project_id, path)
);
CREATE INDEX IF NOT EXISTS idx_roblox_files_project ON roblox_files(project_id);

-- Chat history per Roblox project (mirrors `messages`).
CREATE TABLE IF NOT EXISTS roblox_messages (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES roblox_projects(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,                 -- 'user' | 'assistant'
  content     TEXT NOT NULL,
  model       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roblox_messages_project ON roblox_messages(project_id, created_at);

-- Outbox: operations queued for the Studio plugin to pull + apply next time it polls
-- (upsert/delete a script, build a generated map, insert one pinned model). Rows are
-- kept after being applied (capped) so the web UI can show a sync activity log.
CREATE TABLE IF NOT EXISTS roblox_ops (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES roblox_projects(id) ON DELETE CASCADE,
  op          TEXT NOT NULL,                 -- JSON: {type, ...payload}
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | applied | failed
  detail      TEXT,                          -- plugin-reported result/error
  created_at  INTEGER NOT NULL,
  applied_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_roblox_ops_project ON roblox_ops(project_id, status, created_at);

-- User's free-model library per project: pasted manually (always works, no API key
-- needed — grab any asset id off roblox.com) or added from a connected marketplace
-- search. The map generator matches AI-proposed prop "roles" against these by tag.
CREATE TABLE IF NOT EXISTS roblox_assets (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES roblox_projects(id) ON DELETE CASCADE,
  asset_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  tags        TEXT,                          -- comma-separated, for AI role matching
  created_at  INTEGER NOT NULL,
  UNIQUE (project_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_roblox_assets_project ON roblox_assets(project_id);

-- Generated map layouts (kept for history / re-apply); `spec` is the resolved JSON
-- (asset roles already matched to real asset ids) that was queued as a build_map op.
CREATE TABLE IF NOT EXISTS roblox_maps (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES roblox_projects(id) ON DELETE CASCADE,
  prompt      TEXT NOT NULL,
  spec        TEXT NOT NULL,                 -- JSON
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roblox_maps_project ON roblox_maps(project_id, created_at DESC);
