// Cloudflare Workers AI backend for the in-house Yield AI model.
//
// When YIELD_AI_BACKEND=workers-ai and the [ai] binding is present, Yield AI runs on
// Cloudflare's OWN GPUs via env.AI.run(...) — a base model (YIELD_AI_MODEL_ID) plus an
// optional uploaded LoRA (YIELD_AI_LORA). No external AI provider is involved, and it
// draws on Workers AI's free daily allowance (LoRA is free during its open beta).
//
// This is intentionally self-contained so the rest of the pipeline can branch to it with
// one guard (workersAiConfigured) and otherwise behave exactly as before.

import type { Env } from '../types';

// The default Workers AI base model if none is set. A small, fast instruct model that also
// supports LoRA adapters. Override with YIELD_AI_MODEL_ID (e.g. a Mistral/Gemma/Llama id).
const DEFAULT_WA_MODEL = '@cf/meta/llama-3.1-8b-instruct';

/** True when Yield AI should be served by Cloudflare Workers AI (backend flag + binding). */
export function workersAiConfigured(env: Env): boolean {
  return (env.YIELD_AI_BACKEND || '').trim().toLowerCase() === 'workers-ai' && !!env.AI;
}

function waModel(env: Env): string {
  return (env.YIELD_AI_MODEL_ID || '').trim() || DEFAULT_WA_MODEL;
}

// Build the env.AI.run input. Workers AI text models take OpenAI-style `messages`; a LoRA
// is applied by passing its name as `lora`.
function waInput(env: Env, messages: WAMessage[], extra: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { messages, ...extra };
  const lora = (env.YIELD_AI_LORA || '').trim();
  if (lora) input.lora = lora;
  return input;
}

export interface WAMessage { role: 'system' | 'user' | 'assistant'; content: string }

// The AI binding's typed surface is version-dependent; narrow it to just `run` here.
function ai(env: Env): { run: (model: string, input: unknown, options?: unknown) => Promise<unknown> } {
  if (!env.AI) throw new Error('Workers AI binding (env.AI) is not available');
  return env.AI;
}

/** Non-streaming completion via Workers AI (used for the health probe). */
export async function workersAiChat(
  env: Env, messages: WAMessage[], opts: { max_tokens?: number; temperature?: number } = {},
): Promise<{ text: string }> {
  const extra: Record<string, unknown> = {};
  if (opts.max_tokens) extra.max_tokens = opts.max_tokens;
  if (typeof opts.temperature === 'number') extra.temperature = opts.temperature;
  const res = (await ai(env).run(waModel(env), waInput(env, messages, extra))) as { response?: string } | undefined;
  return { text: res?.response ?? '' };
}

/**
 * Streaming completion via Workers AI. env.AI.run(model, { stream: true }) returns a
 * ReadableStream of SSE lines `data: {"response":"…"}` ending with `data: [DONE]`. We parse
 * it and forward each token to `onDelta`, mirroring the nvidia.ts chatStream contract so
 * the file streamer upstream doesn't care which backend produced the text.
 */
export async function workersAiStream(
  env: Env,
  messages: WAMessage[],
  opts: { max_tokens?: number; temperature?: number; signal?: AbortSignal },
  onDelta: (delta: string) => void | Promise<void>,
): Promise<{ text: string }> {
  const extra: Record<string, unknown> = { stream: true };
  if (opts.max_tokens) extra.max_tokens = opts.max_tokens;
  if (typeof opts.temperature === 'number') extra.temperature = opts.temperature;

  const streamUnknown = await ai(env).run(waModel(env), waInput(env, messages, extra));
  const stream = streamUnknown as ReadableStream<Uint8Array>;
  if (!stream || typeof (stream as any).pipeThrough !== 'function') {
    // The model returned a non-streamed object (some models ignore stream) — handle both.
    const res = streamUnknown as { response?: string } | undefined;
    const text = res?.response ?? '';
    if (text) await onDelta(text);
    return { text };
  }

  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let full = '';
  const handleLine = async (raw: string): Promise<void> => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const parsed = JSON.parse(payload) as { response?: string };
      const delta = parsed?.response ?? '';
      if (delta) { full += delta; await onDelta(delta); }
    } catch {
      /* partial JSON across chunks — completes on the next read */
    }
  };
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new Error('stopped');
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        await handleLine(line);
      }
    }
    if (buffer.trim()) await handleLine(buffer);
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return { text: full };
}
