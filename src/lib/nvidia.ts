// NVIDIA inference client (OpenAI-compatible chat completions).
// Base: https://integrate.api.nvidia.com/v1  — auth: Bearer nvapi-...

import type { Env } from '../types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model: string; // NVIDIA model id
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
}

function headers(env: Env): HeadersInit {
  return {
    authorization: `Bearer ${env.NVIDIA_API_KEY}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
}

/** Non-streaming completion. Returns the full assistant text + token usage. */
export async function chat(env: Env, opts: ChatOptions): Promise<{ text: string; usage: { in: number; out: number } }> {
  const res = await fetch(`${env.NVIDIA_CHAT_BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.4,
      top_p: opts.top_p ?? 0.9,
      max_tokens: opts.max_tokens ?? 8192,
      stream: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new NvidiaError(res.status, body);
  }
  const data: any = await res.json();
  return {
    text: data?.choices?.[0]?.message?.content ?? '',
    usage: { in: data?.usage?.prompt_tokens ?? 0, out: data?.usage?.completion_tokens ?? 0 },
  };
}

/**
 * Streaming completion. Invokes `onDelta` for each text chunk and resolves with
 * the full text once the stream closes.
 */
export async function chatStream(
  env: Env,
  opts: ChatOptions,
  onDelta: (delta: string) => void | Promise<void>,
): Promise<{ text: string }> {
  const res = await fetch(`${env.NVIDIA_CHAT_BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.4,
      top_p: opts.top_p ?? 0.9,
      max_tokens: opts.max_tokens ?? 8192,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new NvidiaError(res.status, body);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let full = '';
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
        const delta = parsed?.choices?.[0]?.delta?.content ?? '';
        if (delta) {
          full += delta;
          await onDelta(delta);
        }
      } catch {
        /* partial JSON across chunks — ignore, it'll complete next read */
      }
    }
  }
  return { text: full };
}

export class NvidiaError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`NVIDIA API ${status}: ${body.slice(0, 500)}`);
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
