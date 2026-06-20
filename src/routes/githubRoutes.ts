// GitHub endpoints.
//   GET  /api/github/status                 -> { connected, login }
//   GET  /api/github/repos                  -> { repos: [...] }   (to link an existing one)
//   POST /api/projects/:id/github           -> { action: 'create'|'link'|'push'|'unlink', ... }
//
// `syncProjectToGithub` is also called automatically after each generation/manual
// save so a linked project's code stays in sync with no extra clicks.

import type { Ctx } from '../types';
import { json, error } from '../lib/response';
import { getGithubAuth, getProject, setProjectGithub, markGithubSynced, clearProjectGithub, type ProjectRow } from '../lib/db';
import { decryptToken, createRepo, listRepos, pushAppCode, slugify } from '../lib/github';

export async function handleGithubStatus(c: Ctx): Promise<Response> {
  if (!c.user) return json({ connected: false });
  const auth = await getGithubAuth(c.env, c.user.id);
  return json({ connected: !!auth, login: auth?.login ?? null });
}

export async function handleGithubRepos(c: Ctx): Promise<Response> {
  if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });
  const auth = await getGithubAuth(c.env, c.user.id);
  if (!auth) return error(400, 'GitHub not connected.', { code: 'github_not_connected' });
  const token = await decryptToken(c.env, auth.tokenEnc);
  return json({ repos: await listRepos(token) });
}

// POST /api/projects/:id/github
export async function handleProjectGithub(req: Request, c: Ctx, projectId: string): Promise<Response> {
  if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });
  const project = await getProject(c.env, projectId);
  if (!project) return error(404, 'Project not found');
  if (project.user_id !== c.user.id) return error(403, 'Not your project');

  const auth = await getGithubAuth(c.env, c.user.id);
  if (!auth) return error(400, 'Connect GitHub first.', { code: 'github_not_connected' });
  const token = await decryptToken(c.env, auth.tokenEnc);

  const body = (await req.json().catch(() => ({}))) as { action?: string; name?: string; private?: boolean; repo?: string; branch?: string };
  const action = body.action || 'push';

  try {
    if (action === 'create') {
      const name = slugify(body.name || project.title);
      const repo = await createRepo(token, name, body.private ?? false, `${project.title} — built with Yield`);
      await setProjectGithub(c.env, project.id, repo.full_name, repo.html_url, repo.default_branch);
      await pushAppCode(token, repo.full_name, repo.default_branch, project.title, project.code);
      await markGithubSynced(c.env, project.id);
      return json({ ok: true, github_repo: repo.full_name, github_url: repo.html_url });
    }

    if (action === 'link') {
      if (!body.repo) return error(400, 'repo (owner/name) required');
      const branch = body.branch || 'main';
      const url = `https://github.com/${body.repo}`;
      await setProjectGithub(c.env, project.id, body.repo, url, branch);
      await pushAppCode(token, body.repo, branch, project.title, project.code);
      await markGithubSynced(c.env, project.id);
      return json({ ok: true, github_repo: body.repo, github_url: url });
    }

    if (action === 'push') {
      if (!project.github_repo) return error(400, 'Project is not linked to a repo.');
      await pushAppCode(token, project.github_repo, project.github_branch || 'main', project.title, project.code);
      await markGithubSynced(c.env, project.id);
      return json({ ok: true, github_url: project.github_url });
    }

    if (action === 'unlink') {
      await clearProjectGithub(c.env, project.id);
      return json({ ok: true });
    }

    return error(400, 'Unknown action');
  } catch (e: any) {
    return error(502, `GitHub error: ${String(e?.message || e).slice(0, 200)}`);
  }
}

/** Best-effort auto-push after a generation or manual save. Never throws. */
export async function syncProjectToGithub(c: Ctx, project: ProjectRow, code: string): Promise<void> {
  if (!c.user || !project.github_repo) return;
  try {
    const auth = await getGithubAuth(c.env, c.user.id);
    if (!auth) return;
    const token = await decryptToken(c.env, auth.tokenEnc);
    await pushAppCode(token, project.github_repo, project.github_branch || 'main', project.title, code);
    await markGithubSynced(c.env, project.id);
  } catch {
    /* don't let a GitHub hiccup fail the build/save */
  }
}
