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
import { chat, chatStream } from '../lib/nvidia';
import { CONVO_SYSTEM, routerSystem } from '../lib/prompts';
import {
  addMessage, createProject, getProject, getProjectFiles, listAgents, listMessages, logUsage, saveFiles, type FileRow,
} from '../lib/db';
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

// Strip an accidental surrounding ```lang fence from a file's content.
function cleanFile(s: string): string {
  let t = s.replace(/^\n+|\n+$/g, '');
  const fence = t.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```$/);
  if (fence) t = fence[1];
  return t;
}

// Streaming parser: text before the first "=== file: path ===" marker is chat
// (streamed live, line by line); each marker starts a new file.
function makeFileStreamer(send: (event: string, data: unknown) => Promise<void>) {
  const MARKER = /^={2,}\s*file:\s*(.+?)\s*={2,}\s*$/i;
  let buf = '';
  let mode: 'chat' | 'files' = 'chat';
  let cur: { path: string; lines: string[] } | null = null;
  let lastStatus = '';
  const chatLines: string[] = [];
  const files: { path: string; lines: string[] }[] = [];

  async function handleLine(line: string) {
    const m = line.match(MARKER);
    if (m) {
      mode = 'files';
      cur = { path: m[1].trim().replace(/^\/+/, ''), lines: [] };
      files.push(cur);
      if (cur.path !== lastStatus) { lastStatus = cur.path; await send('status', { stage: `Writing ${cur.path}` }); }
      return;
    }
    if (mode === 'chat') {
      chatLines.push(line);
      await send('chat', line + '\n');
    } else if (cur) {
      cur.lines.push(line);
    }
  }

  return {
    async feed(delta: string) {
      buf += delta;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        await handleLine(line);
      }
    },
    async end() {
      if (buf.length) { await handleLine(buf); buf = ''; }
    },
    get produced() { return chatLines.length > 0 || files.length > 0; },
    result(): { chat: string; files: FileRow[]; hasFiles: boolean } {
      const chat = chatLines.join('\n').trim();
      const fs = files
        .map((f) => ({ path: f.path, content: cleanFile(f.lines.join('\n')) }))
        .filter((f) => f.path && f.content.trim());
      return { chat, files: fs, hasFiles: fs.length > 0 };
    },
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
        if (project) {
          const curFiles = await getProjectFiles(c.env, project);
          if (curFiles.length) {
            const dump = curFiles.map((f) => `=== file: ${f.path} ===\n${f.content}`).join('\n\n');
            messages.push({ role: 'system', content: `The current project files are:\n\n${dump}` });
          }
        }
        // Make the user's AI agents available to apps you build.
        if (c.user) {
          const { results: agents } = await listAgents(c.env, c.user.id);
          if (agents.length) {
            const list = agents.map((a) => `- "${a.name}" (id: ${a.id})${a.description ? ` — ${a.description}` : ''}`).join('\n');
            messages.push({
              role: 'system',
              content:
                `The user has these AI agents. To use one from the app, POST JSON {"input":"..."} to ` +
                `https://<this-origin>/api/agents/<id>/run and read the JSON {"output":"..."} reply (CORS is enabled, no auth needed for public agents). ` +
                `Use the app's own origin. When an app would benefit from AI (chatbot, generator, classifier, assistant), wire it to the right agent.\n\nAgents:\n${list}`,
            });
          }
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

        // 6) Stream: separate chat from multi-file output. Retry once with a safe
        //    model if the chosen one errors before producing anything.
        const streamer = makeFileStreamer(send);
        const streamWith = async (mdef: typeof model) => {
          const ep = endpointFor(c.env, mdef);
          await chatStream(
            { baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: ep.modelId, messages, max_tokens: 32768, timeoutMs: 180000 },
            async (delta) => { await streamer.feed(delta); },
          );
        };
        let activeModel = model;
        try {
          await streamWith(model);
        } catch (e) {
          if (streamer.produced) throw e; // already streaming — don't double up
          const fb = resolveModel('deepseek-v4-flash');
          if (fb.id === model.id) throw e;
          activeModel = fb;
          await send('status', { stage: `Retrying with ${fb.label}` });
          await send('meta', { model: fb.id, label: fb.label, projectId: project?.id ?? null, routeReason: 'fallback' });
          await streamWith(fb);
        }
        await streamer.end();

        const { chat: chatBody, files, hasFiles } = streamer.result();
        const chatText = chatBody || (hasFiles ? 'Updated your app.' : 'Done.');

        // 7) Persist files BEFORE 'done' so the preview can fetch them immediately.
        if (project && c.user && hasFiles) await saveFiles(c.env, project.id, files, activeModel.id);

        await send('done', { chat: chatText, files, hasCode: hasFiles, projectId: project?.id ?? null });

        if (project && c.user) {
          await addMessage(c.env, { project_id: project.id, role: 'user', content: prompt });
          await addMessage(c.env, { project_id: project.id, role: 'assistant', content: chatText, model: activeModel.id });
          if (hasFiles) await syncProjectToGithub(c, project, files);
        }
        await recordGeneration(c);
        await logUsage(c.env, { user_id: c.user?.id ?? null, kind: hasFiles ? 'generate' : 'chat', model: activeModel.id, high_usage: gate.usage.highUsage });
      } catch (e: any) {
        await send('error', { message: String(e?.message || e).slice(0, 400) });
      } finally {
        await close();
      }
    })(),
  );
  return response;
}
