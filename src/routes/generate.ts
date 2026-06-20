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
  addMessage, createAgent, createProject, getProject, getProjectFiles, getSecretRows, listAgents, listMessages,
  logUsage, saveFiles, updateAgent, type FileRow,
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
      max_tokens: 400,
      timeoutMs: 35000,
      // gpt-oss is a reasoning model — keep it fast so routing doesn't time out.
      extra: { reasoning_effort: 'low' },
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
  // Heuristic by complexity (no scary "fallback" wording for the user).
  const len = prompt.length;
  if (len > 600) return { id: 'deepseek-v4-pro', reason: 'complex build' };
  if (len > 200) return { id: 'glm-5.1', reason: 'standard build' };
  return { id: 'deepseek-v4-flash', reason: 'quick build' };
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

export interface SecretReq { name: string; description: string }
export interface AgentReq { name: string; model: string | null; system_prompt: string }

// Streaming parser: chat text streams live; "=== file: path ===" starts a file,
// "=== agent: Name | model ===" declares an agent, "=== secret: NAME — why ==="
// requests a secret.
function makeFileStreamer(send: (event: string, data: unknown) => Promise<void>) {
  const FILE = /^={2,}\s*file:\s*(.+?)\s*={2,}\s*$/i;
  const SECRET = /^={2,}\s*secret:\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:[—:-]\s*(.*?))?\s*={2,}\s*$/i;
  const AGENT = /^={2,}\s*agent:\s*([^|=]+?)\s*(?:\|\s*([^=]+?)\s*)?={2,}\s*$/i;
  let buf = '';
  let mode: 'chat' | 'file' | 'agent' = 'chat';
  let curFile: { path: string; lines: string[] } | null = null;
  let curAgent: { name: string; model: string | null; lines: string[] } | null = null;
  let lastStatus = '';
  const chatLines: string[] = [];
  const files: { path: string; lines: string[] }[] = [];
  const agents: { name: string; model: string | null; lines: string[] }[] = [];
  const secrets: SecretReq[] = [];

  async function handleLine(line: string) {
    let m;
    if ((m = line.match(FILE))) {
      mode = 'file';
      curFile = { path: m[1].trim().replace(/^\/+/, ''), lines: [] };
      files.push(curFile);
      if (curFile.path !== lastStatus) { lastStatus = curFile.path; await send('status', { stage: `Writing ${curFile.path}` }); }
      return;
    }
    if ((m = line.match(AGENT))) {
      mode = 'agent';
      curAgent = { name: m[1].trim().slice(0, 80), model: m[2] ? m[2].trim() : null, lines: [] };
      agents.push(curAgent);
      await send('status', { stage: `Creating agent ${curAgent.name}` });
      return;
    }
    if ((m = line.match(SECRET))) {
      secrets.push({ name: m[1].trim(), description: (m[2] || '').trim() });
      return; // single-line; doesn't change mode
    }
    if (mode === 'chat') { chatLines.push(line); await send('chat', line + '\n'); }
    else if (mode === 'file' && curFile) curFile.lines.push(line);
    else if (mode === 'agent' && curAgent) curAgent.lines.push(line);
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
    get produced() { return chatLines.length > 0 || files.length > 0 || agents.length > 0; },
    result() {
      const chat = chatLines.join('\n').trim();
      const fs: FileRow[] = files
        .map((f) => ({ path: f.path, content: cleanFile(f.lines.join('\n')) }))
        .filter((f) => f.path && f.content.trim());
      const ags: AgentReq[] = agents
        .map((a) => ({ name: a.name, model: a.model, system_prompt: cleanFile(a.lines.join('\n')) }))
        .filter((a) => a.name && a.system_prompt.trim());
      return { chat, files: fs, hasFiles: fs.length > 0, agents: ags, secrets };
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
        // Make this app's AI agents (+ account-level) available to apps you build.
        if (c.user) {
          const { results: agents } = await listAgents(c.env, c.user.id, project?.id);
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
          await send('status', { stage: `Switching to ${fb.label}` });
          await send('meta', { model: fb.id, label: fb.label, projectId: project?.id ?? null, routeReason: 'stable model' });
          await streamWith(fb);
        }
        await streamer.end();

        const { chat: chatBody, files, hasFiles, agents: agentReqs, secrets: secretReqs } = streamer.result();
        const chatText = chatBody || (hasFiles ? 'Updated your app.' : 'Done.');

        // 7) Create/update AI-declared agents (project-scoped) and resolve secret needs.
        const createdAgents: Record<string, string> = {};
        let secretsNeeded: typeof secretReqs = [];
        if (project && c.user) {
          if (agentReqs.length) {
            const { results: existing } = await listAgents(c.env, c.user.id, project.id);
            for (const a of agentReqs) {
              const model = CODER_MODELS.some((m) => m.id === a.model) ? a.model! : 'glm-5.1';
              const found = existing.find((e) => e.name === a.name && e.project_id === project.id);
              if (found) { await updateAgent(c.env, found.id, { system_prompt: a.system_prompt, model }); createdAgents[a.name] = found.id; }
              else { const ag = await createAgent(c.env, c.user.id, { name: a.name, system_prompt: a.system_prompt, model, is_public: true, project_id: project.id }); createdAgents[a.name] = ag.id; }
            }
          }
          if (secretReqs.length) {
            const { results: have } = await getSecretRows(c.env, c.user.id, project.id);
            const haveNames = new Set(have.map((r) => r.name));
            secretsNeeded = secretReqs.filter((s) => !haveNames.has(s.name));
          }
        }

        // Persist files BEFORE 'done' so the preview can fetch them immediately.
        if (project && c.user && hasFiles) await saveFiles(c.env, project.id, files, activeModel.id);

        await send('done', { chat: chatText, files, hasCode: hasFiles, projectId: project?.id ?? null, secretsNeeded, agents: createdAgents });

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
