// POST /api/chat — Yield Chat (chat.url): a plain conversational assistant, streamed
// over SSE. NOT the app builder — it just talks (and writes code as markdown). Reuses
// the same multi-model backend + Auto router + jailbreak guard as the builder.
//
// Events: meta (model chosen) · thinking (reasoning) · chat (answer delta) · done · error
//
// Body: { messages: [{role:'user'|'assistant', content}], model?, thinking? }
//   - messages is the full conversation so far (last one is the new user turn).
//   - model defaults to 'auto' (the router picks per message).

import type { Ctx } from '../types';
import { sse, error } from '../lib/response';
import { checkPrompt } from '../lib/jailbreak';
import { resolveModel, endpointsFor } from '../config/models';
import { chatStream } from '../lib/nvidia';
import { workersAiConfigured, workersAiStream, compactWAMessages } from '../lib/workersai';
import { CHAT_SYSTEM, YIELD_AI_CHAT_SYSTEM } from '../lib/prompts';
import { routeModel, shortReason, STABLE_FALLBACKS } from './generate';

interface ChatTurn { role: 'user' | 'assistant'; content: string }
interface ChatBody { messages?: ChatTurn[]; model?: string; thinking?: string; prompt?: string }

function effortOf(v: string | undefined): 'low' | 'medium' | 'high' {
  return v === 'low' || v === 'medium' || v === 'high' ? v : 'medium';
}

// Normalize + bound the incoming conversation so a huge payload can't blow the context.
function cleanHistory(input: ChatBody): ChatTurn[] {
  let turns: ChatTurn[] = Array.isArray(input.messages) ? input.messages : [];
  if (!turns.length && input.prompt) turns = [{ role: 'user', content: input.prompt }];
  return turns
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 12000) }))
    .slice(-20); // keep the last ~20 turns
}

// Tags that fence model reasoning inside the visible content stream.
const THINK_TAGS = ['<think>', '<thinking>', '</think>', '</thinking>'];
// Length of a trailing "<…" that could be the START of a think tag split across chunks.
function partialTagTail(s: string): number {
  const lt = s.lastIndexOf('<');
  if (lt === -1) return 0;
  const tail = s.slice(lt).toLowerCase();
  if (tail.includes('>')) return 0; // a complete tag, not a partial — safe to emit
  return THINK_TAGS.some((t) => t.startsWith(tail)) ? s.length - lt : 0;
}

// Strip <think>…</think> (and <thinking>) out of a streamed content channel so a model's
// reasoning never leaks into the visible answer — it's routed to onThink instead. Tolerant
// of tags split across streaming chunks. Mirrors what the builder's file streamer does, for
// the plain chat surface (which previously streamed raw content, garbling replies).
function makeThinkFilter(
  onChat: (s: string) => Promise<void>,
  onThink: (s: string) => Promise<void>,
) {
  let buf = '', inThink = false, answer = '', thought = '';
  async function process(final: boolean): Promise<void> {
    for (;;) {
      if (!inThink) {
        const m = buf.match(/<think(?:ing)?>/i);
        if (!m) {
          const keep = final ? 0 : partialTagTail(buf);
          const out = buf.slice(0, buf.length - keep);
          if (out) { answer += out; buf = buf.slice(out.length); await onChat(out); }
          return;
        }
        const out = buf.slice(0, m.index);
        if (out) { answer += out; await onChat(out); }
        buf = buf.slice((m.index || 0) + m[0].length); inThink = true;
      } else {
        const m = buf.match(/<\/think(?:ing)?>/i);
        if (!m) {
          const keep = final ? 0 : partialTagTail(buf);
          const out = buf.slice(0, buf.length - keep);
          if (out) { thought += out; buf = buf.slice(out.length); await onThink(out); }
          return;
        }
        const out = buf.slice(0, m.index);
        if (out) { thought += out; await onThink(out); }
        buf = buf.slice((m.index || 0) + m[0].length); inThink = false;
      }
    }
  }
  return {
    async feed(d: string) { buf += d; await process(false); },
    async end() { await process(true); buf = ''; },
    get answer() { return answer.trim(); },
    get thought() { return thought.trim(); },
  };
}

export async function handleChat(req: Request, c: Ctx): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as ChatBody;
  const history = cleanHistory(body);
  if (!history.length) return error(400, 'messages required');
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  if (!lastUser) return error(400, 'a user message is required');

  const { response, send, close } = sse();
  const wantEffort = effortOf(body.thinking);

  c.ctx.waitUntil((async () => {
    try {
      // 1) Jailbreak guard on the newest user message.
      const guard = await checkPrompt(c.env, lastUser.content);
      if (guard.blocked) {
        await send('blocked', { message: 'This message was blocked by the safety guard.', detail: guard.reason });
        return;
      }

      // 2) Resolve the model (Auto → route via gpt-oss-20b on the latest user turn).
      let modelId = body.model || 'auto';
      let routeReason: string | undefined;
      if (modelId === 'auto') {
        const choice = await routeModel(c, lastUser.content);
        modelId = choice.id;
        routeReason = choice.reason;
      }
      let model = resolveModel(modelId);
      await send('meta', { model: model.id, label: model.label, routeReason });

      // 3) Build the OpenAI-style message list. The in-house Yield AI runs on a small base
      //    model, so it gets a SHORT strict prompt (a long one gets parroted back as menus /
      //    fake links / emoji); the hosted models get the full CHAT_SYSTEM.
      const isYieldAI = model.id === 'yield-ai';
      const chatTemp = isYieldAI ? 0.4 : 0.6; // lower temp for the base model = less rambling
      const messages = [
        { role: 'system' as const, content: isYieldAI ? YIELD_AI_CHAT_SYSTEM : CHAT_SYSTEM },
        ...history.map((m) => ({ role: m.role, content: m.content })),
      ];

      // 4) Stream the reply. <think> reasoning is routed to the Thinking panel; visible
      //    text streams as 'chat' deltas. On failure, retry plainly, then fall back
      //    through the stable anchor models so a chat reply almost always lands.
      let sawText = false;   // any VISIBLE answer text (post think-strip) was produced
      let answer = '';       // accumulated visible answer
      let reasoning = '';    // accumulated reasoning / <think> text (fallback if answer is empty)
      const onChat = async (s: string) => { sawText = true; answer += s; await send('chat', s); };
      const onThink = async (s: string) => { reasoning += s; await send('thinking', s); };
      const streamWith = async (mdef: typeof model, eff: 'low' | 'medium' | 'high' | null) => {
        // Filter out any inline <think>…</think> so reasoning never garbles the visible reply.
        const filter = makeThinkFilter(onChat, onThink);
        // In-house Yield AI on Cloudflare Workers AI: run on Cloudflare's GPUs via the AI
        // binding (base model + optional LoRA), NOT an HTTP endpoint. Throws on failure so
        // the fallback ladder below still applies.
        if (mdef.id === 'yield-ai' && workersAiConfigured(c.env)) {
          await workersAiStream(
            c.env, compactWAMessages(messages, { maxTurns: 8 }), { temperature: chatTemp, max_tokens: 2048 },
            async (delta) => { await filter.feed(delta); },
          );
          await filter.end();
          return;
        }
        const chain = endpointsFor(c.env, mdef);
        for (let i = 0; i < chain.length; i++) {
          const ep = chain[i];
          try {
            await chatStream(
              {
                baseUrl: ep.baseUrl, apiKey: ep.apiKey, apiKeyBackup: ep.apiKeyBackup, model: ep.modelId, messages,
                temperature: chatTemp, top_p: 0.95, max_tokens: 8000, timeoutMs: 120000,
                ...(eff ? { extra: { reasoning_effort: eff } } : {}),
              },
              async (delta) => { await filter.feed(delta); },
              async (r) => { await onThink(r); },
            );
            await filter.end();
            return;
          } catch (e) {
            if (sawText || i === chain.length - 1) throw e;
          }
        }
      };

      const tried = new Set<string>([model.id]);
      try {
        await streamWith(model, wantEffort);
      } catch (e1) {
        if (!sawText) {
          let ok = false;
          try { await streamWith(model, null); ok = true; } catch { /* try fallbacks */ }
          for (const sid of STABLE_FALLBACKS) {
            if (ok || sawText) break;
            if (tried.has(sid)) continue;
            tried.add(sid);
            const fb = resolveModel(sid);
            model = fb;
            await send('meta', { model: fb.id, label: fb.label, routeReason: `Retrying on ${fb.label}` });
            try { await streamWith(fb, null); ok = true; } catch { /* next */ }
          }
          if (!ok && !sawText) {
            await send('error', { message: `The AI provider errored (${shortReason(e1)}). Please try again.` });
            return;
          }
        }
      }

      // Reasoning-only completion: the model put its whole reply in the reasoning/<think>
      // channel and emitted no visible content. Promote it so the user gets a real answer
      // instead of a blank bubble, rather than treating an empty stream as success.
      if (!answer.trim() && reasoning.trim()) {
        await send('chat', reasoning.trim());
      }

      await send('done', { model: model.id, label: model.label });
    } catch (e: any) {
      console.error('chat failed:', e?.stack || e);
      await send('error', { message: `Something went wrong (${shortReason(e)}). Please try again.` });
    } finally {
      await close();
    }
  })());

  return response;
}
