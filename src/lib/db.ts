// D1 data-access helpers.
import type { Env } from '../types';
import { newId, now } from './response';

export interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  provider: string;
  provider_id: string;
  plan: 'free' | 'priority';
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan_renews_at: number | null;
  password_hash: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProjectRow {
  id: string;
  user_id: string;
  title: string;
  code: string;
  model: string | null;
  is_public: number;
  github_repo: string | null;
  github_url: string | null;
  github_branch: string | null;
  github_synced_at: number | null;
  created_at: number;
  updated_at: number;
}

// --- Users --------------------------------------------------------------------
export async function upsertOAuthUser(
  env: Env,
  p: { provider: string; provider_id: string; email: string | null; name: string | null; avatar_url: string | null },
): Promise<UserRow> {
  const existing = await env.DB.prepare('SELECT * FROM users WHERE provider = ? AND provider_id = ?')
    .bind(p.provider, p.provider_id)
    .first<UserRow>();
  const t = now();
  if (existing) {
    await env.DB.prepare('UPDATE users SET email=?, name=?, avatar_url=?, updated_at=? WHERE id=?')
      .bind(p.email, p.name, p.avatar_url, t, existing.id)
      .run();
    return { ...existing, email: p.email, name: p.name, avatar_url: p.avatar_url, updated_at: t };
  }
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO users (id,email,name,avatar_url,provider,provider_id,plan,created_at,updated_at)
     VALUES (?,?,?,?,?,?,'free',?,?)`,
  )
    .bind(id, p.email, p.name, p.avatar_url, p.provider, p.provider_id, t, t)
    .run();
  return (await getUser(env, id))!;
}

export function getUser(env: Env, id: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

// Shared guest account used when AUTH_ENABLED='false' (open testing mode).
const GUEST_ID = 'guest';
export async function ensureGuestUser(env: Env): Promise<UserRow> {
  const existing = await getUser(env, GUEST_ID);
  if (existing) return existing;
  const t = now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id,email,name,avatar_url,provider,provider_id,plan,created_at,updated_at)
     VALUES (?,?,?,?,?,?,'free',?,?)`,
  )
    .bind(GUEST_ID, null, 'Guest', null, 'guest', GUEST_ID, t, t)
    .run();
  return (await getUser(env, GUEST_ID))!;
}

// --- Email/password users -----------------------------------------------------
export function getUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email.toLowerCase()).first<UserRow>();
}

export async function createEmailUser(
  env: Env,
  p: { email: string; name: string | null; password_hash: string },
): Promise<UserRow> {
  const id = newId();
  const t = now();
  const email = p.email.toLowerCase();
  await env.DB.prepare(
    `INSERT INTO users (id,email,name,avatar_url,provider,provider_id,password_hash,plan,created_at,updated_at)
     VALUES (?,?,?,NULL,'email',?,?,'free',?,?)`,
  )
    .bind(id, email, p.name, email, p.password_hash, t, t)
    .run();
  return (await getUser(env, id))!;
}

export async function setUserPlan(
  env: Env,
  userId: string,
  plan: 'free' | 'priority',
  fields: Partial<Pick<UserRow, 'stripe_customer_id' | 'stripe_subscription_id' | 'plan_renews_at'>> = {},
): Promise<void> {
  await env.DB.prepare(
    `UPDATE users SET plan=?,
       stripe_customer_id=COALESCE(?, stripe_customer_id),
       stripe_subscription_id=COALESCE(?, stripe_subscription_id),
       plan_renews_at=COALESCE(?, plan_renews_at),
       updated_at=? WHERE id=?`,
  )
    .bind(plan, fields.stripe_customer_id ?? null, fields.stripe_subscription_id ?? null, fields.plan_renews_at ?? null, now(), userId)
    .run();
}

export function getUserByCustomer(env: Env, customerId: string): Promise<UserRow | null> {
  return env.DB.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').bind(customerId).first<UserRow>();
}

// --- GitHub token storage -----------------------------------------------------
export async function setGithubAuth(env: Env, userId: string, login: string, tokenEnc: string): Promise<void> {
  await env.DB.prepare('UPDATE users SET github_login=?, github_token_enc=?, updated_at=? WHERE id=?')
    .bind(login, tokenEnc, now(), userId)
    .run();
}

export async function getGithubAuth(env: Env, userId: string): Promise<{ login: string; tokenEnc: string } | null> {
  const row = await env.DB.prepare('SELECT github_login, github_token_enc FROM users WHERE id=?')
    .bind(userId)
    .first<{ github_login: string | null; github_token_enc: string | null }>();
  if (!row?.github_login || !row?.github_token_enc) return null;
  return { login: row.github_login, tokenEnc: row.github_token_enc };
}

export async function setProjectGithub(
  env: Env, id: string, repo: string, url: string, branch: string,
): Promise<void> {
  await env.DB.prepare('UPDATE projects SET github_repo=?, github_url=?, github_branch=?, github_synced_at=?, updated_at=? WHERE id=?')
    .bind(repo, url, branch, now(), now(), id)
    .run();
}

export async function markGithubSynced(env: Env, id: string): Promise<void> {
  await env.DB.prepare('UPDATE projects SET github_synced_at=? WHERE id=?').bind(now(), id).run();
}

export async function clearProjectGithub(env: Env, id: string): Promise<void> {
  await env.DB.prepare('UPDATE projects SET github_repo=NULL, github_url=NULL, github_branch=NULL, github_synced_at=NULL WHERE id=?')
    .bind(id)
    .run();
}

// --- Projects -----------------------------------------------------------------
export async function createProject(env: Env, userId: string, title: string): Promise<ProjectRow> {
  const id = newId();
  const t = now();
  await env.DB.prepare('INSERT INTO projects (id,user_id,title,code,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .bind(id, userId, title || 'Untitled app', '', t, t)
    .run();
  return (await getProject(env, id))!;
}

export function getProject(env: Env, id: string): Promise<ProjectRow | null> {
  return env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<ProjectRow>();
}

export function listProjects(env: Env, userId: string): Promise<{ results: any[] }> {
  return env.DB.prepare(
    `SELECT id,user_id,title,model,is_public,github_repo,github_url,created_at,updated_at,
            (LENGTH(code) > 0) AS has_code
       FROM projects WHERE user_id=? ORDER BY updated_at DESC LIMIT 100`,
  )
    .bind(userId)
    .all();
}

export async function saveProjectCode(env: Env, id: string, code: string, model: string | null): Promise<void> {
  await env.DB.prepare('UPDATE projects SET code=?, model=COALESCE(?,model), updated_at=? WHERE id=?')
    .bind(code, model, now(), id)
    .run();
}

export async function renameProject(env: Env, id: string, title: string): Promise<void> {
  await env.DB.prepare('UPDATE projects SET title=?, updated_at=? WHERE id=?').bind(title, now(), id).run();
}

export async function deleteProject(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id).run();
}

// --- Files (multi-file projects) ----------------------------------------------
export interface FileRow {
  path: string;
  content: string;
}

export async function listFiles(env: Env, projectId: string): Promise<FileRow[]> {
  const { results } = await env.DB.prepare('SELECT path, content FROM files WHERE project_id=? ORDER BY path')
    .bind(projectId)
    .all<FileRow>();
  return results;
}

// Files for a project, falling back to legacy single-file `code` as index.html.
export async function getProjectFiles(env: Env, project: ProjectRow): Promise<FileRow[]> {
  const files = await listFiles(env, project.id);
  if (files.length) return files;
  if (project.code && project.code.trim()) return [{ path: 'index.html', content: project.code }];
  return [];
}

export function getFileRow(env: Env, projectId: string, path: string): Promise<FileRow | null> {
  return env.DB.prepare('SELECT path, content FROM files WHERE project_id=? AND path=?')
    .bind(projectId, path)
    .first<FileRow>();
}

export async function upsertFile(env: Env, projectId: string, path: string, content: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO files (id,project_id,path,content,updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(project_id,path) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`,
  )
    .bind(newId(), projectId, path, content, now())
    .run();
}

export async function deleteFileRow(env: Env, projectId: string, path: string): Promise<void> {
  await env.DB.prepare('DELETE FROM files WHERE project_id=? AND path=?').bind(projectId, path).run();
}

// Save a set of files, and mirror index.html into projects.code for legacy/preview.
export async function saveFiles(env: Env, projectId: string, files: FileRow[], model: string | null): Promise<void> {
  for (const f of files) await upsertFile(env, projectId, f.path, f.content);
  const index = files.find((f) => f.path === 'index.html');
  await env.DB.prepare('UPDATE projects SET code=COALESCE(?,code), model=COALESCE(?,model), updated_at=? WHERE id=?')
    .bind(index ? index.content : null, model, now(), projectId)
    .run();
}

// --- Messages -----------------------------------------------------------------
export async function addMessage(
  env: Env,
  m: { project_id: string; role: string; content: string; model?: string | null; flagged?: boolean },
): Promise<void> {
  await env.DB.prepare('INSERT INTO messages (id,project_id,role,content,model,flagged,created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(newId(), m.project_id, m.role, m.content, m.model ?? null, m.flagged ? 1 : 0, now())
    .run();
}

export function listMessages(env: Env, projectId: string): Promise<{ results: any[] }> {
  return env.DB.prepare('SELECT role,content,model,flagged,created_at FROM messages WHERE project_id=? ORDER BY created_at LIMIT 200')
    .bind(projectId)
    .all();
}

export async function logUsage(
  env: Env,
  e: { user_id: string | null; kind: string; model?: string | null; tokens_in?: number; tokens_out?: number; high_usage?: boolean },
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO usage_events (id,user_id,kind,model,tokens_in,tokens_out,high_usage,created_at) VALUES (?,?,?,?,?,?,?,?)',
  )
    .bind(newId(), e.user_id, e.kind, e.model ?? null, e.tokens_in ?? 0, e.tokens_out ?? 0, e.high_usage ? 1 : 0, now())
    .run();
}

// --- Agents -------------------------------------------------------------------
export interface AgentRow {
  id: string;
  user_id: string;
  project_id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  model: string;
  is_public: number;
  created_at: number;
  updated_at: number;
}

// projectId: when set, return that app's agents plus account-level ('') ones.
export function listAgents(env: Env, userId: string, projectId?: string): Promise<{ results: AgentRow[] }> {
  if (projectId) {
    return env.DB.prepare("SELECT * FROM agents WHERE user_id=? AND (project_id=? OR project_id='') ORDER BY updated_at DESC LIMIT 100")
      .bind(userId, projectId)
      .all<AgentRow>();
  }
  return env.DB.prepare('SELECT * FROM agents WHERE user_id=? ORDER BY updated_at DESC LIMIT 100').bind(userId).all<AgentRow>();
}

export function getAgent(env: Env, id: string): Promise<AgentRow | null> {
  return env.DB.prepare('SELECT * FROM agents WHERE id=?').bind(id).first<AgentRow>();
}

export async function createAgent(
  env: Env,
  userId: string,
  a: { name: string; description?: string; system_prompt: string; model: string; is_public?: boolean; project_id?: string },
): Promise<AgentRow> {
  const id = newId();
  const t = now();
  await env.DB.prepare(
    'INSERT INTO agents (id,user_id,project_id,name,description,system_prompt,model,is_public,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(id, userId, a.project_id ?? '', a.name, a.description ?? null, a.system_prompt, a.model, a.is_public === false ? 0 : 1, t, t)
    .run();
  return (await getAgent(env, id))!;
}

export async function updateAgent(
  env: Env,
  id: string,
  a: { name?: string; description?: string; system_prompt?: string; model?: string; is_public?: boolean },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE agents SET name=COALESCE(?,name), description=COALESCE(?,description),
       system_prompt=COALESCE(?,system_prompt), model=COALESCE(?,model),
       is_public=COALESCE(?,is_public), updated_at=? WHERE id=?`,
  )
    .bind(a.name ?? null, a.description ?? null, a.system_prompt ?? null, a.model ?? null,
      a.is_public == null ? null : a.is_public ? 1 : 0, now(), id)
    .run();
}

export async function deleteAgent(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM agents WHERE id=?').bind(id).run();
}

// --- Secrets (values stored AES-GCM encrypted; per-app or account-level) -------
export function listSecrets(env: Env, userId: string, projectId = ''): Promise<{ results: { id: string; name: string; created_at: number }[] }> {
  return env.DB.prepare('SELECT id,name,created_at FROM secrets WHERE user_id=? AND project_id=? ORDER BY name')
    .bind(userId, projectId)
    .all<{ id: string; name: string; created_at: number }>();
}

export async function upsertSecret(env: Env, userId: string, projectId: string, name: string, valueEnc: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO secrets (id,user_id,project_id,name,value_enc,created_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(user_id,project_id,name) DO UPDATE SET value_enc=excluded.value_enc`,
  )
    .bind(newId(), userId, projectId, name, valueEnc, now())
    .run();
}

export async function deleteSecret(env: Env, userId: string, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM secrets WHERE id=? AND user_id=?').bind(id, userId).run();
}
