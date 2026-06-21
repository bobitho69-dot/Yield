// Models list + status/health endpoints.
//   GET /api/models   -> picker models (+ auto)
//   GET /api/status   -> high-usage state, plan, remaining quota
//   GET /api/health   -> platform + per-AI + usage/rate health (for /status)

import type { Ctx } from '../types';
import { json } from '../lib/response';
import { CODER_MODELS, endpointFor, pickerModels } from '../config/models';
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

const trim = (e: any) => String(e?.message || e).slice(0, 160);

// Map a probe error to a status the UI can colour — no provider/brand names.
function classifyProbe(e: any): string {
  const status = e?.status as number | undefined;
  if (e?.name === 'AbortError' || /abort|timed out/i.test(trim(e))) return 'slow';
  if (status === 401 || status === 403) return 'auth';      // key missing/invalid
  if (status === 429) return 'rate_limited';                // out of rate budget
  if (status === 402) return 'rate_limited';                // credits/payment required
  if (status === 404) return 'unavailable';                 // model id not found
  if (status && status >= 500) return 'degraded';
  return 'down';
}

interface ModelHealth { id: string; label: string; status: string; latencyMs: number }

// Probe each AI individually with a tiny 1-token request so the status page can show
// every model on its own line. Cached in the edge Cache API for 5 min (NOT KV) so
// repeated /status views don't re-probe — at most one probe-set per 5 minutes.
async function probeModels(c: Ctx): Promise<ModelHealth[]> {
  const cache = caches.default;
  const cacheKey = new Request('https://yield.internal/__health_models');
  try {
    const hit = await cache.match(cacheKey);
    if (hit) return await hit.json();
  } catch { /* probe fresh */ }

  const results = await Promise.all(CODER_MODELS.map(async (m): Promise<ModelHealth> => {
    const ep = endpointFor(c.env, m);
    const t0 = Date.now();
    try {
      await chat({
        baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: ep.modelId,
        messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, temperature: 0, timeoutMs: 8000,
      });
      return { id: m.id, label: m.label, status: 'operational', latencyMs: Date.now() - t0 };
    } catch (e: any) {
      return { id: m.id, label: m.label, status: classifyProbe(e), latencyMs: Date.now() - t0 };
    }
  }));

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
    usage: usage ? { paused: usage.highUsage, source: usage.source, unlimited: true } : null,
  });
}
