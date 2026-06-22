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
  extra?: Record<string, unknown>; // extra body params (e.g. reasoning_effort)
}

function headers(apiKey: string): HeadersInit {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
}

// AbortSignal that fires after `ms`, so a hung upstream can't freeze a request.
function timeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
}

// POST the request with the primary key; if it comes back rate-limited / out of quota
// (429/402) and a backup key is configured, transparently retry once with the backup.
async function postChat(url: string, body: string, signal: AbortSignal, opts: ChatOptions): Promise<Response> {
  const send = (key: string) => fetch(url, { method: 'POST', headers: headers(key), signal, body });
  let res = await send(opts.apiKey);
  if ((res.status === 429 || res.status === 402) && opts.apiKeyBackup && opts.apiKeyBackup !== opts.apiKey) {
    res = await send(opts.apiKeyBackup);
  }
  return res;
}

/** Non-streaming completion. Returns the full assistant text + token usage. */
export async function chat(opts: ChatOptions): Promise<{ text: string; usage: { in: number; out: number } }> {
  const to = timeout(opts.timeoutMs ?? 30000);
  try {
    const body = JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.4,
      top_p: opts.top_p ?? 0.9,
      ...(opts.max_tokens ? { max_tokens: opts.max_tokens } : {}), // omit = no cap
      stream: false,
      ...(opts.extra || {}),
    });
    const res = await postChat(`${opts.baseUrl}/chat/completions`, body, to.signal, opts);
    if (!res.ok) {
      const body = await res.text();
      throw new NvidiaError(res.status, body);
    }
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
  const body = JSON.stringify({
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.4,
    top_p: opts.top_p ?? 0.9,
    ...(opts.max_tokens ? { max_tokens: opts.max_tokens } : {}), // omit = no cap
    stream: true,
    ...(opts.extra || {}),
  });
  const res = await postChat(`${opts.baseUrl}/chat/completions`, body, to.signal, opts);
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
