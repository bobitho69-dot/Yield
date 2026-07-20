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
import { CHAT_SYSTEM, YIELD_AI_IDENTITY } from '../lib/prompts';
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

      // 3) Build the OpenAI-style message list. The in-house Yield AI gets its identity
      //    so it introduces itself correctly.
      const messages = [
        { role: 'system' as const, content: CHAT_SYSTEM },
        ...(model.id === 'yield-ai' ? [{ role: 'system' as const, content: YIELD_AI_IDENTITY }] : []),
        ...history.map((m) => ({ role: m.role, content: m.content })),
      ];

      // 4) Stream the reply. <think> reasoning is routed to the Thinking panel; visible
      //    text streams as 'chat' deltas. On failure, retry plainly, then fall back
      //    through the stable anchor models so a chat reply almost always lands.
      let sawText = false;
      const streamWith = async (mdef: typeof model, eff: 'low' | 'medium' | 'high' | null) => {
        // In-house Yield AI on Cloudflare Workers AI: run on Cloudflare's GPUs via the AI
        // binding (base model + optional LoRA), NOT an HTTP endpoint. Throws on failure so
        // the fallback ladder below still applies.
        if (mdef.id === 'yield-ai' && workersAiConfigured(c.env)) {
          await workersAiStream(
            c.env, compactWAMessages(messages, { maxTurns: 8 }), { temperature: 0.6, max_tokens: 2048 },
            async (delta) => { sawText = true; await send('chat', delta); },
          );
          return;
        }
        const chain = endpointsFor(c.env, mdef);
        for (let i = 0; i < chain.length; i++) {
          const ep = chain[i];
          try {
            await chatStream(
              {
                baseUrl: ep.baseUrl, apiKey: ep.apiKey, apiKeyBackup: ep.apiKeyBackup, model: ep.modelId, messages,
                temperature: 0.6, top_p: 0.95, max_tokens: 8000, timeoutMs: 120000,
                ...(eff ? { extra: { reasoning_effort: eff } } : {}),
              },
              async (delta) => { sawText = true; await send('chat', delta); },
              async (r) => { await send('thinking', r); },
            );
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
