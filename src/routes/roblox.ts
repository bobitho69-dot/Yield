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
//   POST              /api/roblox/models/search                marketplace search (legacy/best-effort — the AI's find_model searches in Studio instead)
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
import { resolveModel, endpointFor, endpointsFor } from '../config/models';
import { chat, chatStream } from '../lib/nvidia';
import { routeModel } from './generate';
import { generateImage, generate3dModel } from './media';
import { ROBLOX_CONVO_SYSTEM, ROBLOX_EDIT_NOTE, ROBLOX_MAP_SYSTEM, ROBLOX_QUALITY_SYSTEM } from '../lib/robloxPrompts';
import {
  makeScriptStreamer, sanitizeScriptPath, sanitizeClassName, sanitizeMapSpec, cleanOpPath,
  createLinkCode, redeemLinkCode, mintUserToken, authenticatePlugin, revokeUserToken, revokeAllUserTokens,
  searchFreeModels, uploadRobloxModelAsset, type PinnedAsset, type RobloxCreator, type UnresolvedRole,
  setGameTree, getGameTree, formatGameTreeForPrompt, sanitizeGenericOp, type GameTreeNode,
  setMarketplaceKey, getMarketplaceKey, marketplaceKeyStatus, validateMarketplaceKey,
  parseGlbMesh, glbBytesFromResult, extractOpsFromChat, isStudioLinked,
  hasTextureGen, storeTexturePixels, loadTexturePixels, type TexturePixels,
} from '../lib/roblox';
import { decodePng, downscaleRgba } from '../lib/png';
import { lookupRobloxDocs, autoPrefetchDocs } from '../lib/robloxDocs';
import {
  ensureGuestUser,
  createRobloxProject, getRobloxProject, findOrCreateRobloxProjectByPlace, listRobloxProjects,
  renameRobloxProject, deleteRobloxProject,
  touchRobloxProject, touchRobloxSeen, setRobloxApiKey, setRobloxMapPrefs, getRobloxAuth,
  listRobloxFiles, upsertRobloxFile, upsertRobloxFiles, deleteRobloxFile,
  addRobloxMessage, listRobloxMessages,
  queueRobloxOps, listPendingRobloxOps, ackRobloxOps, getRobloxOpTypes, listRecentRobloxOps,
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

  // "What's happening" interpreter: gpt-oss-20b turns the raw live-activity feed
  // into a plain-English one-liner for the dropdown's non-raw view.
  if (rest === 'interpret' && req.method === 'POST') return interpretHappening(req, c);

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
  if (sub === 'playtest' && req.method === 'POST') return webPlaytest(c, project);
  if (sub === 'quality-review' && req.method === 'POST') return qualityReview(req, c, project);

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

  // Raw RGBA pixel download for a queued texture op (apply_texture / a textured
  // create_mesh). Keys are scoped to the authenticated plugin's user, so a leaked id
  // is useless to any other account's Studio.
  if (action === 'texture' && req.method === 'GET') {
    const buf = await loadTexturePixels(c.env, userId, String(c.url.searchParams.get('id') || ''));
    if (!buf) return error(404, 'Texture expired or not found — ask the AI to regenerate it.');
    return new Response(buf, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
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
    // A playtest op's result is a transcript, not just pass/fail — post it into chat
    // history so it's visible to the AI on its NEXT reply (same next-turn timing as
    // lookup_docs; the model that queued it already finished streaming). Best-effort:
    // acking below is the important part — if the type lookup fails, still ack.
    try {
      const types = await getRobloxOpTypes(c.env, project.id, results.map((r: any) => r.id));
      for (const r of results) {
        if (types.get(r.id) === 'playtest' && r.detail) {
          // Always shown, not conditional: a script can write to a DataStore or call
          // HttpService without that ever showing up as an Error/Warning line, so the
          // absence of one in the transcript is not proof nothing irreversible happened.
          await addRobloxMessage(c.env, { project_id: project.id, role: 'assistant', content: `🧪 ${String(r.detail).slice(0, 3800)}\n\n(Any real DataStore writes or HTTP calls made during this run are permanent and were NOT undone — only tracked instance/property changes were reverted, best-effort.)` });
        }
      }
    } catch (e) { console.error('playtest result relay failed:', e); }
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
      // Tell the AI what tooling is available. find_model ALWAYS works (the Studio
      // plugin searches the marketplace itself — no key involved), and gen_model
      // works whenever the 3D generator is configured server-side. The Marketplace
      // Key only adds the optional publish-to-account fallback for generated meshes.
      const [assetCount, keyStatus] = await Promise.all([listRobloxAssets(c.env, project.id), marketplaceKeyStatus(c.env, project.user_id)]);
      const hasKey = keyStatus.connected || !!project.roblox_api_key_enc;
      const hasLibrary = (assetCount.results?.length || 0) > 0;
      const has3d = !!(c.env.TRELLIS_API_URL && c.env.NVIDIA_API_KEY);
      const hasTexture = hasTextureGen(c.env);
      messages.push({
        role: 'system',
        content:
          `find_model (free-model marketplace search) IS available — the Studio plugin itself searches, virus-scans, and inserts the top match, no key needed. ` +
          (has3d
            ? 'gen_model (custom 3D mesh generation) IS available — it builds the mesh directly in Studio with no publishing; it is slow (~a minute each), so reserve it for special hero props. Give it an optional "texture" field (e.g. "weathered gray stone") to have it come out textured, not flat-colored. '
            : 'gen_model (custom 3D mesh generation) is NOT configured on this server — do not use it. ') +
          (hasTexture
            ? 'apply_texture IS available — generates a real image texture and applies it to an existing Part/MeshPart/Model as a PBR SurfaceAppearance (mode "surface", the default — best for walls, ground, props, character skins) or a flat Decal on one face (mode "decal" — best for signs, screens, posters). Use it whenever a surface should look like something specific (brick, wood grain, rusted metal, a poster, grass) instead of a flat Material color. '
            : 'apply_texture (AI texture generation) is NOT configured on this server — do not use it; fall back to Material + Color. ') +
          'lookup_docs IS available — pass a Roblox class name, member, or topic ("TweenService", "Humanoid:GetState", "remote events") to fetch the LIVE official API reference/guide and have it appear in chat for your next reply; use it when you are not fully certain of an exact property/method/event shape instead of guessing. ' +
          'playtest IS available — actually runs the place in Studio and reports real Errors/Warnings back to you next reply; use it after risky script changes to self-verify. ' +
          'quality_review IS available — a structural polish critique benchmarked against researched top-Roblox-game patterns (not a screenshot comparison); use it when asked how the game compares to top games or for a polish check. ' +
          (hasLibrary ? 'The pinned model library has assets, so matched "models" roles work too. ' : '') +
          (hasKey ? 'A Marketplace Key is connected (used only to publish generated meshes to the user\'s account when needed). ' : '') +
          'Still sculpt the BULK of scenery (trees, rocks, houses, fences) yourself as "props" built from parts — use find_model for hero marketplace assets and gen_model for the occasional bespoke mesh. NEVER tell the user you "need a model" or lack access — you have the tools.',
      });
      try {
        const docsHit = await autoPrefetchDocs(c.env, prompt);
        if (docsHit) messages.push({ role: 'system', content: `Live Roblox API reference for terms in this request — verify shapes against this before using them (it is authoritative, current, and overrides your own memory of the API):\n\n${docsHit}` });
      } catch { /* best-effort — a docs lookup failure must never block generation */ }
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

      // Gate every retry on streamer.produced, NOT on tryModel's return value — a
      // reasoning model can burn its ENTIRE token budget inside <think> and stream
      // back a fully successful (non-throwing) response that contains zero usable
      // chat/code/ops. That used to short-circuit the whole fallback chain (ok was
      // true), so the request just died with "produced nothing usable" instead of
      // ever trying a different model. content-emptiness, not transport success, is
      // what decides whether we keep trying.
      const attempt = async (m: ReturnType<typeof resolveModel>, eff: 'low' | 'medium' | 'high' | null): Promise<void> => {
        streamer.reset();
        try { await tryModel(m, eff); } catch { /* swallow — caller checks streamer.produced */ }
      };

      await attempt(model, effort);
      if (!streamer.produced && effort) await attempt(model, null); // drop forced reasoning, try again
      if (!streamer.produced) {
        for (const sid of STABLE_FALLBACKS) {
          if (sid === model.id) continue;
          const fb = resolveModel(sid);
          await send('status', { stage: `${model.label} produced nothing — retrying on ${fb.label}…` });
          await attempt(fb, null);
          if (streamer.produced) { model = fb; break; }
        }
      }
      await streamer.end();
      const result = streamer.result();

      if (result.asked) { await send('done', { asked: true }); return; }
      // Recovery net: if the model printed its ops JSON into plain chat instead of a
      // fenced block, extract them so the build still happens.
      const agentOps = result.ops && result.ops.length ? result.ops : extractOpsFromChat(result.chat);
      if (!result.scripts.length && !result.chat && !result.images.length && !agentOps.length) {
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
      const agentInfo: string[] = [];
      if (agentOps.length) {
        const r = await resolveAgentOps(c, project, agentOps);
        if (r.queued.length) await queueRobloxOps(c.env, project.id, r.queued);
        agentQueued = r.queued.length + r.pending;
        agentNotes.push(...r.notes);
        agentInfo.push(...r.info);
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

      // notes = problems (client shows amber ⚠); info = neutral FYIs (docs fetched,
      // marketplace searching) so successes never read as warnings.
      await send('done', { scripts: result.scripts.map((s) => ({ path: s.path, className: s.className })), queued: result.scripts.length > 0, edits: agentQueued, notes: agentNotes, info: agentInfo });
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

// POST /api/roblox/interpret — { lines: string[] } -> { text, interpreted }
// Feeds the tail of the raw live-activity feed (statuses, files being written,
// ops queued) to gpt-oss-20b and returns 1–2 plain-English sentences describing
// what the AI is doing right now. Falls back to the last raw line when the
// interpreter model is unavailable, so the dropdown always has something to show.
async function interpretHappening(req: Request, c: Ctx): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { lines?: unknown };
  const lines = (Array.isArray(body.lines) ? body.lines : [])
    .map((l) => String(l).slice(0, 300))
    .slice(-40);
  const feed = lines.join('\n').slice(-3000);
  if (!feed.trim()) return json({ text: 'Waiting for the AI to start…', interpreted: false });

  try {
    const router = resolveModel('auto'); // gpt-oss-20b — small + fast
    const ep = endpointFor(c.env, router);
    const { text } = await chat({
      baseUrl: ep.baseUrl, apiKey: ep.apiKey, apiKeyBackup: ep.apiKeyBackup, model: ep.modelId,
      messages: [
        {
          role: 'system',
          content:
            'You are narrating a live activity feed from an AI that is building a Roblox game (writing Luau scripts, building maps, inserting/generating 3D models). Given the raw feed, reply with 1-2 SHORT plain-English sentences, present tense, describing what the AI is doing RIGHT NOW for a non-technical user. Focus on the most recent lines. No preamble, no markdown, no quotes — just the sentence(s).',
        },
        { role: 'user', content: feed },
      ],
      temperature: 0.2, max_tokens: 1200, timeoutMs: 12000,
      extra: { reasoning_effort: 'low' }, // gpt-oss reasons — keep it snappy
    });
    const out = text.trim().replace(/\s+/g, ' ').slice(0, 300);
    if (out) return json({ text: out, interpreted: true });
  } catch { /* fall through to the raw-tail fallback */ }
  const tail = [...lines].reverse().find((l) => l.trim());
  return json({ text: tail || 'Working…', interpreted: false });
}

// POST /api/roblox/marketplace-key — connect/rotate/clear the account-level
// Marketplace Key. The plaintext key is validated, encrypted, and stored; it is
// NEVER echoed back — pasting a new key always REPLACES the saved one (that's the
// rotation flow — there's no separate endpoint). The response includes a `last4`
// fingerprint (last 4 characters only) so the UI can confirm which key is saved
// without ever exposing the secret itself.
async function connectMarketplaceKey(req: Request, c: Ctx, userId: string): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { apiKey?: string; creatorType?: string; creatorId?: string };
  const apiKey = String(body.apiKey || '').trim();
  if (!apiKey) { await setMarketplaceKey(c.env, userId, null, 'User', null, null); return json({ connected: false }); }
  const check = await validateMarketplaceKey(apiKey);
  if (!check.ok) return error(400, check.reason || 'That Marketplace Key was rejected.', { code: 'invalid_key' });
  const enc = await encryptToken(c.env, apiKey);
  const creatorType = body.creatorType === 'Group' ? 'Group' : 'User';
  const creatorId = body.creatorId ? (String(body.creatorId).replace(/[^0-9]/g, '').slice(0, 30) || null) : null;
  const last4 = apiKey.slice(-4);
  await setMarketplaceKey(c.env, userId, enc, creatorType, creatorId, last4);
  return json({ connected: true, creatorType, creatorId, last4 });
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
// search queued for the Studio plugin (no key) → a scanned insert; gen_model →
// 3D generate → local mesh import (or key-based upload fallback) → insert.
// Free models are ALWAYS virus-scanned by the plugin on insert.
// A texture the AI asked for, held as a placeholder in the op list so the finished
// apply_texture op lands at its ORIGINAL position — the model may rename/move/delete
// the same instance later in the same reply, and reordering textures to the end
// would make them run against stale paths.
interface TextureJob { __tex: true; path: string; prompt: string; mode: 'surface' | 'decal'; face?: string; studsPerTile: number; done?: Record<string, unknown> | null }
const TEXTURE_FACES = ['Front', 'Back', 'Top', 'Bottom', 'Left', 'Right'];

async function resolveAgentOps(c: Ctx, project: RobloxProjectRow, ops: any[]): Promise<{ queued: Record<string, unknown>[]; notes: string[]; info: string[]; pending: number }> {
  // slots preserves the model's emission order; texture placeholders are resolved in
  // parallel afterwards and spliced back in place.
  const slots: (Record<string, unknown> | TextureJob)[] = [];
  const notes: string[] = []; // problems worth showing with a warning
  const info: string[] = []; // neutral FYIs (docs fetched, marketplace searching)
  let pending = 0;
  const textureJobs: TextureJob[] = [];
  const docsQueries: string[] = [];
  let playtestQueued = false;
  let qualityReviewRequested = false;
  if (!Array.isArray(ops) || !ops.length) return { queued: [], notes, info, pending };

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
      const { spec, unresolvedDetail } = sanitizeMapSpec(specRaw, library, clear);
      slots.push({ type: 'build_map', spec });
      // Model roles with no pinned match: search the marketplace IN Studio and place
      // the scanned top result right where the map wanted it (capped so one map
      // can't trigger dozens of searches).
      slots.push(...findModelOpsForRoles(unresolvedDetail, info));
    } else if (type === 'find_model' || type === 'search_model') {
      const query = String(op.query || op.role || op.name || '').trim().slice(0, 120);
      if (!query) continue;
      // Marketplace search happens IN Studio (InsertService:GetFreeModels) — Roblox
      // has no Open Cloud scope for toolbox search, so no server-side key can do it.
      // The plugin searches, virus-scans, and inserts the top match on next sync.
      slots.push({
        type: 'find_model', query, name: String(op.name || '').slice(0, 60),
        position: posOf(op.position, [0, 5, 0]), rotation: posOf(op.rotation, [0, 0, 0]),
        scale: Number(op.scale) || 1,
      });
    } else if (type === 'upsert_script') {
      // Some models deliver scripts through the ops block instead of "=== script:"
      // markers. Honor them — dropping a whole script silently reads as "the AI
      // did nothing" even though it announced the code in chat.
      const path = sanitizeScriptPath(String(op.path || ''));
      const className = sanitizeClassName(String(op.className || 'Script'));
      const source = String(op.source ?? op.code ?? '').slice(0, 200_000);
      if (path && source.trim()) {
        await upsertRobloxFile(c.env, project.id, path, className, source);
        slots.push({ type: 'upsert_script', path, className, source });
      }
    } else if (type === 'delete_script') {
      const path = sanitizeScriptPath(String(op.path || ''));
      if (path) {
        await deleteRobloxFile(c.env, project.id, path);
        slots.push({ type: 'delete_script', path });
      }
    } else if (type === 'gen_model' || type === 'generate_model' || type === 'model3d') {
      const prompt = String(op.prompt || op.description || '').trim().slice(0, 200);
      if (!prompt) continue;
      if (!c.env.TRELLIS_API_URL || !c.env.NVIDIA_API_KEY) {
        notes.push(`3D model generation isn't configured on this server, so I couldn't generate "${prompt}" — I'll sculpt it from parts instead if you ask again.`);
        continue;
      }
      // Build the mesh LOCALLY in Studio (no publish, no key needed); fall back to an
      // Open Cloud upload only if the geometry can't be imported and a key exists.
      pending++;
      c.ctx.waitUntil(generateAndPlaceMesh(c.env, project, prompt, op, apiKey, creator));
    } else if (type === 'lookup_docs') {
      // Resolved SERVER-SIDE after the loop (in parallel, capped) — the result is
      // posted into chat history so it's available on the AI's NEXT reply; the model
      // that emitted this op already finished streaming.
      const query = String(op.query || op.class || op.topic || '').trim().slice(0, 200);
      if (!query || docsQueries.some((q) => q.toLowerCase() === query.toLowerCase())) continue;
      if (docsQueries.length >= 3) { info.push(`Skipped extra docs lookup "${query}" — up to 3 per reply.`); continue; }
      docsQueries.push(query);
    } else if (type === 'apply_texture' || type === 'gen_texture' || type === 'texture') {
      const path = cleanOpPath(op.path);
      const prompt = String(op.prompt || op.texture || op.description || '').trim().slice(0, 200);
      if (!path || !prompt) continue;
      if (!hasTextureGen(c.env)) {
        notes.push(`Texture generation isn't configured on this server, so I couldn't texture "${path}" — using Material/Color instead.`);
        continue;
      }
      if (textureJobs.length >= 4) {
        notes.push(`Skipped texturing "${path}" — up to 4 textures per reply; ask again for more.`);
        continue;
      }
      // Models slip on enum casing constantly ("front", "DECAL") — normalize instead
      // of letting a case slip kill the whole op in Studio.
      const faceRaw = typeof op.face === 'string' ? op.face.trim().toLowerCase() : '';
      const job: TextureJob = {
        __tex: true, path, prompt,
        mode: String(op.mode || '').trim().toLowerCase() === 'decal' ? 'decal' : 'surface',
        face: TEXTURE_FACES.find((f) => f.toLowerCase() === faceRaw),
        studsPerTile: Math.max(1, Math.min(64, Number(op.studsPerTile) || 8)),
      };
      textureJobs.push(job);
      slots.push(job); // placeholder — resolved below, in this exact position
    } else if (type === 'playtest') {
      // Queued straight to the plugin like any other op — it runs Studio's Run
      // simulation and reports errors/warnings back through the normal ack flow
      // (see handlePluginApi's `ack` handler), which posts the results into chat.
      if (playtestQueued) { info.push('Skipped an extra playtest — only 1 per reply.'); continue; }
      if (await hasPendingPlaytest(c.env, project.id)) { info.push('Skipped playtest — one is already queued or running; I\'ll wait for it.'); continue; }
      playtestQueued = true;
      const duration = Math.max(3, Math.min(20, Number(op.duration) || 8));
      slots.push({ type: 'playtest', duration });
      info.push(`Playtesting for ${duration}s in Studio — I'll report what I find on my next reply.`);
    } else if (type === 'quality_review') {
      // Resolved SERVER-SIDE (no plugin round-trip needed — it reads the already-
      // synced game tree + scripts) after the loop, alongside docs lookups.
      if (qualityReviewRequested) { info.push('Skipped an extra quality review — only 1 per reply.'); continue; }
      qualityReviewRequested = true;
    } else {
      const clean = sanitizeGenericOp(op);
      if (clean) slots.push(clean);
    }
  }

  // All of a reply's texture generations + docs lookups run in parallel: four
  // textures cost one image round-trip, and docs lookups can't stall the turn.
  await Promise.all([
    ...textureJobs.map(async (j) => {
      try {
        const tex = await generateTexturePixels(c.env, j.prompt, j.mode);
        if (!tex) { notes.push(`Couldn't generate a texture for "${j.prompt}" this time — using Material/Color instead.`); return; }
        const texId = await storeTexturePixels(c.env, project.user_id, tex);
        j.done = { type: 'apply_texture', path: j.path, mode: j.mode, ...(j.face ? { face: j.face } : {}), texId, w: tex.width, h: tex.height, studsPerTile: j.studsPerTile };
      } catch {
        notes.push(`Texture generation for "${j.prompt}" hit an error — using Material/Color instead.`);
      }
    }),
    ...docsQueries.map(async (query) => {
      try {
        const { text, hit } = await lookupRobloxDocs(c.env, query);
        if (hit) {
          await addRobloxMessage(c.env, { project_id: project.id, role: 'assistant', content: `📚 Checked the Roblox docs for "${query}":\n\n${text}` });
          info.push(`Looked up the Roblox docs for "${query}" — I'll use that on my next reply.`);
        } else {
          info.push(`Checked the Roblox docs for "${query}" but found nothing specific there — going with my best knowledge.`);
        }
      } catch {
        notes.push(`Doc lookup for "${query}" failed — continuing with my best knowledge.`);
      }
    }),
    ...(qualityReviewRequested ? [(async () => {
      try {
        const text = await runQualityReview(c.env, project);
        await addRobloxMessage(c.env, { project_id: project.id, role: 'assistant', content: `📊 Quality Report:\n\n${text}` });
        info.push('Ran a quality review — I\'ll factor it into my next reply.');
      } catch {
        notes.push('Quality review failed — continuing without it.');
      }
    })()] : []),
  ]);

  const queued = slots
    .map((s) => ('__tex' in s ? (s as TextureJob).done ?? null : (s as Record<string, unknown>)))
    .filter((s): s is Record<string, unknown> => !!s);
  return { queued, notes, info, pending };
}

// Generate one texture image and decode it to raw RGBA pixels ≤256x256 — the only
// form Roblox Studio can ingest without publishing an asset (EditableImage). "surface"
// asks the image model for a seamless tileable material; "decal" for a single flat
// full-bleed graphic (a sign/poster shouldn't tile). Returns null on any failure —
// callers treat that as "no texture this time", never an error.
async function generateTexturePixels(env: Env, desc: string, mode: 'surface' | 'decal'): Promise<TexturePixels | null> {
  const style = mode === 'decal'
    ? 'a single flat full-bleed graphic, straight-on, no perspective, no border, no watermark'
    : 'seamless tileable material texture, flat even lighting, no shadows, top-down orthographic, no watermark';
  // 512x512 quarters decode cost vs the 1024 default; it downscales to 256 anyway.
  const url = await generateImage(env, `${style}: ${desc}`, { width: 512, height: 512 });
  if (!url) return null;
  const bytes = await glbBytesFromResult(url); // generic data:/https -> bytes helper
  if (!bytes) return null;
  const decoded = await decodePng(bytes);
  if (!decoded) return null;
  const small = downscaleRgba(decoded, 256);
  return { width: small.width, height: small.height, rgba: small.rgba };
}

// Turn map roles that matched no pinned asset into Studio-side marketplace searches
// (find_model ops): the plugin's InsertService search finds the best free model,
// virus-scans it, and drops it at the exact spot the map spec wanted. Capped at 12
// placements per build so a huge map can't trigger an insert storm.
function findModelOpsForRoles(roles: UnresolvedRole[], info: string[]): Record<string, unknown>[] {
  const ops: Record<string, unknown>[] = [];
  const searched: string[] = [];
  let budget = 12;
  for (const u of roles) {
    if (budget <= 0) break;
    const copies = Math.min(Math.max(1, u.count), 6);
    let placed = 0;
    for (let i = 0; i < copies && budget > 0; i++, budget--, placed++) {
      const position = copies > 1 ? [u.position[0] + i * 12, u.position[1], u.position[2]] : u.position;
      ops.push({ type: 'find_model', query: u.role, name: '', position, rotation: u.rotation, scale: u.scale, tagAsMap: true });
    }
    if (placed > 0) searched.push(u.role);
  }
  if (searched.length) info.push(`Searching the Roblox marketplace in Studio for: ${searched.slice(0, 8).join(', ')} — each match is virus-scanned and placed automatically on the next sync.`);
  return ops;
}

// 3D-generate a mesh and place it. PRIMARY path: parse the .glb geometry and queue a
// create_mesh op so the plugin builds a MeshPart LOCALLY (EditableMesh) — no publish,
// no key. FALLBACK: if the geometry can't be imported (Draco-compressed / too large)
// and a Marketplace Key is connected, upload it as an asset and insert by id. Runs
// detached (3D gen is slow) so the chat turn stays responsive.
async function generateAndPlaceMesh(env: Env, project: RobloxProjectRow, prompt: string, op: any, apiKey: string | null, creator: RobloxCreator | null): Promise<void> {
  // On any dead end, say so in the chat — a silently-vanishing model reads as "the
  // AI can't make models" when the real story is a failed generation or import.
  const tellUser = async (msg: string) => {
    try { await addRobloxMessage(env, { project_id: project.id, role: 'assistant', content: msg }); } catch { /* best-effort */ }
  };
  try {
    // An optional "texture" description generates a real texture alongside the
    // geometry (in parallel — no extra latency) so the mesh comes out textured, not
    // flat-colored. Best-effort: a failed/unconfigured texture never blocks the mesh.
    const textureDesc = typeof op.texture === 'string' ? op.texture.trim().slice(0, 200) : '';
    const [res, tex] = await Promise.all([
      generate3dModel(env, prompt),
      textureDesc && hasTextureGen(env)
        ? generateTexturePixels(env, textureDesc, 'surface').catch(() => null)
        : Promise.resolve(null),
    ]);
    if (!res) {
      await tellUser(`⚠ 3D generation for "${prompt}" failed this time — ask me to try again, or I can sculpt it from parts instead.`);
      return;
    }
    const position = Array.isArray(op.position) && op.position.length === 3 ? op.position.map((n: any) => Number(n) || 0) : [0, 5, 0];
    const scale = Number(op.scale) || 1;
    // "/" would break the instance path the texture follow-up op targets below.
    const name = prompt.replace(/[/\n\r]+/g, ' ').trim().slice(0, 60) || 'Generated model';
    const texId = tex ? await storeTexturePixels(env, project.user_id, tex) : null;

    const bytes = await glbBytesFromResult(res);
    const mesh = bytes ? parseGlbMesh(bytes) : null;
    if (mesh) {
      await queueRobloxOps(env, project.id, [{
        type: 'create_mesh', name, verts: mesh.verts, tris: mesh.tris, position, scale,
        color: typeof op.color === 'string' ? op.color : '#b7b0a4',
        ...(texId && tex ? { texId, texW: tex.width, texH: tex.height } : {}),
      }]);
      await logUsage(env, { user_id: project.user_id, kind: 'roblox_mesh_local' });
      return;
    }
    // Couldn't import the geometry locally — upload it (needs a key) as a fallback.
    if (apiKey && creator) {
      const assetId = await uploadRobloxModelAsset(apiKey, creator, res, prompt.slice(0, 50), `AI-generated for Yield: ${prompt}`.slice(0, 1000));
      if (!assetId) {
        await tellUser(`⚠ I generated "${prompt}" but couldn't import it into Studio or publish it to your account — ask me to try again.`);
        return;
      }
      await addRobloxAsset(env, project.id, assetId, prompt.slice(0, 80), 'ai-generated');
      const followUps: Record<string, unknown>[] = [{ type: 'insert_model', assetId, name, position, rotation: [0, 0, 0], scale }];
      // Don't silently drop an already-generated texture just because the mesh took
      // the upload path — texture the inserted model right after it lands.
      if (texId && tex) followUps.push({ type: 'apply_texture', path: `Workspace/${name}`, mode: 'surface', texId, w: tex.width, h: tex.height, studsPerTile: 8 });
      await queueRobloxOps(env, project.id, followUps);
      await logUsage(env, { user_id: project.user_id, kind: 'roblox_model3d_agent' });
      return;
    }
    await tellUser(`⚠ I generated "${prompt}" but its geometry couldn't be imported directly into Studio. Connect a Marketplace Key (Tools → Marketplace Key) and I can publish it to your account instead — or ask me to sculpt it from parts.`);
  } catch (e) {
    console.error('generateAndPlaceMesh failed:', e);
    await tellUser(`⚠ 3D generation for "${prompt}" hit an error — ask me to try again.`);
  }
}

// --- Quality Review: structural critique vs. researched top-game patterns -----------
// NOT a visual/screenshot comparison — Roblox has no API for that and Studio plugins
// can't capture the viewport. Every signal below is deterministic (counted from the
// pushed instance tree + script source), and the rubric it's judged against
// (ROBLOX_QUALITY_SYSTEM) is grounded in cited Roblox docs / DevForum / developer-
// community sources, not invented. See docs/DEPLOY.md-adjacent research notes in the
// prompt file for citations.
const DEFAULT_NAME_RE = /^(Part|Union|Model|MeshPart|Folder|Script|LocalScript|ModuleScript|SpawnLocation)\d*$/;
const POLISH_LIGHTING_CLASSES = new Set(['Atmosphere', 'ColorCorrectionEffect', 'BloomEffect', 'SunRaysEffect', 'DepthOfFieldEffect']);
const POLISH_UI_CLASSES = new Set(['UICorner', 'UIStroke', 'UIGradient', 'UIListLayout', 'UIGridLayout', 'UIPadding']);
const SCENERY_CLASSES = new Set(['Part', 'MeshPart', 'Model', 'UnionOperation', 'WedgePart', 'CornerWedgePart']);

function computeQualitySignals(tree: GameTreeNode[] | null, files: { path: string; class_name: string; source: string }[]): string {
  const lines: string[] = [];
  const t = tree || [];
  lines.push(`Total instances seen: ${t.length}${t.length === 0 ? ' (no snapshot yet — plugin hasn\'t synced; ask the user to Sync Now in Studio first)' : ''}`);

  const sceneryCount = t.filter((n) => SCENERY_CLASSES.has(n.className)).length;
  lines.push(`Scenery instances (Part/MeshPart/Model/Union/Wedge) under the place: ${sceneryCount}`);

  const defaultNamed = t.filter((n) => DEFAULT_NAME_RE.test(n.path.split('/').pop() || ''));
  lines.push(`Instances still using a default/generic name (Part1, Union, unrenamed Script, ...): ${defaultNamed.length}${defaultNamed.length ? ' — e.g. ' + defaultNamed.slice(0, 5).map((n) => n.path).join(', ') : ''}`);

  const lightingPolish = t.filter((n) => POLISH_LIGHTING_CLASSES.has(n.className)).map((n) => n.className);
  lines.push(lightingPolish.length ? `Lighting/post-processing instances present: ${[...new Set(lightingPolish)].join(', ')}` : 'Lighting/post-processing instances present: NONE (Atmosphere/ColorCorrectionEffect/BloomEffect/SunRaysEffect — a fresh place has none of these by default; their absence is normal but their presence signals deliberate atmosphere work)');

  const uiPolish = t.filter((n) => POLISH_UI_CLASSES.has(n.className)).map((n) => n.className);
  const uiCounts: Record<string, number> = {};
  for (const c of uiPolish) uiCounts[c] = (uiCounts[c] || 0) + 1;
  lines.push(Object.keys(uiCounts).length ? `UI polish instances: ${Object.entries(uiCounts).map(([k, v]) => `${k}×${v}`).join(', ')}` : 'UI polish instances (UICorner/UIStroke/UIGradient/UIListLayout/UIGridLayout): NONE found');

  const surfaceAppearanceCount = t.filter((n) => n.className === 'SurfaceAppearance').length;
  if (surfaceAppearanceCount) lines.push(`AI-generated PBR textures (SurfaceAppearance) applied: ${surfaceAppearanceCount}`);

  // Reported raw, not pre-judged here — a fresh Studio baseplate template is Grass/
  // dark-green OR Plastic/gray depending which template was used, so "is this still
  // default" is a judgment call better left to the model (which knows both looks)
  // than to a brittle regex on hex codes.
  const baseplate = t.find((n) => (n.path.split('/').pop() || '').toLowerCase() === 'baseplate');
  if (baseplate?.props) {
    const p = baseplate.props as any;
    lines.push(`Baseplate: material=${p.material || 'unknown'} color=${p.color || 'unknown'} (judge yourself whether this still looks like an untouched Studio default)`);
  }

  const src = files.map((f) => f.source).join('\n');
  const has = (re: RegExp) => re.test(src);
  const scriptSignals: string[] = [];
  scriptSignals.push(has(/leaderstats/i) ? 'leaderstats folder referenced (progression/currency display)' : 'no "leaderstats" reference found (no visible progression/currency display)');
  scriptSignals.push(has(/DataStoreService/) ? 'DataStoreService used (persistent progression)' : 'no DataStoreService usage found (progress likely does not persist between sessions)');
  scriptSignals.push(has(/RemoteEvent|RemoteFunction/) ? 'RemoteEvents/RemoteFunctions present (client-server interaction)' : 'no RemoteEvents/RemoteFunctions found (little or no client-server interaction)');
  scriptSignals.push(has(/SourceSans/) ? 'legacy SourceSans font referenced (consider Builder Sans / a custom FontFace)' : '');
  scriptSignals.push(has(/--\s*(TODO|rest of|implement this)/i) ? 'placeholder/TODO markers found in script source (incomplete work)' : '');
  lines.push(...scriptSignals.filter(Boolean).map((s) => `Script signal: ${s}`));
  lines.push(`Scripts: ${files.length} total, ${Math.round(src.length / Math.max(1, files.length))} avg chars`);

  return lines.join('\n');
}

// Enforced in CODE, not just prompted — a model under its own word-count budget can
// (and sometimes will) drop a merely-instructed disclaimer to fit more score content.
const QUALITY_REVIEW_DISCLAIMER = 'Heads up: this is a structural/technical read of your instance tree and scripts, not a real visual comparison to actual top-charting games — Roblox has no API for that and Studio plugins can\'t capture the viewport.\n\n';

async function runQualityReview(env: Env, project: RobloxProjectRow): Promise<string> {
  const [treePayload, files] = await Promise.all([getGameTree(env, project.id), listRobloxFiles(env, project.id)]);
  const signals = computeQualitySignals(treePayload?.tree ?? null, files);
  const treeText = formatGameTreeForPrompt(treePayload, 150);

  const model = resolveModel('glm-5.1');
  const chain = endpointsFor(env, model);
  let lastErr: unknown = null;
  for (const ep of chain) {
    try {
      const { text } = await chat({
        baseUrl: ep.baseUrl, apiKey: ep.apiKey, apiKeyBackup: ep.apiKeyBackup, model: ep.modelId,
        messages: [
          { role: 'system', content: ROBLOX_QUALITY_SYSTEM },
          { role: 'user', content: `STRUCTURAL SIGNALS:\n${signals}\n\n${treeText || 'No game tree available yet.'}` },
        ],
        temperature: 0.4, max_tokens: 1200, timeoutMs: 30000,
      });
      if (text.trim()) return QUALITY_REVIEW_DISCLAIMER + text.trim();
    } catch (e) { lastErr = e; }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Quality review failed');
}

async function qualityReview(req: Request, c: Ctx, project: RobloxProjectRow): Promise<Response> {
  let text: string;
  try {
    text = await runQualityReview(c.env, project);
  } catch (e: any) {
    return error(502, String(e?.message || e).slice(0, 300));
  }
  // The critique itself succeeded — a failure persisting/logging it is a lesser,
  // separate problem and must not discard a result the caller already has in hand.
  try {
    await addRobloxMessage(c.env, { project_id: project.id, role: 'assistant', content: `📊 Quality Report:\n\n${text}` });
    await logUsage(c.env, { user_id: c.user?.id ?? null, kind: 'roblox_quality_review' });
  } catch (e) { console.error('quality review persistence failed:', e); }
  return json({ ok: true, text });
}

// Manual "Playtest Now" button — queues the same op the AI can emit itself. Results
// land via the plugin's ack (see handlePluginApi) as a chat message + activity entry.
// A pending playtest already queued means the plugin either hasn't synced yet (so a
// second one would just double up once it does) or is mid-Run right now (a second
// one would collide with RunService:IsRunning()'s guard and error immediately) —
// either way, queuing another is never useful. Small pending-list scan, not a new
// query shape: playtest is a rare, deliberate action, not a hot path.
async function hasPendingPlaytest(env: Env, projectId: string): Promise<boolean> {
  const { results } = await listPendingRobloxOps(env, projectId, 100);
  return results.some((r) => { try { return JSON.parse(r.op)?.type === 'playtest'; } catch { return false; } });
}

async function webPlaytest(c: Ctx, project: RobloxProjectRow): Promise<Response> {
  if (!project.place_id || !project.last_seen_at) {
    return error(409, 'Studio hasn\'t synced this project yet — open the place in Studio and sync at least once, then try Playtest again.', { code: 'not_synced' });
  }
  if (await hasPendingPlaytest(c.env, project.id)) {
    return error(409, 'A playtest is already queued or running — wait for it to finish before starting another.', { code: 'playtest_pending' });
  }
  await queueRobloxOps(c.env, project.id, [{ type: 'playtest', duration: 8 }]);
  return json({ ok: true });
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
  const { spec, unresolved, unresolvedDetail } = sanitizeMapSpec(raw, library, clear);

  await saveRobloxMap(c.env, project.id, prompt, spec);
  // Unmatched model roles become Studio-side marketplace searches (find_model ops):
  // the plugin finds the best free model, virus-scans it, and places it exactly
  // where the map spec wanted it — no key or manual pinning needed.
  const searchNotes: string[] = [];
  const searchOps = findModelOpsForRoles(unresolvedDetail, searchNotes);
  await queueRobloxOps(c.env, project.id, [{ type: 'build_map', spec }, ...searchOps]);
  await recordGeneration(c);
  await logUsage(c.env, { user_id: c.user?.id ?? null, kind: 'roblox_map' });

  return json({
    ok: true,
    partCount: spec.parts.length,
    modelCount: spec.models.length,
    clear,
    style: style || null,
    palette: palette || null,
    unresolved,
    unresolvedHelp: searchNotes[0] || null,
  });
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
  const [ra, linked, { results }] = await Promise.all([
    getRobloxAuth(c.env, userId),
    isStudioLinked(c.env, userId),
    listRobloxProjects(c.env, userId),
  ]);
  const lastSeenAt = results.reduce<number | null>((max, p) => Math.max(max ?? 0, p.last_seen_at ?? 0) || null, null);
  const linkedPlaces = results.filter((p) => p.place_id).length;
  return json({
    // TRUE link state: an active plugin token exists right now — NOT inferred from
    // project history (which stays populated after an unlink and lied to the UI).
    linked,
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
    case 'create_mesh': return String(op.name || 'mesh');
    case 'set_properties': case 'delete_instance': case 'rename_instance': case 'move_instance': return String(op.path || '');
    case 'create_instance': return `${op.className || ''} ${op.name || ''}`.trim();
    case 'build_map': return `${op.spec?.parts?.length || 0} part(s) · ${(op.spec?.props?.length || 0)} prop(s) · ${op.spec?.models?.length || 0} model(s)`;
    case 'find_model': return `marketplace: ${op.query || 'model'}`;
    case 'apply_texture': return `texture ${op.mode === 'decal' ? '(decal) ' : ''}on ${op.path || '?'}`;
    case 'playtest': return `${op.duration || 8}s playtest`;
    default: return '';
  }
}
