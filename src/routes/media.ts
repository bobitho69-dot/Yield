// AI image / video generation proxy. The generated app calls window.YIELD.image()
// / window.YIELD.video(), which hit these endpoints; Yield forwards to the
// configured provider (keeping the key server-side) and returns a media URL.
//   POST /api/media/image  { prompt, ...opts } -> { url, raw }
//   POST /api/media/video  { prompt, ...opts } -> { url, raw }

import type { Ctx } from '../types';
import { json } from '../lib/response';
import { gateGeneration, recordGeneration } from '../lib/usage';
import { logUsage } from '../lib/db';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};
const j = (data: unknown, status = 200) => json(data, { status, headers: CORS });

// Pull a media URL out of whatever shape the provider returns.
function extractUrl(d: any): string | null {
  return (
    d?.url || d?.image_url || d?.video_url ||
    d?.data?.[0]?.url || d?.data?.[0]?.b64_json && `data:image/png;base64,${d.data[0].b64_json}` ||
    d?.images?.[0]?.url || (typeof d?.images?.[0] === 'string' ? d.images[0] : null) ||
    (typeof d?.output?.[0] === 'string' ? d.output[0] : null) || (typeof d?.output === 'string' ? d.output : null) ||
    d?.image || d?.video || d?.result?.url || d?.artifacts?.[0]?.url || null
  );
}

export async function handleMedia(req: Request, c: Ctx, kind: 'image' | 'video'): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return j({ error: 'POST only' }, 405);

  const url = kind === 'video' ? c.env.VIDEO_API_URL : c.env.IMAGE_API_URL;
  const key = kind === 'video' ? c.env.VIDEO_API_KEY : c.env.IMAGE_API_KEY;
  const model = kind === 'video' ? c.env.VIDEO_API_MODEL : c.env.IMAGE_API_MODEL;
  if (!url || !key) return j({ error: `${kind} generation isn't configured yet.`, code: 'not_configured' }, 503);

  const gate = await gateGeneration(c);
  if (!gate.allowed) return j({ error: gate.reason, code: gate.code }, gate.status);

  const body = (await req.json().catch(() => ({}))) as Record<string, any>;
  if (!body.prompt) return j({ error: 'prompt required' }, 400);
  const payload = { ...(model ? { model } : {}), ...body };

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok) return j({ error: 'Media API error', detail: String(JSON.stringify(data)).slice(0, 300) }, 502);
    await recordGeneration(c);
    await logUsage(c.env, { user_id: c.user?.id ?? null, kind: `media_${kind}` });
    return j({ url: extractUrl(data), raw: data });
  } catch (e: any) {
    return j({ error: String(e?.message || e).slice(0, 200) }, 502);
  }
}
