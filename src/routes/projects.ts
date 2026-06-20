// Projects CRUD + multi-file editing + preview serving.
//   GET    /api/projects                 list
//   POST   /api/projects                 create {title}
//   GET    /api/projects/:id             get (project + messages)
//   PUT    /api/projects/:id             rename {title}
//   DELETE /api/projects/:id             delete
//   GET    /api/projects/:id/files       list files [{path, content}]
//   PUT    /api/projects/:id/files       upsert {path, content}  (manual edit)
//   DELETE /api/projects/:id/files?path= remove a file
//   GET    /p/:id/<path>                 serve a project file (sandboxed) for the preview iframe

import type { Ctx } from '../types';
import { json, error } from '../lib/response';
import {
  createProject, deleteProject, deleteFileRow, getProject, getProjectFiles, listFiles, listMessages,
  listProjects, renameProject, saveFiles, upsertFile,
} from '../lib/db';
import { syncProjectToGithub } from './githubRoutes';

export async function handleProjects(req: Request, c: Ctx, id?: string, sub?: string): Promise<Response> {
  // Preview file serving is the only route allowed without auth (public/owned).
  if (id && sub === 'preview' && req.method === 'GET') return serveProjectFile(c, id, 'index.html');

  if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });
  const user = c.user;

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

  // ---- Files ----
  if (sub === 'files') {
    if (req.method === 'GET') {
      const files = await getProjectFiles(c.env, project);
      return json({ files });
    }
    if (req.method === 'PUT') {
      const body = (await req.json().catch(() => ({}))) as { path?: string; content?: string };
      const path = (body.path || '').replace(/^\/+/, '');
      if (!path) return error(400, 'path required');
      await upsertFile(c.env, id, path, body.content ?? '');
      // mirror index.html into projects.code; sync the whole project to GitHub
      const files = await listFiles(c.env, id);
      await saveFiles(c.env, id, files, null);
      await syncProjectToGithub(c, project, files);
      return json({ ok: true });
    }
    if (req.method === 'DELETE') {
      const path = c.url.searchParams.get('path');
      if (!path) return error(400, 'path required');
      await deleteFileRow(c.env, id, path);
      return json({ ok: true });
    }
    return error(405, 'Method not allowed');
  }

  // ---- Project ----
  if (req.method === 'GET') {
    const { results } = await listMessages(c.env, id);
    return json({ project, messages: results });
  }
  if (req.method === 'PUT') {
    const body = (await req.json().catch(() => ({}))) as { title?: string };
    if (typeof body.title === 'string') await renameProject(c.env, id, body.title);
    return json({ ok: true });
  }
  if (req.method === 'DELETE') {
    await deleteProject(c.env, id);
    return json({ ok: true });
  }
  return error(405, 'Method not allowed');
}

const CTYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
};

// Serve a single project file for the preview iframe. Each response is sandboxed
// (opaque origin) so untrusted generated code can't touch Yield or its cookies.
export async function serveProjectFile(c: Ctx, projectId: string, filePath: string): Promise<Response> {
  const project = await getProject(c.env, projectId);
  if (!project) return new Response('Not found', { status: 404 });
  const owns = c.user && project.user_id === c.user.id;
  if (!owns && !project.is_public) return new Response('Forbidden', { status: 403 });

  let path = (filePath || 'index.html').replace(/^\/+/, '');
  if (path === '' || path.endsWith('/')) path += 'index.html';

  const files = await getProjectFiles(c.env, project);
  let file = files.find((f) => f.path === path);
  // SPA-ish fallback: unknown non-asset path -> index.html
  if (!file && !path.includes('.')) file = files.find((f) => f.path === 'index.html');
  if (!file) return new Response('Not found', { status: 404 });

  const ext = path.split('.').pop()?.toLowerCase() || 'txt';
  // For HTML previews, inject a tiny reporter that forwards runtime errors to the
  // builder (parent window) so it can detect broken code and auto-fix it.
  const body = ext === 'html' ? REPORTER + file.content : file.content;
  return new Response(body, {
    headers: {
      'content-type': CTYPES[ext] || 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "sandbox allow-scripts allow-forms allow-modals allow-popups;",
      'x-content-type-options': 'nosniff',
    },
  });
}

// Runs first inside the preview iframe; posts errors to the builder.
const REPORTER = `<script>(function(){function r(k,m){try{parent.postMessage({__yield:true,kind:k,message:String(m).slice(0,500)},'*')}catch(e){}}
window.addEventListener('error',function(e){r('error',(e.message||'Error')+(e.filename?(' @ '+(e.filename.split('/').pop())+':'+e.lineno):''))});
window.addEventListener('unhandledrejection',function(e){r('rejection',(e.reason&&e.reason.message)||e.reason||'Unhandled promise rejection')});
var ce=console.error;console.error=function(){r('console',[].map.call(arguments,String).join(' '));ce.apply(console,arguments)};
try{parent.postMessage({__yield:true,kind:'ready'},'*')}catch(e){}})();</script>`;
