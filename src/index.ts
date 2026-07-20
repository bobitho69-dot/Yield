/**
 * Yield — Free AI App Builder
 * Copyright (c) 2026 Penusila Digital Solutions LLC
 * Licensed under the MIT License
 * See LICENSE file in the root directory
 */

// Yield — Cloudflare Worker entry point.
// Serves the static frontend (./public) and the /api/* JSON+SSE API.

import type { Ctx, Env } from './types';
import { error, json } from './lib/response';
import { getOrCreateDeviceId, readSession } from './lib/auth';
import { ensureGuestUser, getProject } from './lib/db';
import { handleGenerate, handleRoute } from './routes/generate';
import { handleProjects, serveProjectFile } from './routes/projects';
import { handleAuth } from './routes/authRoutes';
import { handleBilling } from './routes/billingRoutes';
import { handleModels, handleStatus, handleHealth } from './routes/misc';
import { handleGithubStatus, handleGithubRepos, handleProjectGithub, handleVersions } from './routes/githubRoutes';
import { handleAgents } from './routes/agents';
import { handleSecrets } from './routes/secrets';
import { handleAppData } from './routes/appdata';
import { handleMedia, handleModel3d, handleVideo } from './routes/media';
import { handleAudit } from './routes/audit';
import { handleSecurity, runScheduledScans } from './routes/security';
import { handleRoblox } from './routes/roblox';

import { PLATFORM_GUIDE } from './lib/platformGuide';

// Durable Object that runs builds independently of the browser tab (survives refresh).
export { BuildSession } from './durable/buildSession';

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
      else if (path === '/api/docs') res = new Response(PLATFORM_GUIDE, { headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' } });
      else if (path === '/api/models') res = handleModels(c);
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
        } else if (id && sub === 'stream' && request.method === 'GET') {
          res = await handleBuildStream(c, id);
        } else if (id && sub === 'stop' && request.method === 'POST') {
          res = await handleBuildStop(c, id);
        } else {
          res = await handleProjects(request, c, id || undefined, sub || undefined);
        }
      } else if (path === '/api/media/image') {
        res = await handleMedia(request, c);
      } else if (path === '/api/media/model3d') {
        res = await handleModel3d(request, c);
      } else if (path === '/api/media/video') {
        res = await handleVideo(request, c);
      } else if (path === '/api/audit' || path === '/api/audit/history') {
        res = await handleAudit(request, c);
      } else if (path.startsWith('/api/security/')) {
        res = await handleSecurity(request, c, path.slice('/api/security/'.length));
      } else if (path.startsWith('/api/roblox/')) {
        res = await handleRoblox(request, c, path.slice('/api/roblox/'.length));
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
      console.error('unhandled request error:', e?.stack || e);
      return error(500, 'Internal error', { detail: String(e?.message || e).slice(0, 300) });
    }
  },

  // Cron trigger (see wrangler.toml [triggers]): daily re-scan of monitored repos for
  // Yield Security continuous monitoring.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledScans(env).catch((e) => console.error('scheduled scan failed:', e)));
  },
} satisfies ExportedHandler<Env>;

// Reconnect a tab to an in-progress build's live event stream (Durable Object).
// Lets a refreshed/reopened tab resume watching the build it left.
async function handleBuildStream(c: Ctx, id: string): Promise<Response> {
  if (!c.env.BUILDER) return error(503, 'Builds stream unavailable');
  const project = await getProject(c.env, id);
  if (!project) return error(404, 'Project not found');
  // Build streams (and the projects that own them) always belong to a user; an
  // anonymous request has no business attaching to one. Require ownership.
  if (!c.user || project.user_id !== c.user.id) return error(403, 'Not your project');
  const stub = c.env.BUILDER.get(c.env.BUILDER.idFromName(id));
  return stub.fetch('https://build.yield/attach');
}

// Stop an in-progress build: forward to the build's Durable Object, which aborts the
// model fetches. The build then saves any partial work and ends cleanly.
async function handleBuildStop(c: Ctx, id: string): Promise<Response> {
  if (!c.env.BUILDER) return error(503, 'Builds unavailable');
  const project = await getProject(c.env, id);
  if (!project) return error(404, 'Project not found');
  if (!c.user || project.user_id !== c.user.id) return error(403, 'Not your project');
  const stub = c.env.BUILDER.get(c.env.BUILDER.idFromName(id));
  return stub.fetch('https://build.yield/stop', { method: 'POST' });
}

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
