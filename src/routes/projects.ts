// Projects CRUD + preview serving.
//   GET    /api/projects            list
//   POST   /api/projects            create {title}
//   GET    /api/projects/:id         get (with code + messages)
//   PUT    /api/projects/:id         update {code?, title?}  (manual edits + rename)
//   DELETE /api/projects/:id         delete
//   GET    /api/projects/:id/preview serve the generated app for the iframe
//   GET    /p/:id                    public preview (if is_public)

import type { Ctx } from '../types';
import { json, error } from '../lib/response';
import {
  createProject, deleteProject, getProject, listMessages, listProjects, renameProject, saveProjectCode,
} from '../lib/db';
import { syncProjectToGithub } from './githubRoutes';

function requireUser(c: Ctx) {
  return c.user ? c.user : null;
}

export async function handleProjects(req: Request, c: Ctx, id?: string, sub?: string): Promise<Response> {
  // Public preview is the only unauthenticated route here.
  if (id && sub === 'preview' && req.method === 'GET') return servePreview(c, id);

  const user = requireUser(c);
  if (!user) return error(401, 'Sign in required.', { code: 'login_required' });

  if (!id) {
    if (req.method === 'GET') {
      const { results } = await listProjects(c.env, user.id);
      return json({ projects: results });
    }
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { title?: string };
      const project = await createProject(c.env, user.id, body.title || 'Untitled app');
      return json({ project }, { status: 201 });
    }
    return error(405, 'Method not allowed');
  }

  const project = await getProject(c.env, id);
  if (!project) return error(404, 'Project not found');
  if (project.user_id !== user.id) return error(403, 'Not your project');

  if (req.method === 'GET') {
    const { results } = await listMessages(c.env, id);
    return json({ project, messages: results });
  }
  if (req.method === 'PUT') {
    const body = (await req.json().catch(() => ({}))) as { code?: string; title?: string };
    if (typeof body.code === 'string') {
      await saveProjectCode(c.env, id, body.code, null);
      await syncProjectToGithub(c, project, body.code); // keep linked repo in sync
    }
    if (typeof body.title === 'string') await renameProject(c.env, id, body.title);
    return json({ ok: true });
  }
  if (req.method === 'DELETE') {
    await deleteProject(c.env, id);
    return json({ ok: true });
  }
  return error(405, 'Method not allowed');
}

// Serve the app's HTML for the preview iframe. The frontend points a sandboxed
// iframe at this URL. CSP + sandbox keep generated code isolated from Yield.
async function servePreview(c: Ctx, id: string): Promise<Response> {
  const project = await getProject(c.env, id);
  if (!project) return new Response('Not found', { status: 404 });
  const owns = c.user && project.user_id === c.user.id;
  if (!owns && !project.is_public) return new Response('Forbidden', { status: 403 });
  const html = project.code || '<!DOCTYPE html><title>Empty</title><body style="font:16px system-ui;padding:2rem;color:#666">Nothing generated yet.</body>';
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Generated code is untrusted; lock it down.
      'content-security-policy': "sandbox allow-scripts allow-forms allow-modals allow-popups;",
      'x-content-type-options': 'nosniff',
    },
  });
}
