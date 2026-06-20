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
