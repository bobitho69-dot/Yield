// Models list + status/health endpoints.
//   GET /api/models   -> picker models (+ auto)
//   GET /api/status   -> high-usage state, plan, remaining quota
//   GET /api/health   -> ok

import type { Ctx } from '../types';
import { json } from '../lib/response';
import { pickerModels } from '../config/models';
import { usageSnapshot } from '../lib/usage';

export function handleModels(): Response {
  return json({ models: pickerModels() });
}

export async function handleStatus(c: Ctx): Promise<Response> {
  const snap = await usageSnapshot(c);
  return json({
    app: c.env.APP_NAME,
    user: c.user,
    ...snap,
  });
}

export function handleHealth(): Response {
  return json({ ok: true });
}
