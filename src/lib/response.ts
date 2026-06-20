// Small HTTP helpers: JSON, SSE, cookies, ids, hashing.

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

export function error(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: message, ...extra }, { status });
}

export function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...headers } });
}

// --- Server-Sent Events: a writer that streams tokens to the browser ----------
export function sse(): { response: Response; send: (event: string, data: unknown) => Promise<void>; close: () => Promise<void> } {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = async (event: string, data: unknown) => {
    await writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };
  const close = async () => {
    try { await writer.close(); } catch { /* already closed */ }
  };
  const response = new Response(readable, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  });
  return { response, send, close };
}

// --- Cookies ------------------------------------------------------------------
export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get('cookie') || '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, opts: { maxAge?: number; httpOnly?: boolean; path?: string } = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? '/'}`);
  parts.push('SameSite=Lax');
  parts.push('Secure');
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

// --- ids + crypto -------------------------------------------------------------
export function newId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

const enc = new TextEncoder();

export async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time-ish compare for signatures.
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
