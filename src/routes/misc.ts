// Models list + status/health endpoints.
//   GET /api/models   -> picker models (+ auto)
//   GET /api/status   -> high-usage state, plan, remaining quota
//   GET /api/health   -> platform (D1/KV/DO) + AI provider + usage/rate health (for /status)

import type { Ctx } from '../types';
import { json } from '../lib/response';
import { CODER_MODELS, endpointFor, pickerModels, type ModelDef } from '../config/models';
import { getUsageState, usageSnapshot } from '../lib/usage';
import { enabledProviders } from '../lib/auth';
import { chat } from '../lib/nvidia';

export function handleModels(): Response {
  return json({ models: pickerModels() });
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

const msg = (e: any) => String(e?.message || e).slice(0, 160);

// Friendly provider name from a base URL.
function providerName(baseUrl: string): string {
  if (/nvidia/i.test(baseUrl)) return 'NVIDIA';
  if (/openrouter/i.test(baseUrl)) return 'OpenRouter';
  if (/groq/i.test(baseUrl)) return 'Groq';
  try { return new URL(baseUrl).hostname.replace(/^api\./, ''); } catch { return baseUrl; }
}

// Map a probe error to a status the UI can colour.
function classifyProbe(e: any): string {
  const status = e?.status as number | undefined;
  if (e?.name === 'AbortError' || /abort|timed out/i.test(msg(e))) return 'slow';
  if (status === 401 || status === 403) return 'auth';      // key missing/invalid
  if (status === 429) return 'rate_limited';                // out of rate budget
  if (status === 404) return 'unavailable';                 // model id / endpoint not found
  if (status === 402) return 'rate_limited';                // credits/payment required
  if (status && status >= 500) return 'degraded';
  return 'down';
}

interface ProviderHealth { name: string; baseUrl: string; status: string; latencyMs: number; note?: string; models: string[] }

// Probe one representative (fastest) model per unique provider endpoint with a tiny
// request, so we make ~1 call per provider instead of one per model. Cached in the
// edge Cache API (not KV) for 2 min, so repeated /status views don't hammer the APIs
// or spend KV writes.
async function probeProviders(c: Ctx): Promise<ProviderHealth[]> {
  const cache = caches.default;
  const cacheKey = new Request('https://yield.internal/__health_providers');
  try {
    const hit = await cache.match(cacheKey);
    if (hit) return await hit.json();
  } catch { /* probe fresh */ }

  const groups = new Map<string, { name: string; baseUrl: string; rep: ModelDef; models: string[] }>();
  for (const m of CODER_MODELS) {
    const { baseUrl } = endpointFor(c.env, m);
    const g = groups.get(baseUrl) || { name: providerName(baseUrl), baseUrl, rep: m, models: [] };
    g.models.push(m.label);
    if (m.speed > g.rep.speed) g.rep = m; // probe the quickest model on the provider
    groups.set(baseUrl, g);
  }

  const results = await Promise.all([...groups.values()].map(async (g): Promise<ProviderHealth> => {
    const ep = endpointFor(c.env, g.rep);
    const t0 = Date.now();
    try {
      await chat({
        baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: ep.modelId,
        messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, temperature: 0, timeoutMs: 8000,
      });
      return { name: g.name, baseUrl: g.baseUrl, status: 'operational', latencyMs: Date.now() - t0, models: g.models };
    } catch (e: any) {
      return { name: g.name, baseUrl: g.baseUrl, status: classifyProbe(e), latencyMs: Date.now() - t0, note: msg(e), models: g.models };
    }
  }));

  try {
    await cache.put(cacheKey, new Response(JSON.stringify(results), {
      headers: { 'content-type': 'application/json', 'cache-control': 'max-age=120' },
    }));
  } catch { /* caching is best-effort */ }
  return results;
}

// Full health snapshot for the public /status page: platform bindings, AI providers,
// and usage/rate ("high usage time") state.
export async function handleHealth(c: Ctx): Promise<Response> {
  const platform: Record<string, string> = {
    worker: 'ok',
    db: 'unknown',
    kv: 'unknown',
    durableObjects: c.env.BUILDER ? 'ok' : 'unconfigured',
  };
  let ok = true;
  try { await c.env.DB.prepare('SELECT 1 AS x').first(); platform.db = 'ok'; }
  catch (e: any) { ok = false; platform.db = 'error: ' + msg(e); }
  try { await c.env.KV.get('__health'); platform.kv = 'ok'; }
  catch (e: any) { ok = false; platform.kv = 'error: ' + msg(e); }

  const usage = await getUsageState(c.env).catch(() => null);
  const providers = await probeProviders(c).catch(() => [] as ProviderHealth[]);
  if (providers.some((p) => p.status !== 'operational')) ok = false;

  return json({
    ok,
    time: new Date().toISOString(),
    app: c.env.APP_NAME,
    authEnabled: c.env.AUTH_ENABLED !== 'false',
    platform,
    usage: usage
      ? {
          highUsage: usage.highUsage,
          source: usage.source,
          monthlyUsedPct: Math.min(100, Math.round((usage.monthlyCount / usage.budget) * 100)),
          freeDailyLimit: parseInt(c.env.FREE_DAILY_LIMIT, 10) || 15,
          anonDailyLimit: parseInt(c.env.ANON_DAILY_LIMIT, 10) || 3,
        }
      : null,
    providers,
  });
}
