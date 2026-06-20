// OpenAI-compatible inference client. Each model is its own API: callers pass the
// resolved `baseUrl` + `apiKey` (from endpointFor) so different models can live on
// different endpoints/providers. Default is NVIDIA's integrate.api.nvidia.com/v1.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  baseUrl: string; // e.g. https://integrate.api.nvidia.com/v1
  apiKey: string;
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

/** Non-streaming completion. Returns the full assistant text + token usage. */
export async function chat(opts: ChatOptions): Promise<{ text: string; usage: { in: number; out: number } }> {
  const to = timeout(opts.timeoutMs ?? 30000);
  try {
    const res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headers(opts.apiKey),
      signal: to.signal,
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.4,
        top_p: opts.top_p ?? 0.9,
        max_tokens: opts.max_tokens ?? 8192,
        stream: false,
        ...(opts.extra || {}),
      }),
    });
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
  const res = await fetch(`${opts.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(opts.apiKey),
    signal: to.signal,
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.4,
      top_p: opts.top_p ?? 0.9,
      max_tokens: opts.max_tokens ?? 8192,
      stream: true,
      ...(opts.extra || {}),
    }),
  });
  if (!res.ok || !res.body) {
    to.clear();
    const body = await res.text().catch(() => '');
    throw new NvidiaError(res.status, body);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let full = '';
  try {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    // SSE frames are separated by double newlines.
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        const d = parsed?.choices?.[0]?.delta ?? {};
        const reasoning = d.reasoning_content ?? d.reasoning ?? '';
        if (reasoning && onReasoning) await onReasoning(reasoning);
        const delta = d.content ?? '';
        if (delta) {
          full += delta;
          await onDelta(delta);
        }
      } catch {
        /* partial JSON across chunks — ignore, it'll complete next read */
      }
    }
  }
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
