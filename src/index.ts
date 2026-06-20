// Yield — Cloudflare Worker entry point.
// Serves the static frontend (./public) and the /api/* JSON+SSE API.

import type { Ctx, Env } from './types';
import { error, json } from './lib/response';
import { getOrCreateDeviceId, readSession } from './lib/auth';
import { ensureGuestUser } from './lib/db';
import { handleGenerate, handleRoute } from './routes/generate';
import { handleProjects, serveProjectFile } from './routes/projects';
import { handleAuth } from './routes/authRoutes';
import { handleBilling } from './routes/billingRoutes';
import { handleModels, handleStatus, handleHealth } from './routes/misc';
import { handleGithubStatus, handleGithubRepos, handleProjectGithub, handleVersions } from './routes/githubRoutes';
import { handleAgents } from './routes/agents';
import { handleSecrets } from './routes/secrets';
import { handleAppData } from './routes/appdata';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Build request context (session user + anon device id).
      let user = await readSession(env, request).catch(() => null);
      // Open testing mode: no login required — everyone acts as a shared guest.
      // Wrapped so a binding hiccup degrades to anonymous instead of a blanket 500.
      if (!user && env.AUTH_ENABLED === 'false') {
        try {
          const guest = await ensureGuestUser(env);
          user = { id: guest.id, email: guest.email, name: guest.name, avatar_url: guest.avatar_url, plan: guest.plan };
        } catch (e) {
          console.error('guest user init failed:', e);
        }
      }
      const { deviceId, setCookie } = await getOrCreateDeviceId(env, request);
      const c: Ctx = { env, ctx, url, user, deviceId };

      let res: Response | null = null;

      if (path === '/api/health') res = await handleHealth(c);
      else if (path === '/api/models') res = handleModels();
      else if (path === '/api/status') res = await handleStatus(c);
      else if (path === '/api/generate' && request.method === 'POST') res = await handleGenerate(request, c);
      else if (path === '/api/route' && request.method === 'POST') res = await handleRoute(request, c);
      else if (path.startsWith('/api/auth/')) {
        const [, , , provider, action] = path.split('/'); // /api/auth/:provider/:action
        res = await handleAuth(request, c, provider, action);
      } else if (path === '/api/github/status') {
        res = await handleGithubStatus(c);
      } else if (path === '/api/github/repos') {
        res = await handleGithubRepos(c);
      } else if (path.startsWith('/api/projects')) {
        const rest = path.slice('/api/projects'.length).replace(/^\//, '');
        const [id, sub] = rest.split('/');
        if (id && sub === 'github' && request.method === 'POST') {
          res = await handleProjectGithub(request, c, id);
        } else if (id && sub === 'versions') {
          res = await handleVersions(request, c, id);
        } else {
          res = await handleProjects(request, c, id || undefined, sub || undefined);
        }
      } else if (path.startsWith('/api/apps/')) {
        const p = path.slice('/api/apps/'.length).split('/'); // [id, 'entities', entity, recordId?]
        if (p[1] === 'entities' && p[0] && p[2]) res = await handleAppData(request, c, p[0], p[2], p[3]);
        else res = error(404, 'Unknown app endpoint');
      } else if (path.startsWith('/api/agents')) {
        const rest = path.slice('/api/agents'.length).replace(/^\//, '');
        const [aid, sub] = rest.split('/');
        res = await handleAgents(request, c, aid || undefined, sub || undefined);
      } else if (path.startsWith('/api/secrets')) {
        const sid = path.slice('/api/secrets'.length).replace(/^\//, '');
        res = await handleSecrets(request, c, sid || undefined);
      } else if (path.startsWith('/api/billing/')) {
        const action = path.split('/')[3];
        res = await handleBilling(request, c, action);
      } else if (path.startsWith('/api/')) {
        res = error(404, 'Unknown endpoint');
      } else {
        // Public project preview file serving: /p/:id/<path>
        if (path.startsWith('/p/')) {
          const rest = path.slice(3);
          const slash = rest.indexOf('/');
          const pid = slash === -1 ? rest : rest.slice(0, slash);
          const fpath = slash === -1 ? '' : rest.slice(slash + 1);
          res = await serveProjectFile(c, pid, fpath);
        } else {
          res = await serveStatic(request, env, path);
        }
      }

      // Attach the anonymous device cookie on first visit.
      if (setCookie && res && !res.headers.has('set-cookie')) {
        res = new Response(res.body, res);
        res.headers.append('set-cookie', setCookie);
      }
      return res!;
    } catch (e: any) {
      return error(500, 'Internal error', { detail: String(e?.message || e).slice(0, 300) });
    }
  },
} satisfies ExportedHandler<Env>;

// Clean URLs -> static files in ./public via the ASSETS binding.
async function serveStatic(request: Request, env: Env, path: string): Promise<Response> {
  let assetPath = path;
  if (path === '/' || path === '') assetPath = '/index.html';
  else if (path === '/app') assetPath = '/app.html';
  else if (path === '/login') assetPath = '/login.html';
  else if (!path.includes('.')) assetPath = `${path}.html`; // /pricing -> /pricing.html

  const assetUrl = new URL(request.url);
  assetUrl.pathname = assetPath;
  const res = await env.ASSETS.fetch(new Request(assetUrl, request));
  if (res.status === 404 && assetPath !== '/index.html') {
    // SPA-ish fallback to the landing page.
    const fallbackUrl = new URL(request.url);
    fallbackUrl.pathname = '/index.html';
    return env.ASSETS.fetch(new Request(fallbackUrl, request));
  }
  return res;
}
