// Models list + status/health endpoints.
//   GET /api/models   -> picker models (+ auto)
//   GET /api/status   -> high-usage state, plan, remaining quota
//   GET /api/health   -> platform + per-AI + usage/rate health (for /status)

import type { Ctx } from '../types';
import { json } from '../lib/response';
import { activeCoderModels, ROUTER_MODEL, endpointFor, pickerModels, visionEndpoint } from '../config/models';
import { workersAiConfigured, workersAiChat } from '../lib/workersai';
import { getUsageState, usageSnapshot } from '../lib/usage';
import { enabledProviders } from '../lib/auth';
import { chat } from '../lib/nvidia';
import { checkPrompt } from '../lib/jailbreak';

export function handleModels(c: Ctx): Response {
  return json({ models: pickerModels(c.env) });
}

export async function handleStatus(c: Ctx): Promise<Response> {
  const snap = await usageSnapshot(c);
  return json({
    app: c.env.APP_NAME,
    user: c.user,
    authEnabled: c.env.AUTH_ENABLED !== 'false',
    providers: enabledProviders(c.env),
    donateUrl: c.env.DONATE_URL || '',
    ...snap,
  });
}

const trim = (e: any) => String(e?.message || e).slice(0, 160);

// Map a probe error to a status the UI can colour — no provider/brand names.
function classifyProbe(e: any): string {
  const status = e?.status as number | undefined;
  if (e?.name === 'AbortError' || /abort|timed out/i.test(trim(e))) return 'slow';
  if (status === 401 || status === 403) return 'auth';      // key missing/invalid
  if (status === 429) return 'rate_limited';                // out of rate budget
  if (status === 402) return 'rate_limited';                // credits/payment required
  if (status === 404) return 'unavailable';                 // model id not found
  if (status === 410) return 'unavailable';                 // model deprecated/removed upstream
  if (status && status >= 500) return 'degraded';
  return 'down';
}

interface ModelHealth { id: string; label: string; status: string; latencyMs: number; group: 'coder' | 'utility' }

// Probe one chat-completions AI with a tiny 1-token request.
async function probeChat(id: string, label: string, group: 'coder' | 'utility', ep: { baseUrl: string; apiKey: string; apiKeyBackup?: string; modelId: string }): Promise<ModelHealth> {
  const t0 = Date.now();
  try {
    await chat({
      baseUrl: ep.baseUrl, apiKey: ep.apiKey, apiKeyBackup: ep.apiKeyBackup, model: ep.modelId,
      messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, temperature: 0, timeoutMs: 8000,
    });
    return { id, label, status: 'operational', latencyMs: Date.now() - t0, group };
  } catch (e: any) {
    return { id, label, status: classifyProbe(e), latencyMs: Date.now() - t0, group };
  }
}

// Probe EVERY AI the platform uses — the coder models plus the utility AIs (the Auto
// router, the image-understanding vision model, and the jailbreak guard) — so the status
// page shows all of them. Cached in the edge Cache API for 5 min (NOT KV) so repeated
// /status views don't re-probe — at most one probe-set per 5 minutes.
async function probeModels(c: Ctx): Promise<ModelHealth[]> {
  const cache = caches.default;
  const cacheKey = new Request('https://yield.internal/__health_models');
  try {
    const hit = await cache.match(cacheKey);
    if (hit) return await hit.json();
  } catch { /* probe fresh */ }

  // Probe every offered coder — including the in-house Yield AI when it's configured.
  // Yield AI on the Cloudflare Workers AI backend has no HTTP endpoint, so probe it via
  // the AI binding instead of a chat-completions URL.
  const probeYieldAiWA = async (): Promise<ModelHealth> => {
    const t0 = Date.now();
    try {
      await workersAiChat(c.env, [{ role: 'user', content: 'ping' }], { max_tokens: 1, temperature: 0 });
      return { id: 'yield-ai', label: 'Yield AI 1.1', status: 'operational', latencyMs: Date.now() - t0, group: 'coder' };
    } catch (e: any) {
      return { id: 'yield-ai', label: 'Yield AI 1.1', status: classifyProbe(e), latencyMs: Date.now() - t0, group: 'coder' };
    }
  };
  const coders = activeCoderModels(c.env).map((m) =>
    m.id === 'yield-ai' && workersAiConfigured(c.env)
      ? probeYieldAiWA()
      : probeChat(m.id, m.label, 'coder', endpointFor(c.env, m)),
  );

  // Utility AIs: the Auto router + the vision (image-understanding) model share the chat
  // probe; the jailbreak guard has its own classify API, so probe it via checkPrompt.
  const router = probeChat(ROUTER_MODEL.id, 'Auto router', 'utility', endpointFor(c.env, ROUTER_MODEL));
  const vision = probeChat('vision', 'Vision · image understanding', 'utility', visionEndpoint(c.env));
  const guard = (async (): Promise<ModelHealth> => {
    const t0 = Date.now();
    try {
      const r = await checkPrompt(c.env, 'hello');
      const status = r.source === 'nemoguard' ? 'operational' : r.source === 'unavailable' ? 'unavailable' : 'operational';
      return { id: 'nemoguard', label: 'Jailbreak guard', status, latencyMs: Date.now() - t0, group: 'utility' };
    } catch (e: any) {
      return { id: 'nemoguard', label: 'Jailbreak guard', status: classifyProbe(e), latencyMs: Date.now() - t0, group: 'utility' };
    }
  })();

  const results = await Promise.all([...coders, router, vision, guard]);

  try {
    await cache.put(cacheKey, new Response(JSON.stringify(results), {
      headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' },
    }));
  } catch { /* caching is best-effort */ }
  return results;
}

// Full health snapshot for the public /status page: platform services (named by
// function, not vendor), each AI individually, and usage/rate ("high usage") state.
export async function handleHealth(c: Ctx): Promise<Response> {
  const platform: Record<string, string> = {
    api: 'ok',
    database: 'unknown',
    storage: 'unknown',
    buildEngine: c.env.BUILDER ? 'ok' : 'unconfigured',
  };
  try { await c.env.DB.prepare('SELECT 1 AS x').first(); platform.database = 'ok'; }
  catch (e: any) { platform.database = 'error: ' + trim(e); }
  try { await c.env.KV.get('__health'); platform.storage = 'ok'; }
  catch (e: any) { platform.storage = 'error: ' + trim(e); }

  const usage = await getUsageState(c.env).catch(() => null);
  const models = await probeModels(c).catch(() => [] as ModelHealth[]);

  const platformOk = platform.database === 'ok' && platform.storage === 'ok';
  const aisUp = models.filter((m) => m.status === 'operational').length;
  // Healthy if the platform is up and at least one AI works (the builder reroutes
  // around any single failing model, so the app is usable).
  const ok = platformOk && (models.length === 0 || aisUp > 0);

  return json({
    ok,
    time: new Date().toISOString(),
    app: c.env.APP_NAME,
    authEnabled: c.env.AUTH_ENABLED !== 'false',
    platform,
    ais: { up: aisUp, total: models.length, models },
    usage: usage
      ? {
          highUsage: usage.highUsage,
          source: usage.source,
          monthlyUsedPct: Math.min(100, Math.round((usage.monthlyCount / usage.budget) * 100)),
        }
      : null,
  });
}
