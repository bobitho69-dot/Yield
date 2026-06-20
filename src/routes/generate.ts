// POST /api/generate  — chat + app build (streaming SSE)
// POST /api/route     — auto-pick the best coder model for a prompt (gpt-oss-20b)
//
// The model replies conversationally AND, when building, emits the app inside a
// ```html code block. We split the stream live: text outside the block -> 'chat'
// events (chat thread); the code block -> 'code' events (live preview).

import type { Ctx } from '../types';
import { sse, json, error } from '../lib/response';
import { checkPrompt } from '../lib/jailbreak';
import { gateGeneration, recordGeneration } from '../lib/usage';
import { CODER_MODELS, ROUTER_MODEL, resolveModel, endpointFor } from '../config/models';
import { chat, chatStream, extractHtml } from '../lib/nvidia';
import { CONVO_SYSTEM, routerSystem } from '../lib/prompts';
import { addMessage, createProject, getProject, listMessages, logUsage, saveProjectCode } from '../lib/db';
import { syncProjectToGithub } from './githubRoutes';

interface GenBody {
  prompt: string;
  model?: string;
  projectId?: string;
}

// Use gpt-oss-20b to choose the best coder model. Falls back to a heuristic.
export async function routeModel(c: Ctx, prompt: string): Promise<{ id: string; reason: string }> {
  const menu = CODER_MODELS.map((m) => ({ id: m.id, tier: m.tier, blurb: m.blurb }));
  try {
    const router = resolveModel(ROUTER_MODEL.id);
    const ep = endpointFor(c.env, router);
    const { text } = await chat({
      baseUrl: ep.baseUrl,
      apiKey: ep.apiKey,
      model: ep.modelId,
      messages: [
        { role: 'system', content: routerSystem(menu) },
        { role: 'user', content: prompt.slice(0, 4000) },
      ],
      temperature: 0,
      max_tokens: 120,
      timeoutMs: 15000,
    });
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]) as { model?: string; reason?: string };
      if (parsed.model && CODER_MODELS.some((x) => x.id === parsed.model)) {
        return { id: parsed.model, reason: parsed.reason || 'auto-selected' };
      }
    }
  } catch {
    /* fall through to heuristic */
  }
  const len = prompt.length;
  if (len > 600) return { id: 'deepseek-v4-pro', reason: 'complex request (fallback)' };
  if (len > 200) return { id: 'glm-5.1', reason: 'standard request (fallback)' };
  return { id: 'deepseek-v4-flash', reason: 'quick request (fallback)' };
}

export async function handleRoute(req: Request, c: Ctx): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as GenBody;
  if (!body.prompt) return error(400, 'prompt required');
  const choice = await routeModel(c, body.prompt);
  const model = resolveModel(choice.id);
  return json({ ...choice, label: model.label, tier: model.tier, pros: model.pros, cons: model.cons });
}

// Streaming splitter: separates conversational text from a ```html code block.
function makeSplitter(emit: (type: 'chat' | 'code', part: string) => Promise<void>) {
  let mode: 'chat' | 'code' = 'chat';
  let buf = '';
  let codeStarted = false;
  let chatText = '';
  let codeText = '';

  async function out(type: 'chat' | 'code', part: string) {
    if (!part) return;
    if (type === 'chat') chatText += part;
    else codeText += part;
    await emit(type, part);
  }

  async function feed(delta: string) {
    buf += delta;
    for (;;) {
      if (mode === 'chat') {
        const i = buf.indexOf('```');
        if (i === -1) {
          // Flush all but the last 2 chars (could be the start of a fence).
          if (buf.length > 2) {
            await out('chat', buf.slice(0, buf.length - 2));
            buf = buf.slice(buf.length - 2);
          }
          return;
        }
        if (i > 0) await out('chat', buf.slice(0, i));
        const after = buf.slice(i + 3);
        const nl = after.indexOf('\n');
        if (nl === -1) {
          buf = buf.slice(i); // wait for the language line to complete
          return;
        }
        buf = after.slice(nl + 1); // drop ```<lang>\n
        mode = 'code';
        codeStarted = true;
      } else {
        const j = buf.indexOf('```');
        if (j === -1) {
          if (buf.length > 2) {
            await out('code', buf.slice(0, buf.length - 2));
            buf = buf.slice(buf.length - 2);
          }
          return;
        }
        if (j > 0) await out('code', buf.slice(0, j));
        buf = buf.slice(j + 3);
        mode = 'chat';
      }
    }
  }

  async function end() {
    if (buf) {
      await out(mode, buf);
      buf = '';
    }
  }

  return {
    feed,
    end,
    get codeStarted() { return codeStarted; },
    get chatText() { return chatText.trim(); },
    get codeText() { return codeText; },
  };
}

export async function handleGenerate(req: Request, c: Ctx): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as GenBody;
  const prompt = (body.prompt || '').trim();
  if (!prompt) return error(400, 'prompt required');
  if (prompt.length > 12000) return error(413, 'prompt too long');

  // Return the stream immediately; do ALL work inside it so nothing freezes the UI.
  const { response, send, close } = sse();
  c.ctx.waitUntil(
    (async () => {
      try {
        await send('status', { stage: 'Screening prompt' });

        // 1) Jailbreak guard.
        const guard = await checkPrompt(c.env, prompt);
        if (guard.blocked) {
          if (body.projectId) await addMessage(c.env, { project_id: body.projectId, role: 'user', content: prompt, flagged: true });
          await logUsage(c.env, { user_id: c.user?.id ?? null, kind: 'blocked' });
          await send('blocked', { message: 'This prompt was blocked by the safety guard.', detail: guard.reason });
          return;
        }

        // 2) Usage gate.
        const gate = await gateGeneration(c);
        if (!gate.allowed) {
          await send('gate', { message: gate.reason || 'Not allowed right now.', code: gate.code });
          return;
        }

        // 3) Resolve model (Auto -> route via gpt-oss-20b).
        let modelId = body.model || 'auto';
        let routeReason: string | undefined;
        if (modelId === 'auto') {
          await send('status', { stage: 'Picking the best model' });
          const choice = await routeModel(c, prompt);
          modelId = choice.id;
          routeReason = choice.reason;
        }
        const model = resolveModel(modelId);

        // 4) Project (signed-in / guest users get persistence).
        let project = body.projectId ? await getProject(c.env, body.projectId) : null;
        if (project && c.user && project.user_id !== c.user.id) {
          await send('error', { message: 'Not your project.' });
          return;
        }
        if (!project && c.user) project = await createProject(c.env, c.user.id, prompt.slice(0, 60));

        await send('meta', { model: model.id, label: model.label, projectId: project?.id ?? null, routeReason });

        // 5) Build the message list: system + current app + recent history + new turn.
        const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
          { role: 'system', content: CONVO_SYSTEM },
        ];
        if (project?.code) {
          messages.push({ role: 'system', content: `The current app's full HTML is:\n\n${project.code}` });
        }
        if (project) {
          const { results } = await listMessages(c.env, project.id);
          for (const m of results.slice(-12)) {
            if (m.flagged) continue;
            if (m.role === 'user') messages.push({ role: 'user', content: m.content });
            else if (m.role === 'assistant' && m.content) messages.push({ role: 'assistant', content: m.content });
          }
        }
        messages.push({ role: 'user', content: prompt });

        // 6) Stream, splitting chat vs code. Retry once with a safe model if the
        //    chosen one errors before producing anything (e.g. bad model id).
        const splitter = makeSplitter(async (type, part) => { await send(type, part); });
        const streamWith = async (mdef: typeof model) => {
          const ep = endpointFor(c.env, mdef);
          await chatStream(
            { baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: ep.modelId, messages, max_tokens: 16384, timeoutMs: 120000 },
            async (delta) => { await splitter.feed(delta); },
          );
        };
        let activeModel = model;
        try {
          await streamWith(model);
        } catch (e) {
          if (splitter.codeStarted || splitter.chatText) throw e; // already streaming — don't double up
          const fb = resolveModel('deepseek-v4-flash');
          if (fb.id === model.id) throw e;
          activeModel = fb;
          await send('status', { stage: `Retrying with ${fb.label}` });
          await send('meta', { model: fb.id, label: fb.label, projectId: project?.id ?? null, routeReason: 'fallback' });
          await streamWith(fb);
        }
        await splitter.end();

        const code = splitter.codeStarted ? extractHtml(splitter.codeText) : '';
        const chatText = splitter.chatText || (splitter.codeStarted ? 'Done — updated your app.' : '…');
        await send('done', { chat: chatText, code, hasCode: splitter.codeStarted, projectId: project?.id ?? null });

        // 7) Persist.
        if (project && c.user) {
          await addMessage(c.env, { project_id: project.id, role: 'user', content: prompt });
          await addMessage(c.env, { project_id: project.id, role: 'assistant', content: chatText, model: activeModel.id });
          if (splitter.codeStarted && code.trim()) {
            await saveProjectCode(c.env, project.id, code, activeModel.id);
            await syncProjectToGithub(c, project, code);
          }
        }
        await recordGeneration(c);
        await logUsage(c.env, { user_id: c.user?.id ?? null, kind: splitter.codeStarted ? 'generate' : 'chat', model: activeModel.id, high_usage: gate.usage.highUsage });
      } catch (e: any) {
        await send('error', { message: String(e?.message || e).slice(0, 400) });
      } finally {
        await close();
      }
    })(),
  );
  return response;
}
