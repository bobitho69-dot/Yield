// Models list + status/health endpoints.
//   GET /api/models   -> picker models (+ auto)
//   GET /api/status   -> high-usage state, plan, remaining quota
//   GET /api/health   -> ok

import type { Ctx } from '../types';
import { json } from '../lib/response';
import { pickerModels } from '../config/models';
import { usageSnapshot } from '../lib/usage';
import { enabledProviders } from '../lib/auth';

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
    ...snap,
  });
}

// Health probe that actually checks the D1 + KV bindings so we can see which one
// (if any) is misconfigured in a deployment. Hit /api/health on the live URL.
export async function handleHealth(c: Ctx): Promise<Response> {
  const out: Record<string, unknown> = {
    ok: true,
    authEnabled: c.env.AUTH_ENABLED !== 'false',
    db: 'unknown',
    kv: 'unknown',
  };
  try {
    await c.env.DB.prepare('SELECT 1 AS x').first();
    out.db = 'ok';
  } catch (e: any) {
    out.ok = false;
    out.db = 'ERROR: ' + String(e?.message || e).slice(0, 180);
  }
  try {
    await c.env.KV.get('__health');
    out.kv = 'ok';
  } catch (e: any) {
    out.ok = false;
    out.kv = 'ERROR: ' + String(e?.message || e).slice(0, 180);
  }
  return json(out);
}
