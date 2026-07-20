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

function loraName(env: Env): string {
  return (env.YIELD_AI_LORA || '').trim();
}

// Build the env.AI.run input. Workers AI text models take OpenAI-style `messages`; a LoRA
// is applied by passing its name as `lora`. `useLora` lets a caller retry WITHOUT the LoRA
// (e.g. when the configured adapter isn't uploaded yet) so Yield AI still runs on the base
// Cloudflare model instead of falling back to an external provider.
function waInput(env: Env, messages: WAMessage[], extra: Record<string, unknown>, useLora: boolean): Record<string, unknown> {
  const input: Record<string, unknown> = { messages, ...extra };
  const lora = loraName(env);
  if (useLora && lora) input.lora = lora;
  return input;
}

export interface WAMessage { role: 'system' | 'user' | 'assistant'; content: string }

// Workers AI base models have a small context window (e.g. Mistral 7B ~8k). Shrink an
// arbitrary chat/code message list to fit: cap each system message, keep only the most
// recent turns. Keeps Yield AI usable instead of failing on a big prompt (and falling back).
export function compactWAMessages(
  messages: WAMessage[], opts: { maxSystemChars?: number; maxTurns?: number } = {},
): WAMessage[] {
  const maxSys = opts.maxSystemChars ?? 3000;
  const maxTurns = opts.maxTurns ?? 6;
  const sys = messages.filter((m) => m.role === 'system').map((m) => ({ role: m.role, content: m.content.slice(0, maxSys) }));
  const convo = messages.filter((m) => m.role !== 'system').slice(-maxTurns);
  return [...sys, ...convo];
}

// The AI binding's typed surface is version-dependent; narrow it to just `run` here.
function ai(env: Env): { run: (model: string, input: unknown, options?: unknown) => Promise<unknown> } {
  if (!env.AI) throw new Error('Workers AI binding (env.AI) is not available');
  return env.AI;
}

/** Non-streaming completion via Workers AI (used for the health probe). Retries once on
 *  the base model (no LoRA) if the LoRA-applied run fails, so a not-yet-uploaded adapter
 *  doesn't make Yield AI look down. */
export async function workersAiChat(
  env: Env, messages: WAMessage[], opts: { max_tokens?: number; temperature?: number } = {},
): Promise<{ text: string }> {
  const extra: Record<string, unknown> = {};
  if (opts.max_tokens) extra.max_tokens = opts.max_tokens;
  if (typeof opts.temperature === 'number') extra.temperature = opts.temperature;
  const run = async (useLora: boolean) =>
    (await ai(env).run(waModel(env), waInput(env, messages, extra, useLora))) as { response?: string } | undefined;
  try {
    const res = await run(true);
    return { text: res?.response ?? '' };
  } catch (e) {
    if (!loraName(env)) throw e;
    console.warn('Yield AI (Workers AI): LoRA run failed, retrying base model without LoRA:', String((e as any)?.message || e));
    const res = await run(false);
    return { text: res?.response ?? '' };
  }
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

  // Tracked across attempts: once ANY token has reached the caller we must NOT retry, or
  // the base-model retry would duplicate the LoRA attempt's partial output.
  let sawAny = false;
  const emit = async (d: string) => { sawAny = true; await onDelta(d); };

  // One streaming attempt against Workers AI (with or without the LoRA).
  const attempt = async (useLora: boolean): Promise<{ text: string }> => {
    let full = '';
    const streamUnknown = await ai(env).run(waModel(env), waInput(env, messages, extra, useLora));
    const stream = streamUnknown as ReadableStream<Uint8Array>;
    if (!stream || typeof (stream as any).pipeThrough !== 'function') {
      // The model returned a non-streamed object (some models ignore stream) — handle both.
      const res = streamUnknown as { response?: string } | undefined;
      const text = res?.response ?? '';
      if (text) await emit(text);
      return { text };
    }
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    const handleLine = async (raw: string): Promise<void> => {
      const line = raw.trim();
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try {
        const parsed = JSON.parse(payload) as { response?: string };
        const delta = parsed?.response ?? '';
        if (delta) { full += delta; await emit(delta); }
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
  };

  try {
    return await attempt(true);
  } catch (e) {
    // If a LoRA is configured but the run failed WITHOUT emitting anything, the adapter is
    // likely not uploaded / not compatible. Retry on the BASE model (no LoRA) so Yield AI
    // still answers on Cloudflare rather than falling back to an external provider.
    if (loraName(env) && !sawAny && !opts.signal?.aborted) {
      console.warn('Yield AI (Workers AI): LoRA stream failed, retrying base model without LoRA:', String((e as any)?.message || e));
      return await attempt(false);
    }
    throw e;
  }
}
