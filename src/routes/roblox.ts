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
//   POST              /api/roblox/projects/:id/generate-model AI-generate a custom 3D model & upload it to Roblox
//   GET               /api/roblox/projects/:id/maps           recent map-generation history
//   POST              /api/roblox/projects/:id/roblox-key     connect/clear a Roblox Open Cloud API key
//   GET               /api/roblox/projects/:id/ops            recent sync activity log
//   POST/GET          /api/roblox/link                        mint a one-time Studio link code / link status
//   POST              /api/roblox/unlink                      revoke every plugin token for this user
//   POST              /api/roblox/models/search                marketplace search (needs a connected key)
//   GET               /api/roblox/plugin.lua                   download the Studio plugin (public)
// Plugin (Authorization: Bearer <permanent user token>):
//   POST /api/roblox/plugin/link      {code} -> {token, robloxUsername}   (one-time; permanent token)
//   GET  /api/roblox/plugin/pull?placeId=&placeName=               -> {project, ops:[...]}
//   POST /api/roblox/plugin/ack       {placeId, placeName?, results:[...]}
//   POST /api/roblox/plugin/snapshot  {placeId, placeName?, scripts:[...]}
//   GET  /api/roblox/plugin/ping?placeId=&placeName=              -> {ok, projectId, projectTitle, robloxUsername}
//   POST /api/roblox/plugin/unlink                                -> {ok:true}  (unlink this install)
// The plugin links ONCE (permanent, user-scoped token). It reports the open place's
// PlaceId on every call and the backend auto-resolves/creates that place's project —
// so it "just picks up" whatever place is open, no naming. Web-side unlink bumps the
// user's link epoch so all outstanding tokens stop resolving.

import type { Ctx, Env } from '../types';
import { json, error, sse } from '../lib/response';
import { checkPrompt } from '../lib/jailbreak';
import { gateGeneration, recordGeneration } from '../lib/usage';
import { resolveModel, endpointsFor } from '../config/models';
import { chat, chatStream } from '../lib/nvidia';
import { routeModel } from './generate';
import { generateImage, generate3dModel } from './media';
import { ROBLOX_CONVO_SYSTEM, ROBLOX_EDIT_NOTE, ROBLOX_MAP_SYSTEM } from '../lib/robloxPrompts';
import {
  makeScriptStreamer, sanitizeScriptPath, sanitizeClassName, sanitizeMapSpec,
  createLinkCode, redeemLinkCode, mintUserToken, authenticatePlugin, revokeUserToken, revokeAllUserTokens,
  searchFreeModels, uploadRobloxModelAsset, type PinnedAsset, type RobloxCreator,
  setGameTree, getGameTree, formatGameTreeForPrompt, sanitizeGenericOp, type GameTreeNode,
  setMarketplaceKey, getMarketplaceKey, marketplaceKeyStatus, validateMarketplaceKey,
} from '../lib/roblox';
import {
  ensureGuestUser,
  createRobloxProject, getRobloxProject, findOrCreateRobloxProjectByPlace, listRobloxProjects,
  renameRobloxProject, deleteRobloxProject,
  touchRobloxProject, touchRobloxSeen, setRobloxApiKey, setRobloxMapPrefs, getRobloxAuth,
  listRobloxFiles, upsertRobloxFile, upsertRobloxFiles, deleteRobloxFile,
  addRobloxMessage, listRobloxMessages,
  queueRobloxOps, listPendingRobloxOps, ackRobloxOps, listRecentRobloxOps,
  listRobloxAssets, addRobloxAsset, deleteRobloxAsset,
  saveRobloxMap, listRobloxMaps, logUsage, type RobloxProjectRow,
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

  // Account-level Studio link (not tied to any one project): generate the one-time
  // link code, report link status, or unlink all this user's plugin installs.
  if (rest === 'link' && req.method === 'POST') return webLink(c, user.id);
  if (rest === 'link' && req.method === 'GET') return linkStatus(c, user.id);
  if (rest === 'unlink' && req.method === 'POST') return webUnlink(c, user.id);

  // Account-level "Marketplace Key" (a Roblox Open Cloud key) — added once, used by
  // the AI to search free models + upload 3D-generated models across every game.
  if (rest === 'marketplace-key' && req.method === 'GET') return json(await marketplaceKeyStatus(c.env, user.id));
  if (rest === 'marketplace-key' && req.method === 'POST') return connectMarketplaceKey(req, c, user.id);

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
  if (sub === 'maps' && req.method === 'GET') return mapsHistory(c, project);
  if (sub === 'files') return handleFiles(req, c, project);
  if (sub === 'assets') return handleAssets(req, c, project, sub2);
  if (sub === 'roblox-key' && req.method === 'POST') return connectRobloxKey(req, c, project);
  if (sub === 'ops' && req.method === 'GET') return opsLog(c, project);
  if (sub === 'tree' && req.method === 'GET') return json({ tree: await getGameTree(c.env, project.id) });
  if (sub === 'insert-asset' && req.method === 'POST') return insertAsset(req, c, project);
  if (sub === 'generate-model' && req.method === 'POST') return generateModelAsset(req, c, project);

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

// --- Plugin API (permanent user-scoped bearer token, no session) --------------------
// The plugin links ONCE (redeems a link code for a permanent token) and thereafter
// just reports the open place's PlaceId on every call; the backend auto-resolves (or
// creates) that place's project. No per-game naming, no re-pairing — it "just picks
// up" whatever place is open. Revoking the token (either side) unlinks everything.
const cap = (s: unknown, n: number) => (s == null ? null : String(s).slice(0, n));

async function handlePluginApi(req: Request, c: Ctx, segs: string[]): Promise<Response> {
  const action = segs[0];

  // One-time link: redeem the code the user generated on the website -> permanent token.
  if (action === 'link' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { code?: string };
    // Open testing mode (AUTH_ENABLED='false'): there are no real accounts — everyone
    // is the shared guest — so the plugin links with ZERO friction (no code, no OAuth)
    // and everything ties back to that one guest. A code IS still honored if given.
    if (c.env.AUTH_ENABLED === 'false') {
      const redeemed = await redeemLinkCode(c.env, String(body.code || ''));
      const guest = await ensureGuestUser(c.env);
      const userId = redeemed?.userId || guest.id;
      const token = await mintUserToken(c.env, userId);
      const ra = await getRobloxAuth(c.env, userId);
      return json({ token, robloxUsername: ra?.roblox_username ?? null, testing: true });
    }
    const redeemed = await redeemLinkCode(c.env, String(body.code || ''));
    if (!redeemed) return error(400, 'Invalid or expired link code. Generate a new one on the Yield website.');
    const token = await mintUserToken(c.env, redeemed.userId);
    const ra = await getRobloxAuth(c.env, redeemed.userId);
    return json({ token, robloxUsername: ra?.roblox_username ?? null });
  }

  const auth = await authenticatePlugin(c.env, req);
  if (!auth) return error(401, 'This Studio isn’t linked (or was unlinked) — link it again from the Yield website.');
  const userId = auth.userId;

  // Unlink: revoke the permanent token for this whole plugin install.
  if (action === 'unlink' && req.method === 'POST') {
    await revokeUserToken(c.env, auth.token);
    return json({ ok: true });
  }

  // Everything else needs the open place; auto-resolve (or create) its project.
  const placeIdRaw = req.method === 'GET'
    ? c.url.searchParams.get('placeId')
    : null;
  const bodyForPlace = req.method === 'POST' ? (await req.json().catch(() => ({}))) as any : {};
  const placeId = cap(placeIdRaw ?? bodyForPlace.placeId, 40);
  const placeName = cap(req.method === 'GET' ? c.url.searchParams.get('placeName') : bodyForPlace.placeName, 120);
  if (!placeId) return error(400, 'placeId is required (publish or open a saved place so it has a PlaceId).');
  const project = await findOrCreateRobloxProjectByPlace(c.env, userId, placeId, placeName);

  if (action === 'pull' && req.method === 'GET') {
    await touchRobloxSeen(c.env, project.id, { placeName });
    const { results } = await listPendingRobloxOps(c.env, project.id, 100);
    const ops = results
      .map((r) => { try { return { id: r.id, ...JSON.parse(r.op) }; } catch { return null; } })
      .filter(Boolean);
    return json({ project: { id: project.id, title: project.title }, ops });
  }

  if (action === 'ack' && req.method === 'POST') {
    const results = Array.isArray(bodyForPlace.results)
      ? (bodyForPlace.results as any[]).filter((r) => r && typeof r.id === 'string').slice(0, 300)
      : [];
    await ackRobloxOps(c.env, project.id, results.map((r: any) => ({ id: r.id, ok: !!r.ok, detail: r.detail ? String(r.detail) : undefined })));
    await touchRobloxSeen(c.env, project.id);
    return json({ ok: true, acked: results.length });
  }

  if (action === 'snapshot' && req.method === 'POST') {
    const scripts = Array.isArray(bodyForPlace.scripts) ? bodyForPlace.scripts.slice(0, 300) : [];
    const toSave = scripts
      .map((s: any) => ({ path: sanitizeScriptPath(String(s.path || '')), className: sanitizeClassName(String(s.className || '')), source: String(s.source || '').slice(0, 200_000) }))
      .filter((s: any): s is { path: string; className: string; source: string } => !!s.path);
    if (toSave.length) await upsertRobloxFiles(c.env, project.id, toSave);
    // Whole-game tree (full read): store it so the AI can see every instance and the
    // web Explorer can render the game. Kept in KV — no D1 migration, any size ok.
    if (Array.isArray(bodyForPlace.tree)) {
      const tree: GameTreeNode[] = bodyForPlace.tree.slice(0, 1500)
        .filter((n: any) => n && typeof n.path === 'string')
        .map((n: any) => ({ path: String(n.path).slice(0, 400), className: String(n.className || 'Instance').slice(0, 40), ...(n.props && typeof n.props === 'object' ? { props: n.props } : {}) }));
      await setGameTree(c.env, project.id, { tree, truncated: !!bodyForPlace.treeTruncated, at: Date.now(), scriptCount: toSave.length });
    }
    await touchRobloxSeen(c.env, project.id, { placeName });
    return json({ ok: true, saved: toSave.length });
  }

  if (action === 'ping' && req.method === 'GET') {
    await touchRobloxSeen(c.env, project.id, { placeName });
    const ra = await getRobloxAuth(c.env, userId);
    return json({ ok: true, projectId: project.id, projectTitle: project.title, robloxUsername: ra?.roblox_username ?? null });
  }

  return error(404, 'Not found');
}

// --- AI script generation (SSE) -----------------------------------------------------
async function generateScripts(req: Request, c: Ctx, project: RobloxProjectRow): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { prompt?: string; model?: string; thinking?: string };
  const prompt = (body.prompt || '').trim().slice(0, 8000);
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
      // Full-game read: the tree the plugin last pushed, so the AI can SEE the whole
      // place (map + every instance) and target real paths when it edits.
      const treeText = formatGameTreeForPrompt(await getGameTree(c.env, project.id));
      if (treeText) messages.push({ role: 'system', content: treeText });
      else messages.push({ role: 'system', content: 'No game snapshot has been pushed yet this session (the Studio plugin has not synced this place). You STILL have full access — build and queue the requested work normally; it applies on the plugin\'s next sync. If the user wants you to see the current contents first, tell them to click "Sync now" / "Push game" in the Yield panel in Roblox Studio (and re-download the plugin if theirs is outdated). Do NOT tell the user you cannot access their game.' });
      // Tell the AI whether marketplace/3D tooling is actually available, so it builds
      // scenery it CAN deliver instead of emitting unresolvable model requests.
      const [assetCount, keyStatus] = await Promise.all([listRobloxAssets(c.env, project.id), marketplaceKeyStatus(c.env, project.user_id)]);
      const hasKey = keyStatus.connected || !!project.roblox_api_key_enc;
      const hasLibrary = (assetCount.results?.length || 0) > 0;
      messages.push({
        role: 'system',
        content: hasKey
          ? `A Marketplace Key IS connected${hasLibrary ? ' and the pinned model library has assets' : ''}, so find_model (marketplace search), gen_model (3D generation), and matched "models" roles can resolve. Still prefer sculpting "props" from parts for most scenery; reach for find_model/gen_model for hero assets.`
          : `IMPORTANT: NO Marketplace Key is connected and the pinned model library is ${hasLibrary ? 'small' : 'empty'}. find_model, gen_model, and unmatched "models" roles will NOT resolve — do NOT use them, and NEVER tell the user you "need a model" or to find/generate one. Build EVERY piece of scenery (trees, rocks, houses, carts, fences, props) yourself as "props" sculpted from parts in build_map — use plenty of parts, colors, and repetition so it looks detailed and extravagant. You can make an excellent map entirely from parts.`,
      });
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
                // A generous completion budget so a multi-script + ops answer is never
                // truncated mid-output — without this the provider default (often small)
                // cuts the model off and the reply "just quits". (Providers that reject
                // the size retry with a safe cap via nvidia.ts's conservative fallback.)
                temperature: 0.3, top_p: 0.95, max_tokens: 16000, timeoutMs: 300000, ...(eff ? { extra: { reasoning_effort: eff } } : {}),
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
      if (!result.scripts.length && !result.chat && !result.images.length && !result.ops.length) {
        await send('error', { message: 'The model produced nothing usable — try again, maybe with a simpler request.' });
        return;
      }

      if (result.scripts.length) {
        await upsertRobloxFiles(c.env, project.id, result.scripts);
        await queueRobloxOps(c.env, project.id, result.scripts.map((s) => ({ type: 'upsert_script', path: s.path, className: s.className, source: s.source })));
      }
      // Agentic ops: the AI can build maps, edit/create/delete/move any instance,
      // find + insert scanned free marketplace models, and 3D-generate models — all
      // from one chat turn. resolveAgentOps validates + resolves them into sync ops.
      let agentQueued = 0;
      const agentNotes: string[] = [];
      if (result.ops && result.ops.length) {
        const r = await resolveAgentOps(c, project, result.ops);
        if (r.queued.length) await queueRobloxOps(c.env, project.id, r.queued);
        agentQueued = r.queued.length + r.pending;
        agentNotes.push(...r.notes);
      }
      // Concept-art images the AI asked to show (never placed in-game — just a
      // visual aid in chat), reusing the same image-gen the web builder uses.
      for (const imgPrompt of result.images) {
        try {
          const url = await generateImage(c.env, imgPrompt);
          if (url) await send('image', { url, prompt: imgPrompt });
        } catch { /* best-effort — a failed concept image shouldn't fail the turn */ }
      }
      if (result.chat) await addRobloxMessage(c.env, { project_id: project.id, role: 'assistant', content: result.chat, model: model.id });
      await touchRobloxProject(c.env, project.id, model.id);
      await recordGeneration(c);
      await logUsage(c.env, { user_id: c.user?.id ?? null, kind: 'roblox_generate', model: model.id });

      await send('done', { scripts: result.scripts.map((s) => ({ path: s.path, className: s.className })), queued: result.scripts.length > 0, edits: agentQueued, notes: agentNotes });
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

// POST /api/roblox/marketplace-key — connect/validate/clear the account-level
// Marketplace Key. The plaintext key is validated, encrypted, and stored; it is
// NEVER echoed back — only a boolean + the non-secret creator id are returned.
async function connectMarketplaceKey(req: Request, c: Ctx, userId: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { apiKey?: string; creatorType?: string; creatorId?: string };
  const apiKey = String(body.apiKey || '').trim();
  if (!apiKey) { await setMarketplaceKey(c.env, userId, null, 'User', null); return json({ connected: false }); }
  const check = await validateMarketplaceKey(apiKey);
  if (!check.ok) return error(400, check.reason || 'That Marketplace Key was rejected.', { code: 'invalid_key' });
  const enc = await encryptToken(c.env, apiKey);
  const creatorType = body.creatorType === 'Group' ? 'Group' : 'User';
  const creatorId = body.creatorId ? (String(body.creatorId).replace(/[^0-9]/g, '').slice(0, 30) || null) : null;
  await setMarketplaceKey(c.env, userId, enc, creatorType, creatorId);
  return json({ connected: true, creatorType, creatorId });
}

// The Roblox Open Cloud key + creator to use for a project: the account-level
// Marketplace Key first (added once, used everywhere), falling back to a legacy
// per-project key if one was set the old way. Returns decrypted key in-memory only.
async function resolveRobloxKey(env: Env, userId: string, project: RobloxProjectRow): Promise<{ apiKey: string; creator: RobloxCreator | null } | null> {
  const acct = await getMarketplaceKey(env, userId);
  if (acct) {
    try {
      const apiKey = await decryptToken(env, acct.enc);
      return { apiKey, creator: acct.creatorId ? { type: acct.creatorType, id: acct.creatorId } : null };
    } catch { /* fall through to any legacy per-project key */ }
  }
  if (project.roblox_api_key_enc) {
    try {
      const apiKey = await decryptToken(env, project.roblox_api_key_enc);
      return { apiKey, creator: project.roblox_creator_id ? { type: project.roblox_creator_type === 'Group' ? 'Group' : 'User', id: project.roblox_creator_id } : null };
    } catch { /* ignore */ }
  }
  return null;
}

// --- Agentic ops: turn what the chat AI asked to DO into queued sync ops -----------
// Direct ops (build_map, set/create/delete/rename/move instance, insert_model) are
// validated and queued as-is. Meta ops the server resolves: find_model → marketplace
// search (needs a key) → a scanned insert; gen_model → 3D generate + upload → insert.
// Free models are ALWAYS virus-scanned by the plugin on insert.
async function resolveAgentOps(c: Ctx, project: RobloxProjectRow, ops: any[]): Promise<{ queued: Record<string, unknown>[]; notes: string[]; pending: number }> {
  const queued: Record<string, unknown>[] = [];
  const notes: string[] = [];
  let pending = 0;
  if (!Array.isArray(ops) || !ops.length) return { queued, notes, pending };

  const { results: assetRows } = await listRobloxAssets(c.env, project.id);
  const library: PinnedAsset[] = assetRows.map((a) => ({ asset_id: a.asset_id, name: a.name, tags: a.tags }));
  const rk = await resolveRobloxKey(c.env, project.user_id, project);
  const apiKey: string | null = rk?.apiKey ?? null;
  const creator: RobloxCreator | null = rk?.creator ?? null;
  const posOf = (v: any, def: number[]) => (Array.isArray(v) && v.length === 3 ? v.map((n: any) => Number(n) || 0) : def);

  for (const op of ops.slice(0, 60)) {
    const type = String(op?.type || '');
    if (type === 'build_map') {
      const specRaw = op.spec && typeof op.spec === 'object' ? op.spec : op;
      const clear = typeof specRaw.clear === 'boolean' ? specRaw.clear : false;
      const { spec, unresolved } = sanitizeMapSpec(specRaw, library, clear);
      queued.push({ type: 'build_map', spec });
      if (unresolved.length) notes.push(`For the map I still need a model for: ${unresolved.slice(0, 8).join(', ')}. Tell me to find or generate them.`);
    } else if (type === 'find_model' || type === 'search_model') {
      const query = String(op.query || op.role || op.name || '').trim().slice(0, 120);
      if (!query) continue;
      let assetId: string | null = null;
      let name = String(op.name || query).slice(0, 60);
      if (apiKey) {
        try { const res = await searchFreeModels(apiKey, query); if (res.length) { assetId = res[0].assetId; if (!op.name) name = res[0].name || name; } } catch { /* degrade */ }
      }
      if (assetId) queued.push({ type: 'insert_model', assetId, name, position: posOf(op.position, [0, 5, 0]), rotation: posOf(op.rotation, [0, 0, 0]), scale: Number(op.scale) || 1 });
      else notes.push(`I couldn't search the marketplace for "${query}" — add your Marketplace Key (⋯ Studio → Marketplace Key) so I can find, virus-scan, and insert free models automatically.`);
    } else if (type === 'gen_model' || type === 'generate_model' || type === 'model3d') {
      const prompt = String(op.prompt || op.description || '').trim().slice(0, 200);
      if (!prompt) continue;
      if (apiKey && creator) { pending++; c.ctx.waitUntil(generateAndInsertModel(c.env, project, prompt, op, apiKey, creator)); }
      else notes.push(`To 3D-generate "${prompt}" I need your Marketplace Key + creator id connected (⋯ Studio → Marketplace Key) so I can upload the mesh to your account.`);
    } else {
      const clean = sanitizeGenericOp(op);
      if (clean) queued.push(clean);
    }
  }
  return { queued, notes, pending };
}

// 3D-generate a mesh, upload it to the user's Roblox account, pin it, and queue a
// scanned insert — runs detached (3D gen is slow) so the chat turn stays responsive.
async function generateAndInsertModel(env: Env, project: RobloxProjectRow, prompt: string, op: any, apiKey: string, creator: RobloxCreator): Promise<void> {
  try {
    const glb = await generate3dModel(env, prompt);
    if (!glb) return;
    const assetId = await uploadRobloxModelAsset(apiKey, creator, glb, prompt.slice(0, 50), `AI-generated for Yield: ${prompt}`.slice(0, 1000));
    if (!assetId) return;
    await addRobloxAsset(env, project.id, assetId, prompt.slice(0, 80), 'ai-generated');
    const position = Array.isArray(op.position) && op.position.length === 3 ? op.position.map((n: any) => Number(n) || 0) : [0, 5, 0];
    await queueRobloxOps(env, project.id, [{ type: 'insert_model', assetId, name: prompt.slice(0, 60), position, rotation: [0, 0, 0], scale: Number(op.scale) || 1 }]);
    await logUsage(env, { user_id: project.user_id, kind: 'roblox_model3d_agent' });
  } catch { /* best-effort — a failed generation must not break anything */ }
}

// --- AI map generation (plain JSON — usually a single fast completion) --------------
// Trained (via prompt) to prioritize real inserted meshes/models over blocky parts,
// build big/ambitious scenes by default, and honor a remembered per-project art
// style + color palette — see ROBLOX_MAP_SYSTEM in src/lib/robloxPrompts.ts.
async function generateMap(req: Request, c: Ctx, project: RobloxProjectRow): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    prompt?: string; model?: string; style?: string; palette?: string; clear?: boolean;
  };
  const prompt = (body.prompt || '').trim();
  if (!prompt) return error(400, 'prompt required');

  const guard = await checkPrompt(c.env, prompt);
  if (guard.blocked) return error(400, 'This prompt was blocked by the safety guard.', { code: 'blocked', detail: guard.reason });
  const gate = await gateGeneration(c);
  if (!gate.allowed) return error(gate.status, gate.reason || 'Not allowed right now.', { code: gate.code });

  // Style/palette: use whatever this request gave, falling back to what's already
  // remembered for the project, so a project's look stays consistent even when the
  // user doesn't re-type it every time. Persist any NEW values given.
  const style = (body.style || '').trim().slice(0, 200) || project.map_style || '';
  const palette = (body.palette || '').trim().slice(0, 200) || project.map_palette || '';
  if (body.style?.trim() || body.palette?.trim()) {
    await setRobloxMapPrefs(c.env, project.id, body.style?.trim() || null, body.palette?.trim() || null);
  }

  let userMsg = prompt.slice(0, 2000);
  if (style) userMsg += `\n\nART STYLE for this project (apply consistently): ${style}`;
  if (palette) userMsg += `\n\nCOLOR PALETTE for this project (apply consistently): ${palette}`;

  // Default `clear`: wipe-and-rebuild for a project's FIRST map (a clean start),
  // add-onto-what's-there for every map after that — unless the caller says
  // otherwise. A hardcoded "always clear" would silently destroy prior work on
  // every follow-up prompt (e.g. "now add a well" nuking the whole village).
  let clear = typeof body.clear === 'boolean' ? body.clear : null;
  if (clear === null) {
    const { results: priorMaps } = await listRobloxMaps(c.env, project.id, 1);
    clear = priorMaps.length === 0;
  }

  const candidates = [resolveModel(body.model && body.model !== 'auto' ? body.model : 'glm-5.1'), resolveModel('deepseek-v4-flash')];
  let text = '';
  let lastErr: unknown = null;
  outer: for (const m of candidates) {
    for (const ep of endpointsFor(c.env, m)) {
      try {
        const r = await chat({
          baseUrl: ep.baseUrl, apiKey: ep.apiKey, apiKeyBackup: ep.apiKeyBackup, model: ep.modelId,
          messages: [{ role: 'system', content: ROBLOX_MAP_SYSTEM }, { role: 'user', content: userMsg }],
          temperature: 0.6, max_tokens: 9000, timeoutMs: 110000,
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
  const { spec, unresolved } = sanitizeMapSpec(raw, library, clear);

  await saveRobloxMap(c.env, project.id, prompt, spec);
  await queueRobloxOps(c.env, project.id, [{ type: 'build_map', spec }]);
  await recordGeneration(c);
  await logUsage(c.env, { user_id: c.user?.id ?? null, kind: 'roblox_map' });

  // Best-effort, non-blocking: for a couple of unmatched roles, ask the 3D-model AI
  // to generate a real custom mesh and upload it to the user's own Roblox account
  // (needs a connected Open Cloud key + creator id — the same feature that powers
  // marketplace search). Runs after the response is sent; the model(s) show up via
  // a follow-up insert_model op once ready, so map generation itself stays fast.
  let pendingCustomModels = 0;
  const mapKey = await resolveRobloxKey(c.env, project.user_id, project);
  if (mapKey?.apiKey && mapKey.creator && unresolved.length) {
    pendingCustomModels = Math.min(2, unresolved.length);
    c.ctx.waitUntil(generateCustomModelsForRoles(c.env, project, unresolved.slice(0, pendingCustomModels), mapKey.apiKey, mapKey.creator));
  }

  return json({
    ok: true,
    partCount: spec.parts.length,
    modelCount: spec.models.length,
    clear,
    style: style || null,
    palette: palette || null,
    unresolved,
    pendingCustomModels,
    unresolvedHelp: unresolved.length
      ? (pendingCustomModels
          ? `Generating ${pendingCustomModels} custom 3D model(s) for these props now — they'll sync automatically once ready. The rest need a free model: search the marketplace or paste an asset id into your library, then regenerate.`
          : 'These props need a free model — search the marketplace (connect a Roblox Open Cloud key) or paste an asset id into your library, then regenerate.')
      : null,
  });
}

// Generate a real 3D mesh (TRELLIS) for each unresolved map role and upload it to
// the user's own Roblox account, pinning it to the library and queuing an insert
// once it's ready. Every step is best-effort — one role failing never blocks the
// others, and this whole function runs detached from the map-generation response.
async function generateCustomModelsForRoles(env: Env, project: RobloxProjectRow, roles: string[], apiKey: string, creator: RobloxCreator): Promise<void> {
  for (const role of roles) {
    try {
      const glb = await generate3dModel(env, role);
      if (!glb) continue;
      const assetId = await uploadRobloxModelAsset(apiKey, creator, glb, role.slice(0, 50), `AI-generated for Yield: ${role}`.slice(0, 1000));
      if (!assetId) continue;
      const name = role.slice(0, 80) || 'AI model';
      await addRobloxAsset(env, project.id, assetId, name, 'ai-generated');
      await queueRobloxOps(env, project.id, [{ type: 'insert_model', assetId, name, position: [0, 5, 0], rotation: [0, 0, 0], scale: 1 }]);
      await logUsage(env, { user_id: project.user_id, kind: 'roblox_model3d_auto' });
    } catch { /* one role failing must not block the rest */ }
  }
}

// GET /api/roblox/projects/:id/maps — recent map-generation history.
async function mapsHistory(c: Ctx, project: RobloxProjectRow): Promise<Response> {
  const { results } = await listRobloxMaps(c.env, project.id, 20);
  const maps = results.map((m) => {
    let spec: any = null;
    try { spec = JSON.parse(m.spec); } catch { /* ignore malformed row */ }
    return { id: m.id, prompt: m.prompt, partCount: spec?.parts?.length || 0, modelCount: spec?.models?.length || 0, created_at: m.created_at };
  });
  return json({ maps });
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
  const rk = await resolveRobloxKey(c.env, c.user.id, project);
  if (!rk?.apiKey) return json({ configured: false, results: [], browseUrl });
  const results = await searchFreeModels(rk.apiKey, query);
  return json({ configured: true, results, browseUrl });
}

// POST /api/roblox/projects/:id/generate-model — AI-generate a custom 3D model
// (TRELLIS) and upload it to the user's own Roblox account as a real asset,
// pinning it to the library. Needs a connected Roblox Open Cloud key + creator id.
async function generateModelAsset(req: Request, c: Ctx, project: RobloxProjectRow): Promise<Response> {
  const rk = await resolveRobloxKey(c.env, c.user!.id, project);
  if (!rk?.apiKey || !rk.creator) {
    return error(400, 'Connect your Marketplace Key (a Roblox Open Cloud key with a creator id) in the Studio panel first.', { code: 'roblox_key_required' });
  }
  const body = (await req.json().catch(() => ({}))) as { prompt?: string; name?: string };
  const prompt = (body.prompt || '').trim();
  if (!prompt) return error(400, 'prompt required');

  const guard = await checkPrompt(c.env, prompt);
  if (guard.blocked) return error(400, 'This prompt was blocked by the safety guard.', { code: 'blocked', detail: guard.reason });
  const gate = await gateGeneration(c);
  if (!gate.allowed) return error(gate.status, gate.reason || 'Not allowed right now.', { code: gate.code });

  const glb = await generate3dModel(c.env, prompt);
  if (!glb) return error(502, "3D model generation isn't configured or failed — try again.");
  await recordGeneration(c);

  const apiKey = rk.apiKey;
  const creator: RobloxCreator = rk.creator;
  const name = (body.name || prompt).slice(0, 50);
  const assetId = await uploadRobloxModelAsset(apiKey, creator, glb, name, `AI-generated for Yield: ${prompt}`.slice(0, 1000));
  if (!assetId) return error(502, 'Generated the model, but uploading it to Roblox failed — check the API key has asset-upload permission for that creator and try again.');

  await addRobloxAsset(c.env, project.id, assetId, name, 'ai-generated');
  await logUsage(c.env, { user_id: c.user?.id ?? null, kind: 'roblox_model3d' });
  return json({ ok: true, assetId, name });
}

// --- Account-level Studio link + activity log ---------------------------------------
// POST /api/roblox/link — mint the one-time code the user pastes into the plugin.
// The resulting plugin token is PERMANENT and USER-scoped, so this is done ONCE ever;
// afterward every place the user opens in Studio auto-syncs with no further setup.
async function webLink(c: Ctx, userId: string): Promise<Response> {
  const { code, expiresAt } = await createLinkCode(c.env, userId);
  return json({ code, expiresAt });
}

// GET /api/roblox/link — whether a Roblox account is connected + when a linked plugin
// was last seen (across any place), for the "connected" UI.
async function linkStatus(c: Ctx, userId: string): Promise<Response> {
  const [ra, { results }] = await Promise.all([
    getRobloxAuth(c.env, userId),
    listRobloxProjects(c.env, userId),
  ]);
  const lastSeenAt = results.reduce<number | null>((max, p) => Math.max(max ?? 0, p.last_seen_at ?? 0) || null, null);
  const linkedPlaces = results.filter((p) => p.place_id).length;
  return json({
    robloxConnected: !!ra?.roblox_user_id,
    robloxUsername: ra?.roblox_username ?? null,
    lastSeenAt,
    linkedPlaces,
  });
}

// POST /api/roblox/unlink — revoke every plugin token for this user (bumps the link
// epoch), so all their Studio installs disconnect on their next request.
async function webUnlink(c: Ctx, userId: string): Promise<Response> {
  await revokeAllUserTokens(c.env, userId);
  return json({ ok: true });
}

async function opsLog(c: Ctx, project: RobloxProjectRow): Promise<Response> {
  const { results } = await listRecentRobloxOps(c.env, project.id, 40);
  const ops = results.map((r) => {
    let parsed: any = {};
    try { parsed = JSON.parse(r.op); } catch { /* ignore malformed row */ }
    return { id: r.id, type: parsed.type, label: opLabel(parsed), status: r.status, detail: r.detail, created_at: r.created_at, applied_at: r.applied_at };
  });
  return json({ ops, paired: !!project.paired, lastSeenAt: project.last_seen_at, placeName: project.place_name, placeId: project.place_id });
}

// A short, human label for one queued Studio action — what the actions feed shows
// (e.g. "ServerScriptService/Sword", "Pine Tree #123", "42 parts · 6 models").
function opLabel(op: any): string {
  switch (op?.type) {
    case 'upsert_script': return String(op.path || 'script');
    case 'delete_script': return String(op.path || 'script');
    case 'insert_model': return `${op.name || 'model'}${op.assetId ? ' #' + op.assetId : ''}`;
    case 'build_map': return `${op.spec?.parts?.length || 0} part(s) · ${op.spec?.models?.length || 0} model(s)`;
    default: return '';
  }
}
