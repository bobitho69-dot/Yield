// OpenAI-compatible inference client. Each model is its own API: callers pass the
// resolved `baseUrl` + `apiKey` (from endpointFor) so different models can live on
// different endpoints/providers. Default is NVIDIA's integrate.api.nvidia.com/v1.

// A multimodal content part (OpenAI-compatible). Used for vision: a user message can
// be an array of text + image_url parts so a VLM can "see" uploaded images.
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface ChatOptions {
  baseUrl: string; // e.g. https://integrate.api.nvidia.com/v1
  apiKey: string;
  apiKeyBackup?: string; // retried on a 429/402 (rate-limit / quota) from the primary key
  model: string; // provider model id
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  timeoutMs?: number; // abort if the request takes too long
  signal?: AbortSignal; // external abort (e.g. the user stopped the build)
  extra?: Record<string, unknown>; // extra body params (e.g. reasoning_effort)
}

function headers(apiKey: string): HeadersInit {
  // Trim the key: a stray space or newline pasted into a secret (a common cause of a
  // provider 403 "access_denied", e.g. ZenMux) would otherwise be sent verbatim.
  return {
    authorization: `Bearer ${(apiKey || '').trim()}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'x-title': 'Yield',
  };
}

// AbortSignal that fires after `ms`, so a hung upstream can't freeze a request.
function timeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
}

// Combine the internal timeout signal with an optional external one (the user's "stop"),
// so the request aborts when EITHER fires.
function combineSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  if (typeof (AbortSignal as any).any === 'function') return (AbortSignal as any).any([a, b]);
  return b.aborted ? b : a; // older runtimes: at least honor an already-aborted stop
}

// POST the request with the primary key; if it comes back rate-limited / out of quota
// (429/402) and a backup key is configured, transparently retry once with the backup.
async function postChat(url: string, body: string, signal: AbortSignal, opts: ChatOptions): Promise<Response> {
  const sig = combineSignals(signal, opts.signal);
  const send = (key: string) => fetch(url, { method: 'POST', headers: headers(key), signal: sig, body });
  let res = await send(opts.apiKey);
  if ((res.status === 429 || res.status === 402) && opts.apiKeyBackup && opts.apiKeyBackup !== opts.apiKey) {
    res = await send(opts.apiKeyBackup);
  }
  return res;
}

// NVIDIA's endpoint is our "home" provider; everything else (ZenMux, OpenRouter) is foreign
// and may reject NVIDIA/OpenAI-only params. Detected by host so the client stays env-free.
function isForeign(baseUrl: string): boolean {
  return !/integrate\.api\.nvidia\.com/i.test(baseUrl || '');
}
// Build the JSON request body. Drops `reasoning_effort` for foreign providers (an
// NVIDIA/OpenAI-only param that others 400 on), and lets a 400-retry swap the token
// parameter name or shrink the cap.
function buildBody(opts: ChatOptions, stream: boolean, over: { tokenParam?: string; maxTokens?: number }): string {
  const extra: Record<string, unknown> = { ...(opts.extra || {}) };
  if (isForeign(opts.baseUrl) && 'reasoning_effort' in extra) delete extra.reasoning_effort;
  const tokenParam = over.tokenParam || 'max_tokens';
  const maxTok = over.maxTokens ?? opts.max_tokens;
  return JSON.stringify({
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.4,
    top_p: opts.top_p ?? 0.9,
    ...(maxTok ? { [tokenParam]: maxTok } : {}), // omit = no cap
    stream,
    ...extra,
  });
}
// Inspect a 400 body: if it's a known token-parameter problem, return how to retry.
// - some models want `max_completion_tokens` instead of `max_tokens`
// - free/foreign models often cap output below our default → retry with a safe 8192
function tokenRetry(body: string, curMax?: number): { tokenParam?: string; maxTokens?: number } | null {
  if (/max_completion_tokens/i.test(body)) return { tokenParam: 'max_completion_tokens', maxTokens: curMax };
  if ((curMax ?? 0) > 8192 && /max_?tokens|maximum.*tokens?|tokens?.*(limit|exceed|maximum|greater|too\s+large)/i.test(body)) {
    return { maxTokens: 8192 };
  }
  return null;
}

/** Non-streaming completion. Returns the full assistant text + token usage. */
export async function chat(opts: ChatOptions): Promise<{ text: string; usage: { in: number; out: number } }> {
  const to = timeout(opts.timeoutMs ?? 30000);
  const url = `${opts.baseUrl}/chat/completions`;
  try {
    let res = await postChat(url, buildBody(opts, false, {}), to.signal, opts);
    if (res.status === 400) { // auto-correct a token-param 400 (free/foreign models); else surface it
      const b = await res.text().catch(() => '');
      const retry = tokenRetry(b, opts.max_tokens);
      if (retry) res = await postChat(url, buildBody(opts, false, retry), to.signal, opts);
      else throw new NvidiaError(400, b);
    }
    if (!res.ok) throw new NvidiaError(res.status, await res.text().catch(() => ''));
    const data: any = await res.json();
    const msg = data?.choices?.[0]?.message ?? {};
    return {
      // Reasoning models sometimes leave `content` empty and put text in
      // `reasoning_content`; fall back to it so the caller still gets an answer.
      text: msg.content || msg.reasoning_content || '',
      usage: { in: data?.usage?.prompt_tokens ?? 0, out: data?.usage?.completion_tokens ?? 0 },
    };
  } finally {
    to.clear();
  }
}

/**
 * Streaming completion. Invokes `onDelta` for each text chunk and resolves with
 * the full text once the stream closes.
 */
export async function chatStream(
  opts: ChatOptions,
  onDelta: (delta: string) => void | Promise<void>,
  onReasoning?: (r: string) => void | Promise<void>,
): Promise<{ text: string }> {
  const to = timeout(opts.timeoutMs ?? 90000);
  const url = `${opts.baseUrl}/chat/completions`;
  let res = await postChat(url, buildBody(opts, true, {}), to.signal, opts);
  if (res.status === 400) { // auto-correct a token-param 400 (free/foreign models); else surface it
    const b = await res.text().catch(() => '');
    const retry = tokenRetry(b, opts.max_tokens);
    if (retry) res = await postChat(url, buildBody(opts, true, retry), to.signal, opts);
    else { to.clear(); throw new NvidiaError(400, b); }
  }
  if (!res.ok || !res.body) {
    to.clear();
    const body = await res.text().catch(() => '');
    throw new NvidiaError(res.status, body);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let full = '';
  // Parse one SSE "data:" line. Returns false on a JSON error so the caller can
  // decide whether the line is incomplete (mid-stream) or just final junk.
  const handleLine = async (raw: string): Promise<void> => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const parsed = JSON.parse(payload);
      const d = parsed?.choices?.[0]?.delta ?? {};
      const reasoning = d.reasoning_content ?? d.reasoning ?? '';
      if (reasoning && onReasoning) await onReasoning(reasoning);
      const delta = d.content ?? '';
      if (delta) { full += delta; await onDelta(delta); }
    } catch {
      /* partial JSON across chunks — ignore, it'll complete next read */
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      // Lines are separated by \n; process every complete line.
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        await handleLine(line);
      }
    }
    // Flush any trailing line the stream ended on without a newline — otherwise
    // the model's last token(s) (e.g. a closing </html>) would be silently lost.
    if (buffer.trim()) await handleLine(buffer);
  } finally {
    to.clear();
  }
  return { text: full };
}

export class NvidiaError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`Model API ${status}: ${body.slice(0, 500)}`);
    this.status = status;
  }
}

// Strip accidental ```html fences / prose so we always store a clean document.
export function extractHtml(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.search(/<!DOCTYPE html>|<html[\s>]/i);
  if (start > 0) t = t.slice(start);
  return t.trim();
}
