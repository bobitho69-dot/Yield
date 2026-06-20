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
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, updated_at DESC);

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
