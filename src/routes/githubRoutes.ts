// GitHub endpoints.
//   GET  /api/github/status                 -> { connected, login }
//   GET  /api/github/repos                  -> { repos: [...] }   (to link an existing one)
//   POST /api/projects/:id/github           -> { action: 'create'|'link'|'push'|'unlink', ... }
//
// `syncProjectToGithub` is also called automatically after each generation/manual
// save so a linked project's code stays in sync with no extra clicks.

import type { Ctx } from '../types';
import { json, error } from '../lib/response';
import {
  getGithubAuth, getProject, getProjectFiles, listMessages, saveFiles, setProjectGithub, markGithubSynced, clearProjectGithub,
  type ProjectRow, type FileRow,
} from '../lib/db';
import { decryptToken, createRepo, getCommitFiles, listCommits, listRepos, pushFiles, slugify } from '../lib/github';
import { renderPromptLog } from '../lib/promptlog';

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
    const files = await getProjectFiles(c.env, project);
    if (action === 'create') {
      const name = slugify(body.name || project.title);
      const repo = await createRepo(token, name, body.private ?? false, `${project.title} — built with Yield`);
      await setProjectGithub(c.env, project.id, repo.full_name, repo.html_url, repo.default_branch);
      await pushFiles(token, repo.full_name, repo.default_branch, project.title, files);
      await markGithubSynced(c.env, project.id);
      return json({ ok: true, github_repo: repo.full_name, github_url: repo.html_url });
    }

    if (action === 'link') {
      if (!body.repo) return error(400, 'repo (owner/name) required');
      const branch = body.branch || 'main';
      const url = `https://github.com/${body.repo}`;
      await setProjectGithub(c.env, project.id, body.repo, url, branch);
      await pushFiles(token, body.repo, branch, project.title, files);
      await markGithubSynced(c.env, project.id);
      return json({ ok: true, github_repo: body.repo, github_url: url });
    }

    if (action === 'push') {
      if (!project.github_repo) return error(400, 'Project is not linked to a repo.');
      await pushFiles(token, project.github_repo, project.github_branch || 'main', project.title, files);
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

// GET  /api/projects/:id/versions        list commits (version history)
// POST /api/projects/:id/versions  {sha} restore the app to that commit
export async function handleVersions(req: Request, c: Ctx, projectId: string): Promise<Response> {
  if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });
  const project = await getProject(c.env, projectId);
  if (!project) return error(404, 'Project not found');
  if (project.user_id !== c.user.id) return error(403, 'Not your project');
  if (!project.github_repo) return error(400, 'Connect this app to GitHub to use version history.', { code: 'github_not_connected' });

  const auth = await getGithubAuth(c.env, c.user.id);
  if (!auth) return error(400, 'GitHub not connected.', { code: 'github_not_connected' });
  const token = await decryptToken(c.env, auth.tokenEnc);
  const branch = project.github_branch || 'main';

  try {
    if (req.method === 'GET') {
      return json({ commits: await listCommits(token, project.github_repo, branch, 30) });
    }
    if (req.method === 'POST') {
      const { sha } = (await req.json().catch(() => ({}))) as { sha?: string };
      if (!sha) return error(400, 'sha required');
      const files = await getCommitFiles(token, project.github_repo, sha);
      if (!files.length) return error(400, 'No restorable files at that version.');
      await saveFiles(c.env, project.id, files, null);
      await pushFiles(token, project.github_repo, branch, project.title, files);
      await markGithubSynced(c.env, project.id);
      return json({ ok: true, restored: files.length });
    }
    return error(405, 'Method not allowed');
  } catch (e: any) {
    return error(502, `GitHub error: ${String(e?.message || e).slice(0, 200)}`);
  }
}

/** Best-effort auto-push after a generation or manual save. Never throws. */
export async function syncProjectToGithub(c: Ctx, project: ProjectRow, files: FileRow[]): Promise<void> {
  if (!c.user || !project.github_repo) return;
  try {
    const auth = await getGithubAuth(c.env, c.user.id);
    if (!auth) return;
    const token = await decryptToken(c.env, auth.tokenEnc);
    const push = [...files];
    // Mirror the conversation to a portable, timestamped log in the repo.
    try {
      const { results: msgs } = await listMessages(c.env, project.id);
      if (msgs.length) push.push({ path: '.yield/prompts.txt', content: renderPromptLog(project.title, msgs as any) });
    } catch { /* history is best-effort */ }
    await pushFiles(token, project.github_repo, project.github_branch || 'main', project.title, push);
    await markGithubSynced(c.env, project.id);
  } catch {
    /* don't let a GitHub hiccup fail the build/save */
  }
}
