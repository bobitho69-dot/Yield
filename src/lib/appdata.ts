// Per-app data ("entities"). To keep storage free, records live as JSON in the
// project's GitHub repo (.yield/data/<entity>.json) when the project is linked;
// otherwise they fall back to D1 (testing / not-yet-connected projects).

import type { Env } from '../types';
import { getGithubAuth, type ProjectRow } from './db';
import { decryptToken, getRepoFile, putRepoFile } from './github';
import { newId, now } from './response';

export type Rec = Record<string, any> & { id: string };

interface GhBackend { token: string; repo: string; branch: string }

async function ghBackend(env: Env, project: ProjectRow): Promise<GhBackend | null> {
  if (!project.github_repo) return null;
  const auth = await getGithubAuth(env, project.user_id);
  if (!auth) return null;
  return { token: await decryptToken(env, auth.tokenEnc), repo: project.github_repo, branch: project.github_branch || 'main' };
}

const dataPath = (entity: string) => `.yield/data/${entity}.json`;

async function ghRead(b: GhBackend, entity: string): Promise<Rec[]> {
  const f = await getRepoFile(b.token, b.repo, b.branch, dataPath(entity));
  if (!f) return [];
  try { const arr = JSON.parse(f.content); return Array.isArray(arr) ? arr : []; } catch { return []; }
}
async function ghWrite(b: GhBackend, entity: string, arr: Rec[], msg: string): Promise<void> {
  await putRepoFile(b.token, b.repo, b.branch, dataPath(entity), JSON.stringify(arr, null, 2), `Yield data: ${msg}`);
}

export async function listRecords(env: Env, project: ProjectRow, entity: string): Promise<Rec[]> {
  const b = await ghBackend(env, project);
  if (b) return ghRead(b, entity);
  const { results } = await env.DB.prepare('SELECT data FROM app_data WHERE project_id=? AND entity=? ORDER BY created_at, id')
    .bind(project.id, entity).all<{ data: string }>();
  // One corrupt row must not break the whole list — skip unparseable records.
  return results.map((r) => { try { return JSON.parse(r.data) as Rec; } catch { return null; } }).filter((r): r is Rec => r != null);
}

export async function createRecord(env: Env, project: ProjectRow, entity: string, data: Record<string, any>): Promise<Rec> {
  const t = now();
  // The server owns id + timestamps; never let the client set/override them (prevents
  // id collisions and duplicate-id records).
  const { id: _ignoreId, created_at: _ignoreCreated, updated_at: _ignoreUpdated, ...rest } = data;
  const rec: Rec = { ...rest, id: newId(), created_at: t, updated_at: t };
  const b = await ghBackend(env, project);
  if (b) { const arr = await ghRead(b, entity); arr.push(rec); await ghWrite(b, entity, arr, `create ${entity}`); return rec; }
  await env.DB.prepare('INSERT INTO app_data (id,project_id,entity,data,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .bind(rec.id, project.id, entity, JSON.stringify(rec), t, t).run();
  return rec;
}

export async function getRecord(env: Env, project: ProjectRow, entity: string, id: string): Promise<Rec | null> {
  const b = await ghBackend(env, project);
  if (b) { const arr = await ghRead(b, entity); return arr.find((r) => r.id === id) || null; }
  const row = await env.DB.prepare('SELECT data FROM app_data WHERE project_id=? AND entity=? AND id=?')
    .bind(project.id, entity, id).first<{ data: string }>();
  if (!row) return null;
  try { return JSON.parse(row.data) as Rec; } catch { return null; }
}

export async function updateRecord(env: Env, project: ProjectRow, entity: string, id: string, rawPatch: Record<string, any>): Promise<Rec | null> {
  const t = now();
  // Don't let a patch rewrite the server-owned id/timestamps.
  const { id: _i, created_at: _c, updated_at: _u, ...patch } = rawPatch;
  const b = await ghBackend(env, project);
  if (b) {
    const arr = await ghRead(b, entity);
    const i = arr.findIndex((r) => r.id === id);
    if (i < 0) return null;
    arr[i] = { ...arr[i], ...patch, id, updated_at: t };
    await ghWrite(b, entity, arr, `update ${entity}`);
    return arr[i];
  }
  const cur = await getRecord(env, project, entity, id);
  if (!cur) return null;
  const merged: Rec = { ...cur, ...patch, id, updated_at: t };
  await env.DB.prepare('UPDATE app_data SET data=?, updated_at=? WHERE project_id=? AND entity=? AND id=?')
    .bind(JSON.stringify(merged), t, project.id, entity, id).run();
  return merged;
}

export async function deleteRecord(env: Env, project: ProjectRow, entity: string, id: string): Promise<void> {
  const b = await ghBackend(env, project);
  if (b) { const arr = await ghRead(b, entity); await ghWrite(b, entity, arr.filter((r) => r.id !== id), `delete ${entity}`); return; }
  await env.DB.prepare('DELETE FROM app_data WHERE project_id=? AND entity=? AND id=?').bind(project.id, entity, id).run();
}

export function validEntity(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(name);
}
