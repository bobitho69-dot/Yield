// AI image generation proxy. The generated app calls window.YIELD.image(), which
// hits this endpoint; Yield forwards to the configured provider (keeping the key
// server-side) and returns an image URL / data URL.
//   POST /api/media/image  { prompt, ...opts } -> { url, raw }

import type { Ctx, Env } from '../types';
import { json } from '../lib/response';
import { gateGeneration, recordGeneration } from '../lib/usage';
import { logUsage } from '../lib/db';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};
const j = (data: unknown, status = 200) => json(data, { status, headers: CORS });

function b64ToDataUrl(b64: string): string {
  const mime = b64.startsWith('/9j/') ? 'image/jpeg' : b64.startsWith('iVBOR') ? 'image/png' : b64.startsWith('UklGR') ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${b64}`;
}

// Pull a media URL (or data URL) out of whatever shape the provider returns.
function extractUrl(d: any): string | null {
  if (typeof d?.image === 'string' && d.image.startsWith('data:')) return d.image;
  if (typeof d?.url === 'string') return d.url;
  const b64 = d?.artifacts?.[0]?.base64 || d?.data?.[0]?.b64_json || d?.image_base64 || (typeof d?.image === 'string' && !d.image.startsWith('http') ? d.image : null);
  if (b64) return b64ToDataUrl(b64);
  return (
    d?.image_url || d?.data?.[0]?.url ||
    d?.images?.[0]?.url || (typeof d?.images?.[0] === 'string' ? d.images[0] : null) ||
    (typeof d?.output?.[0] === 'string' ? d.output[0] : null) || (typeof d?.output === 'string' ? d.output : null) ||
    d?.result?.url || d?.artifacts?.[0]?.url || null
  );
}

// Generate one image from a prompt via the configured provider (FLUX on NVIDIA by
// default). Returns a URL / data URL, or null if unconfigured or it fails. Used both
// by the public /api/media/image endpoint and by the builder (to show illustrations
// in chat). Best-effort: never throws.
export async function generateImage(env: Env, prompt: string, opts: Record<string, any> = {}): Promise<string | null> {
  const url = env.IMAGE_API_URL;
  const key = env.IMAGE_API_KEY || env.NVIDIA_API_KEY; // FLUX on NVIDIA reuses the nvapi key
  if (!url || !key || !prompt) return null;
  const defaults = { mode: 'base', cfg_scale: 3.5, width: 1024, height: 1024, seed: 0, steps: 4 };
  const payload = { ...defaults, ...(env.IMAGE_API_MODEL ? { model: env.IMAGE_API_MODEL } : {}), prompt, ...opts };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok) return null;
    return extractUrl(data);
  } catch {
    return null;
  }
}

export async function handleMedia(req: Request, c: Ctx): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return j({ error: 'POST only' }, 405);

  if (!c.env.IMAGE_API_URL || !(c.env.IMAGE_API_KEY || c.env.NVIDIA_API_KEY)) {
    return j({ error: `Image generation isn't configured yet.`, code: 'not_configured' }, 503);
  }

  const gate = await gateGeneration(c);
  if (!gate.allowed) return j({ error: gate.reason, code: gate.code }, gate.status);

  const body = (await req.json().catch(() => ({}))) as Record<string, any>;
  if (!body.prompt) return j({ error: 'prompt required' }, 400);
  const { prompt, ...opts } = body;
  const url = await generateImage(c.env, prompt, opts);
  if (!url) return j({ error: 'Media API error' }, 502);
  await recordGeneration(c);
  await logUsage(c.env, { user_id: c.user?.id ?? null, kind: 'media_image' });
  return j({ url });
}
