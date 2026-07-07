// Yield Roblox — AI-built Roblox games synced live into Roblox Studio by a
// companion plugin. Two audiences hit this router:
//   - the WEB APP (session-authenticated, same as every other /api/* route)
//   - the STUDIO PLUGIN (bearer-token authenticated — it never has a cookie)
//
// Web:
//   GET/POST         /api/roblox/projects                    list / create
//   GET/PATCH/DELETE  /api/roblox/projects/:id                get (+files+messages+assets) / rename / delete
//   POST              /api/roblox/projects/:id/generate       AI chat -> Luau scripts (SSE), queues sync ops
//   PUT/DELETE        /api/roblox/projects/:id/files          manual script edit / delete, queues sync ops
//   POST              /api/roblox/projects/:id/map            AI map layout -> a queued build_map op
//   GET/POST/DELETE   /api/roblox/projects/:id/assets[/:id]   the free-model library (pin by asset id)
//   POST              /api/roblox/projects/:id/insert-asset   quick "add this model to my game"
//   POST              /api/roblox/projects/:id/roblox-key     connect/clear a Roblox Open Cloud API key
//   POST              /api/roblox/projects/:id/pair           mint a pairing code for the plugin
//   GET               /api/roblox/projects/:id/ops            recent sync activity log
//   POST              /api/roblox/models/search                marketplace search (needs a connected key)
//   GET               /api/roblox/plugin.lua                   download the Studio plugin (public)
// Plugin (Authorization: Bearer <token>, minted at pairing time):
//   POST /api/roblox/plugin/pair      {code, placeName?, placeId?} -> {token, projectId, projectTitle}
//   GET  /api/roblox/plugin/pull                                   -> {project, ops:[...]}
//   POST /api/roblox/plugin/ack       {results:[{id,ok,detail?}]}
//   POST /api/roblox/plugin/snapshot  {scripts:[...], placeName?, placeId?}
//   GET  /api/roblox/plugin/ping                                   -> {ok, projectId, projectTitle}
//   POST /api/roblox/plugin/unpair                                 -> {ok:true}

import type { Ctx } from '../types';
import { json, error, sse } from '../lib/response';
import { checkPrompt } from '../lib/jailbreak';
import { gateGeneration, recordGeneration } from '../lib/usage';
import { resolveModel, endpointsFor } from '../config/models';
import { chat, chatStream } from '../lib/nvidia';
import { routeModel } from './generate';
import { ROBLOX_CONVO_SYSTEM, ROBLOX_EDIT_NOTE, ROBLOX_MAP_SYSTEM } from '../lib/robloxPrompts';
import {
  makeScriptStreamer, sanitizeScriptPath, sanitizeClassName, sanitizeMapSpec,
  createPairCode, redeemPairCode, mintPluginToken, authenticatePlugin, revokePluginToken,
  searchFreeModels, type PinnedAsset,
} from '../lib/roblox';
import {
  createRobloxProject, getRobloxProject, listRobloxProjects, renameRobloxProject, deleteRobloxProject,
  touchRobloxProject, markRobloxPaired, markRobloxUnpaired, touchRobloxSeen, setRobloxApiKey,
  listRobloxFiles, upsertRobloxFile, deleteRobloxFile,
  addRobloxMessage, listRobloxMessages,
  queueRobloxOps, listPendingRobloxOps, ackRobloxOps, listRecentRobloxOps,
  listRobloxAssets, addRobloxAsset, deleteRobloxAsset,
  saveRobloxMap, logUsage, type RobloxProjectRow,
} from '../lib/db';
import { encryptToken, decryptToken } from '../lib/github';
import { ROBLOX_PLUGIN_SOURCE } from '../lib/robloxPluginSource';

// Anchor models tried (plainly, no reasoning flag) if the chosen/routed model fails
// outright — same idea as generate.ts's STABLE_FALLBACKS, a smaller pool since a
// Luau script is far shorter than a multi-file web app.
const STABLE_FALLBACKS = ['glm-5.1', 'deepseek-v4-flash'];

function effortOf(v: string | undefined): 'low' | 'medium' | 'high' {
  return v === 'low' || v === 'high' ? v : 'medium';
}

function publicProject(p: RobloxProjectRow) {
  const { roblox_api_key_enc, ...rest } = p;
  return { ...rest, robloxKeyConnected: !!roblox_api_key_enc };
}

export async function handleRoblox(req: Request, c: Ctx, rest: string): Promise<Response> {
  const segs = rest.split('/').filter(Boolean);

  if (rest === 'plugin.lua' && req.method === 'GET') return servePlugin(c);
  if (segs[0] === 'plugin') return handlePluginApi(req, c, segs.slice(1));
  if (rest === 'models/search' && req.method === 'POST') return searchModels(req, c);

  if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });
  const user = c.user;

  if (segs[0] !== 'projects') return error(404, 'Not found');
  const id = segs[1];
  const sub = segs[2];
  const sub2 = segs[3];

  if (!id) {
    if (req.method === 'GET') {
      const { results } = await listRobloxProjects(c.env, user.id);
      return json({ projects: results.map(publicProject) });
    }
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { title?: string };
      const project = await createRobloxProject(c.env, user.id, body.title || 'Untitled game');
      return json({ project: publicProject(project) }, { status: 201 });
    }
    return error(405, 'Method not allowed');
  }

  const project = await getRobloxProject(c.env, id);
  if (!project) return error(404, 'Project not found');
  if (project.user_id !== user.id) return error(403, 'Not your project');

  if (!sub) {
    if (req.method === 'GET') {
      const [files, messages, assets] = await Promise.all([
        listRobloxFiles(c.env, id), listRobloxMessages(c.env, id), listRobloxAssets(c.env, id),
      ]);
      return json({ project: publicProject(project), files, messages: messages.results, assets: assets.results });
    }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const body = (await req.json().catch(() => ({}))) as { title?: string };
      if (typeof body.title === 'string' && body.title.trim()) await renameRobloxProject(c.env, id, body.title.trim().slice(0, 80));
      return json({ ok: true });
    }
    if (req.method === 'DELETE') { await deleteRobloxProject(c.env, id); return json({ ok: true }); }
    return error(405, 'Method not allowed');
  }

  if (sub === 'generate' && req.method === 'POST') return generateScripts(req, c, project);
  if (sub === 'map' && req.method === 'POST') return generateMap(req, c, project);
  if (sub === 'files') return handleFiles(req, c, project);
  if (sub === 'assets') return handleAssets(req, c, project, sub2);
  if (sub === 'roblox-key' && req.method === 'POST') return connectRobloxKey(req, c, project);
  if (sub === 'pair' && req.method === 'POST') return pair(c, project);
  if (sub === 'ops' && req.method === 'GET') return opsLog(c, project);
  if (sub === 'insert-asset' && req.method === 'POST') return insertAsset(req, c, project);

  return error(404, 'Not found');
}

// --- Plugin download --------------------------------------------------------------
async function servePlugin(c: Ctx): Promise<Response> {
  const base = (c.env.APP_URL || '').replace(/\/+$/, '');
  const source = ROBLOX_PLUGIN_SOURCE.split('{{APP_URL}}').join(base);
  return new Response(source, {
    headers: {
      'content-type': 'text/x-lua; charset=utf-8',
      'content-disposition': 'attachment; filename="Yield.lua"',
      'cache-control': 'no-store',
    },
  });
}

// --- Plugin API (bearer token, no session) -----------------------------------------
async function handlePluginApi(req: Request, c: Ctx, segs: string[]): Promise<Response> {
  const action = segs[0];

  if (action === 'pair' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { code?: string; placeName?: string; placeId?: string };
    const redeemed = await redeemPairCode(c.env, String(body.code || ''));
    if (!redeemed) return error(400, 'Invalid or expired pairing code. Generate a new one on the Yield website.');
    const project = await getRobloxProject(c.env, redeemed.projectId);
    if (!project) return error(404, 'Project not found');
    const token = await mintPluginToken(c.env, project.id);
    await markRobloxPaired(c.env, project.id, {
      placeName: body.placeName ? String(body.placeName).slice(0, 120) : null,
      placeId: body.placeId ? String(body.placeId).slice(0, 40) : null,
    });
    return json({ token, projectId: project.id, projectTitle: project.title });
  }

  const auth = await authenticatePlugin(c.env, req);
  if (!auth) return error(401, 'Invalid or expired plugin token — re-pair from the Yield website.');
  const project = await getRobloxProject(c.env, auth.projectId);
  if (!project) return error(404, 'Project not found');

  if (action === 'pull' && req.method === 'GET') {
    await touchRobloxSeen(c.env, project.id);
    const { results } = await listPendingRobloxOps(c.env, project.id, 100);
    const ops = results
      .map((r) => { try { return { id: r.id, ...JSON.parse(r.op) }; } catch { return null; } })
      .filter(Boolean);
    return json({ project: { id: project.id, title: project.title }, ops });
  }

  if (action === 'ack' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { results?: { id?: string; ok?: boolean; detail?: string }[] };
    const results = Array.isArray(body.results)
      ? body.results.filter((r): r is { id: string; ok?: boolean; detail?: string } => !!r && typeof r.id === 'string').slice(0, 300)
      : [];
    await ackRobloxOps(c.env, project.id, results.map((r) => ({ id: r.id, ok: !!r.ok, detail: r.detail ? String(r.detail) : undefined })));
    await touchRobloxSeen(c.env, project.id);
    return json({ ok: true, acked: results.length });
  }

  if (action === 'snapshot' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      scripts?: { path?: string; className?: string; source?: string }[]; placeName?: string; placeId?: string;
    };
    const scripts = Array.isArray(body.scripts) ? body.scripts.slice(0, 300) : [];
    let saved = 0;
    for (const s of scripts) {
      const path = sanitizeScriptPath(String(s.path || ''));
      if (!path) continue;
      await upsertRobloxFile(c.env, project.id, path, sanitizeClassName(String(s.className || '')), String(s.source || '').slice(0, 200_000));
      saved++;
    }
    await touchRobloxSeen(c.env, project.id, {
      placeName: body.placeName ? String(body.placeName).slice(0, 120) : null,
      placeId: body.placeId ? String(body.placeId).slice(0, 40) : null,
    });
    return json({ ok: true, saved });
  }

  if (action === 'ping' && req.method === 'GET') {
    await touchRobloxSeen(c.env, project.id);
    return json({ ok: true, projectId: project.id, projectTitle: project.title });
  }

  if (action === 'unpair' && req.method === 'POST') {
    await revokePluginToken(c.env, auth.token);
    await markRobloxUnpaired(c.env, project.id);
    return json({ ok: true });
  }

  return error(404, 'Not found');
}

// --- AI script generation (SSE) -----------------------------------------------------
async function generateScripts(req: Request, c: Ctx, project: RobloxProjectRow): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { prompt?: string; model?: string; thinking?: string };
  const prompt = (body.prompt || '').trim();
  if (!prompt) return error(400, 'prompt required');

  const { response, send, close } = sse();
  const run = async () => {
    try {
      await send('status', { stage: 'Screening prompt' });
      const guard = await checkPrompt(c.env, prompt);
      if (guard.blocked) {
        await addRobloxMessage(c.env, { project_id: project.id, role: 'user', content: prompt });
        await logUsage(c.env, { user_id: c.user?.id ?? null, kind: 'blocked' });
        await send('blocked', { message: 'This prompt was blocked by the safety guard.', detail: guard.reason });
        return;
      }
      const gate = await gateGeneration(c);
      if (!gate.allowed) { await send('gate', { message: gate.reason || 'Not allowed right now.', code: gate.code }); return; }

      await addRobloxMessage(c.env, { project_id: project.id, role: 'user', content: prompt });

      let modelId = body.model && body.model !== 'auto' ? body.model : null;
      let routeReason: string | undefined;
      if (!modelId) {
        await send('status', { stage: 'Picking the best model' });
        const choice = await routeModel(c, prompt);
        modelId = choice.id;
        routeReason = choice.reason;
      }
      let model = resolveModel(modelId);
      await send('meta', { model: model.id, label: model.label, routeReason });

      const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [{ role: 'system', content: ROBLOX_CONVO_SYSTEM }];
      const existing = await listRobloxFiles(c.env, project.id);
      if (existing.length) {
        messages.push({ role: 'system', content: ROBLOX_EDIT_NOTE });
        const dump = existing.map((f) => `=== script: ${f.path} | ${f.class_name} ===\n${f.source}`).join('\n\n');
        messages.push({ role: 'system', content: `Current scripts:\n\n${dump}` });
      }
      const { results: hist } = await listRobloxMessages(c.env, project.id);
      for (const m of hist.slice(0, -1).slice(-12)) { // exclude the turn just added above
        if (m.role === 'user') messages.push({ role: 'user', content: m.content });
        else if (m.role === 'assistant' && m.content) messages.push({ role: 'assistant', content: m.content });
      }
      messages.push({ role: 'user', content: prompt });

      const effort = effortOf(body.thinking);
      const streamer = makeScriptStreamer(send);

      const tryModel = async (m: ReturnType<typeof resolveModel>, eff: 'low' | 'medium' | 'high' | null): Promise<boolean> => {
        const chain = endpointsFor(c.env, m);
        let lastErr: unknown = null;
        for (const ep of chain) {
          try {
            await chatStream(
              {
                baseUrl: ep.baseUrl, apiKey: ep.apiKey, apiKeyBackup: ep.apiKeyBackup, model: ep.modelId, messages,
                temperature: 0.3, top_p: 0.95, timeoutMs: 300000, ...(eff ? { extra: { reasoning_effort: eff } } : {}),
              },
              async (delta) => { await streamer.feed(delta); },
              async (rr) => { await send('thinking', rr); },
            );
            return true;
          } catch (e) {
            lastErr = e;
            if (streamer.produced) return true;
            streamer.reset();
          }
        }
        if (lastErr) throw lastErr;
        return false;
      };

      let ok = false;
      try { ok = await tryModel(model, effort); }
      catch { streamer.reset(); try { ok = await tryModel(model, null); } catch { /* fall through to stable fallbacks */ } }
      if (!ok && !streamer.produced) {
        for (const sid of STABLE_FALLBACKS) {
          if (sid === model.id) continue;
          const fb = resolveModel(sid);
          await send('status', { stage: `${model.label} unavailable — retrying on ${fb.label}…` });
          streamer.reset();
          try { ok = await tryModel(fb, null); model = fb; if (ok) break; } catch { /* try the next anchor */ }
        }
      }
      await streamer.end();
      const result = streamer.result();

      if (result.asked) { await send('done', { asked: true }); return; }
      if (!result.scripts.length && !result.chat) {
        await send('error', { message: 'The model produced nothing usable — try again, maybe with a simpler request.' });
        return;
      }

      for (const s of result.scripts) await upsertRobloxFile(c.env, project.id, s.path, s.className, s.source);
      if (result.scripts.length) {
        await queueRobloxOps(c.env, project.id, result.scripts.map((s) => ({ type: 'upsert_script', path: s.path, className: s.className, source: s.source })));
      }
      if (result.chat) await addRobloxMessage(c.env, { project_id: project.id, role: 'assistant', content: result.chat, model: model.id });
      await touchRobloxProject(c.env, project.id, model.id);
      await recordGeneration(c);
      await logUsage(c.env, { user_id: c.user?.id ?? null, kind: 'roblox_generate', model: model.id });

      await send('done', { scripts: result.scripts.map((s) => ({ path: s.path, className: s.className })), queued: result.scripts.length > 0 });
    } catch (e: any) {
      console.error('roblox generate failed:', e?.stack || e);
      await send('error', { message: String(e?.message || e).slice(0, 300) });
    } finally {
      await close();
    }
  };
  c.ctx.waitUntil(run());
  return response;
}

// --- AI map generation (plain JSON — usually a single fast completion) --------------
async function generateMap(req: Request, c: Ctx, project: RobloxProjectRow): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { prompt?: string; model?: string };
  const prompt = (body.prompt || '').trim();
  if (!prompt) return error(400, 'prompt required');

  const guard = await checkPrompt(c.env, prompt);
  if (guard.blocked) return error(400, 'This prompt was blocked by the safety guard.', { code: 'blocked', detail: guard.reason });
  const gate = await gateGeneration(c);
  if (!gate.allowed) return error(gate.status, gate.reason || 'Not allowed right now.', { code: gate.code });

  const candidates = [resolveModel(body.model && body.model !== 'auto' ? body.model : 'glm-5.1'), resolveModel('deepseek-v4-flash')];
  let text = '';
  let lastErr: unknown = null;
  outer: for (const m of candidates) {
    for (const ep of endpointsFor(c.env, m)) {
      try {
        const r = await chat({
          baseUrl: ep.baseUrl, apiKey: ep.apiKey, apiKeyBackup: ep.apiKeyBackup, model: ep.modelId,
          messages: [{ role: 'system', content: ROBLOX_MAP_SYSTEM }, { role: 'user', content: prompt.slice(0, 2000) }],
          temperature: 0.5, max_tokens: 6000, timeoutMs: 90000,
        });
        if (r.text.trim()) { text = r.text; break outer; }
      } catch (e) { lastErr = e; }
    }
  }
  if (!text.trim()) return error(502, `Map generation failed: ${String((lastErr as any)?.message || lastErr || 'no output').slice(0, 160)}`);

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return error(502, 'The model did not return a usable map layout — try a simpler description.');
  let raw: any;
  try { raw = JSON.parse(jsonMatch[0]); } catch { return error(502, 'The model returned malformed layout data — try again.'); }

  const { results: assetRows } = await listRobloxAssets(c.env, project.id);
  const library: PinnedAsset[] = assetRows.map((a) => ({ asset_id: a.asset_id, name: a.name, tags: a.tags }));
  const { spec, unresolved } = sanitizeMapSpec(raw, library);

  await saveRobloxMap(c.env, project.id, prompt, spec);
  await queueRobloxOps(c.env, project.id, [{ type: 'build_map', spec }]);
  await recordGeneration(c);
  await logUsage(c.env, { user_id: c.user?.id ?? null, kind: 'roblox_map' });

  return json({
    ok: true,
    partCount: spec.parts.length,
    modelCount: spec.models.length,
    unresolved,
    unresolvedHelp: unresolved.length
      ? 'These props need a free model — search the marketplace (connect a Roblox Open Cloud key) or paste an asset id into your library, then regenerate.'
      : null,
  });
}

// --- Manual script edit / delete (also queues a sync op) ---------------------------
async function handleFiles(req: Request, c: Ctx, project: RobloxProjectRow): Promise<Response> {
  if (req.method === 'PUT') {
    const body = (await req.json().catch(() => ({}))) as { path?: string; className?: string; source?: string };
    const path = sanitizeScriptPath(String(body.path || ''));
    if (!path) return error(400, 'A valid script path is required, e.g. "ServerScriptService/Main".');
    const className = sanitizeClassName(String(body.className || 'Script'));
    const source = String(body.source ?? '').slice(0, 200_000);
    await upsertRobloxFile(c.env, project.id, path, className, source);
    await queueRobloxOps(c.env, project.id, [{ type: 'upsert_script', path, className, source }]);
    return json({ ok: true });
  }
  if (req.method === 'DELETE') {
    const path = sanitizeScriptPath(c.url.searchParams.get('path') || '');
    if (!path) return error(400, 'path required');
    await deleteRobloxFile(c.env, project.id, path);
    await queueRobloxOps(c.env, project.id, [{ type: 'delete_script', path }]);
    return json({ ok: true });
  }
  return error(405, 'Method not allowed');
}

// --- Free-model library (manual pin, always works — no Roblox key needed) ----------
async function handleAssets(req: Request, c: Ctx, project: RobloxProjectRow, assetId?: string): Promise<Response> {
  if (!assetId) {
    if (req.method === 'GET') { const { results } = await listRobloxAssets(c.env, project.id); return json({ assets: results }); }
    if (req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { assetId?: string; name?: string; tags?: string };
      // Accept a bare id or a pasted roblox.com/library/<id>/... URL — either way, pull
      // out the first run of digits.
      const m = String(body.assetId || '').match(/\d{3,20}/);
      if (!m) return error(400, 'A numeric Roblox asset id (or a catalog/library URL containing one) is required.');
      const name = String(body.name || `Asset ${m[0]}`).trim().slice(0, 80);
      const tags = String(body.tags || '').slice(0, 200);
      await addRobloxAsset(c.env, project.id, m[0], name, tags);
      return json({ ok: true }, { status: 201 });
    }
    return error(405, 'Method not allowed');
  }
  if (req.method === 'DELETE') { await deleteRobloxAsset(c.env, project.id, assetId); return json({ ok: true }); }
  return error(405, 'Method not allowed');
}

// Quick "add this model to my game" — inserts one asset without a full map generation.
async function insertAsset(req: Request, c: Ctx, project: RobloxProjectRow): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { assetId?: string; name?: string; position?: number[] };
  const m = String(body.assetId || '').match(/\d{3,20}/);
  if (!m) return error(400, 'A numeric Roblox asset id is required.');
  const position = Array.isArray(body.position) && body.position.length === 3 ? body.position.map((n) => Number(n) || 0) : [0, 5, 0];
  await queueRobloxOps(c.env, project.id, [{ type: 'insert_model', assetId: m[0], name: String(body.name || 'Model').slice(0, 60), position, rotation: [0, 0, 0], scale: 1 }]);
  return json({ ok: true });
}

// --- Roblox Open Cloud key (optional; enables live marketplace search) -------------
async function connectRobloxKey(req: Request, c: Ctx, project: RobloxProjectRow): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { apiKey?: string; creatorType?: string; creatorId?: string };
  const apiKey = String(body.apiKey || '').trim();
  if (!apiKey) {
    await setRobloxApiKey(c.env, project.id, null, null, null);
    return json({ ok: true, connected: false });
  }
  const enc = await encryptToken(c.env, apiKey);
  const creatorType = body.creatorType === 'Group' ? 'Group' : 'User';
  const creatorId = body.creatorId ? String(body.creatorId).slice(0, 30) : null;
  await setRobloxApiKey(c.env, project.id, enc, creatorType, creatorId);
  return json({ ok: true, connected: true });
}

// POST /api/roblox/models/search — best-effort marketplace search; needs a connected
// Roblox Open Cloud key on the given project. Always returns a browse fallback URL.
async function searchModels(req: Request, c: Ctx): Promise<Response> {
  if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });
  const body = (await req.json().catch(() => ({}))) as { query?: string; projectId?: string };
  const query = String(body.query || '').trim();
  if (!query) return error(400, 'query required');
  if (!body.projectId) return error(400, 'projectId required');
  const project = await getRobloxProject(c.env, String(body.projectId));
  if (!project || project.user_id !== c.user.id) return error(403, 'Not your project');
  const browseUrl = `https://create.roblox.com/store?Category=3&SearchKeyword=${encodeURIComponent(query)}`;
  if (!project.roblox_api_key_enc) return json({ configured: false, results: [], browseUrl });
  const apiKey = await decryptToken(c.env, project.roblox_api_key_enc);
  const results = await searchFreeModels(apiKey, query);
  return json({ configured: true, results, browseUrl });
}

// --- Pairing + activity log ---------------------------------------------------------
async function pair(c: Ctx, project: RobloxProjectRow): Promise<Response> {
  const { code, expiresAt } = await createPairCode(c.env, project.id);
  return json({ code, expiresAt });
}

async function opsLog(c: Ctx, project: RobloxProjectRow): Promise<Response> {
  const { results } = await listRecentRobloxOps(c.env, project.id, 40);
  const ops = results.map((r) => {
    let parsed: any = {};
    try { parsed = JSON.parse(r.op); } catch { /* ignore malformed row */ }
    return { id: r.id, type: parsed.type, status: r.status, detail: r.detail, created_at: r.created_at, applied_at: r.applied_at };
  });
  return json({ ops, paired: !!project.paired, lastSeenAt: project.last_seen_at, placeName: project.place_name, placeId: project.place_id });
}
