// Yield Code (code.url) — Yield's agentic coder, like Claude Code. It works on an
// EXISTING codebase and makes real multi-file changes:
//   • repo    — a connected GitHub repo: reads its files, edits, and COMMITS back
//   • project — a Yield project: full builder pipeline (agents, verify, GitHub sync)
//   • local   — a folder the caller sends (desktop app / paste): edits, returns files
// Auto mode picks the model; it can launch parallel build agents + research helpers and
// is aware of connected MCP servers.
//
// Routes (dispatched from index.ts on /api/code/*):
//   GET  /api/code/status                     -> { github, models, projects, loginRequired }
//   GET  /api/code/repos                       -> { repos } (connectable GitHub repos)
//   GET  /api/code/tree?repo=&branch=          -> { tree } (file explorer)
//   GET  /api/code/file?repo=&branch=&path=    -> { path, content }
//   POST /api/code/run                         -> SSE stream (the agentic edit)

import type { Ctx } from '../types';
import { sse, json, error } from '../lib/response';
import { checkPrompt } from '../lib/jailbreak';
import { resolveModel, endpointsFor, pickerModels } from '../config/models';
import { chatStream } from '../lib/nvidia';
import { workersAiConfigured, workersAiStream, compactWAMessages } from '../lib/workersai';
import { CODE_SYSTEM, YIELD_AI_IDENTITY } from '../lib/prompts';
import {
  makeFileStreamer, runSubAgent, runResearchAgent, routeModel, shortReason,
  STABLE_FALLBACKS, runBuild, type SendFn, type TaskReq, type ResearchReq,
} from './generate';
import {
  getGithubAuth, getProject, createProject, listProjects, type FileRow,
} from '../lib/db';
import {
  decryptToken, listRepos, readRepoFiles, listRepoTree, getRepoFile, putRepoFile,
} from '../lib/github';

// --- Types the /run endpoint accepts ------------------------------------------
interface CodeTurn { role: 'user' | 'assistant'; content: string }
interface McpServer { name: string; transport?: string; url?: string; command?: string; description?: string }
interface CodeBody {
  prompt?: string;
  mode?: 'repo' | 'project' | 'local';
  repo?: string;
  branch?: string;
  projectId?: string;
  model?: string;
  thinking?: string;
  agentMode?: boolean;            // "Auto" agent mode (let it delegate + verify freely)
  history?: CodeTurn[];
  files?: FileRow[];              // local mode: the caller's current files
  mcpServers?: McpServer[];
}

function effortOf(v: string | undefined): 'low' | 'medium' | 'high' {
  return v === 'low' || v === 'medium' || v === 'high' ? v : 'medium';
}

// --- GET handlers -------------------------------------------------------------
async function codeStatus(c: Ctx): Promise<Response> {
  const auth = c.user ? await getGithubAuth(c.env, c.user.id) : null;
  let projects: { id: string; title: string; github_repo: string | null }[] = [];
  if (c.user) {
    try {
      const { results } = await listProjects(c.env, c.user.id);
      projects = results.slice(0, 50).map((p: any) => ({ id: p.id, title: p.title, github_repo: p.github_repo ?? null }));
    } catch { /* projects are best-effort */ }
  }
  return json({
    github: { connected: !!auth, login: auth?.login ?? null },
    models: pickerModels(),
    projects,
    loginRequired: c.env.AUTH_ENABLED === 'true' && !c.user,
  });
}

async function codeRepos(c: Ctx): Promise<Response> {
  if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });
  const auth = await getGithubAuth(c.env, c.user.id);
  if (!auth) return error(400, 'GitHub not connected.', { code: 'github_not_connected' });
  const token = await decryptToken(c.env, auth.tokenEnc);
  return json({ repos: await listRepos(token) });
}

async function codeTree(c: Ctx): Promise<Response> {
  if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });
  const auth = await getGithubAuth(c.env, c.user.id);
  if (!auth) return error(400, 'GitHub not connected.', { code: 'github_not_connected' });
  const repo = c.url.searchParams.get('repo');
  const branch = c.url.searchParams.get('branch') || 'main';
  if (!repo) return error(400, 'repo required');
  const token = await decryptToken(c.env, auth.tokenEnc);
  return json({ tree: await listRepoTree(token, repo, branch) });
}

async function codeFile(c: Ctx): Promise<Response> {
  if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });
  const auth = await getGithubAuth(c.env, c.user.id);
  if (!auth) return error(400, 'GitHub not connected.', { code: 'github_not_connected' });
  const repo = c.url.searchParams.get('repo');
  const branch = c.url.searchParams.get('branch') || 'main';
  const path = c.url.searchParams.get('path');
  if (!repo || !path) return error(400, 'repo and path required');
  const token = await decryptToken(c.env, auth.tokenEnc);
  const f = await getRepoFile(token, repo, branch, path);
  if (!f) return error(404, 'File not found');
  return json({ path, content: f.content });
}

// Sanitize caller-provided local files (mode: 'local') to a sane size.
function sanitizeFiles(input: unknown): FileRow[] {
  if (!Array.isArray(input)) return [];
  const out: FileRow[] = [];
  let total = 0;
  for (const f of input) {
    if (!f || typeof f !== 'object') continue;
    const path = String((f as any).path || '').replace(/^\/+/, '').slice(0, 300);
    const content = String((f as any).content ?? '');
    if (!path || total + content.length > 600_000) continue;
    total += content.length;
    out.push({ path, content });
    if (out.length >= 80) break;
  }
  return out;
}

function cleanHistory(input: CodeTurn[] | undefined): CodeTurn[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }))
    .slice(-12);
}

// Format the connected MCP servers as a context note for the model.
function mcpContext(servers: McpServer[] | undefined): string | null {
  const list = (servers || []).filter((s) => s && s.name).slice(0, 20);
  if (!list.length) return null;
  const lines = list.map((s) => {
    const where = s.url ? `HTTP ${s.url}` : s.command ? `stdio: ${s.command}` : (s.transport || 'stdio');
    return `- "${s.name}" (${where})${s.description ? ` — ${s.description}` : ''}`;
  });
  return `MCP servers connected to this coding session (Model Context Protocol tools available to the app/agent you build — wire code to them when the task calls for it; if a needed one is missing, tell the user which to add):\n${lines.join('\n')}`;
}

// --- The streaming agentic edit (repo / local modes) --------------------------
async function runCode(c: Ctx, body: CodeBody, send: SendFn, signal?: AbortSignal): Promise<void> {
  const prompt = (body.prompt || '').trim();
  const wantEffort = effortOf(body.thinking);
  const stopped = () => !!signal?.aborted;

  // Guard.
  await send('status', { stage: 'Screening request' });
  const guard = await checkPrompt(c.env, prompt);
  if (guard.blocked) { await send('blocked', { message: 'This request was blocked by the safety guard.', detail: guard.reason }); return; }

  // Resolve the codebase we're editing.
  const mode = body.mode || (body.repo ? 'repo' : body.projectId ? 'project' : 'local');
  let token: string | null = null;
  let repoFiles: FileRow[] = [];
  if (mode === 'repo') {
    if (!c.user) { await send('error', { message: 'Sign in and connect GitHub to edit a repo.' }); return; }
    const auth = await getGithubAuth(c.env, c.user.id);
    if (!auth) { await send('error', { message: 'Connect GitHub first (Settings → connect), then pick a repo.' }); return; }
    token = await decryptToken(c.env, auth.tokenEnc);
    await send('status', { stage: `Reading ${body.repo}…` });
    repoFiles = await readRepoFiles(token, body.repo!, body.branch || 'main');
    await send('context', { files: repoFiles.map((f) => f.path), repo: body.repo, branch: body.branch || 'main' });
  } else {
    repoFiles = sanitizeFiles(body.files);
    if (repoFiles.length) await send('context', { files: repoFiles.map((f) => f.path) });
  }

  // Resolve model (Auto → route).
  let modelId = body.model || 'auto';
  let routeReason: string | undefined;
  if (modelId === 'auto') {
    await send('status', { stage: 'Picking the best model' });
    const choice = await routeModel(c, prompt, [], signal);
    modelId = choice.id;
    routeReason = choice.reason;
  }
  let model = resolveModel(modelId);
  await send('meta', { model: model.id, label: model.label, routeReason, mode, repo: body.repo || null });

  // Build the message list: system + codebase + MCP + history + request.
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: CODE_SYSTEM },
  ];
  if (model.id === 'yield-ai') messages.push({ role: 'system', content: YIELD_AI_IDENTITY });
  if (repoFiles.length) {
    const dump = repoFiles.map((f) => `=== file: ${f.path} ===\n${f.content}`).join('\n\n');
    messages.push({ role: 'system', content: `The project's current files (edit these; keep everything else intact):\n\n${dump}` });
  } else if (mode !== 'project') {
    messages.push({ role: 'system', content: 'This is a fresh/empty workspace — there are no existing files yet. Create the files the request needs from scratch.' });
  }
  const mcp = mcpContext(body.mcpServers);
  if (mcp) messages.push({ role: 'system', content: mcp });
  for (const m of cleanHistory(body.history)) messages.push({ role: m.role, content: m.content });
  messages.push({ role: 'user', content: prompt });

  // Stream once through a fresh parser, with reasoning-flag + stable-model fallbacks.
  const streamOnce = async () => {
    const streamer = makeFileStreamer(send, 'Yield Code');
    const streamWith = async (mdef: typeof model, eff: 'low' | 'medium' | 'high' | null) => {
      // In-house Yield AI on Cloudflare Workers AI: run via the AI binding (base model +
      // optional LoRA), not an HTTP endpoint. Throws on failure so the ladder below applies.
      if (mdef.id === 'yield-ai' && workersAiConfigured(c.env)) {
        await workersAiStream(
          c.env, compactWAMessages(messages, { maxSystemChars: 4000, maxTurns: 4 }), { temperature: 0.3, max_tokens: 2048, signal },
          async (delta) => { await streamer.feed(delta); },
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
              temperature: 0.3, top_p: 0.95, timeoutMs: 600000, signal,
              ...(eff ? { extra: { reasoning_effort: eff } } : {}),
            },
            async (delta) => { await streamer.feed(delta); },
            async (r) => { await send('thinking', r); },
          );
          return;
        } catch (e) {
          if (streamer.produced || stopped() || i === chain.length - 1) throw e;
          streamer.reset();
        }
      }
    };
    try {
      await streamWith(model, wantEffort);
    } catch (e) {
      if (streamer.produced || stopped()) { /* keep partial */ }
      else {
        let ok = false;
        streamer.reset();
        try { await streamWith(model, null); ok = true; } catch { /* fall through */ }
        const tried = new Set<string>([model.id]);
        for (const sid of STABLE_FALLBACKS) {
          if (ok || streamer.produced || stopped()) break;
          if (tried.has(sid)) continue;
          tried.add(sid);
          const fb = resolveModel(sid);
          model = fb;
          await send('status', { stage: `Retrying on ${fb.label}…` });
          await send('meta', { model: fb.id, label: fb.label, mode, repo: body.repo || null });
          streamer.reset();
          try { await streamWith(fb, null); ok = true; } catch { /* next */ }
        }
        if (!ok && !streamer.produced) throw e;
      }
    }
    await streamer.end();
    return streamer.result();
  };

  let result = await streamOnce();

  // Research helpers (one round), then build again with the findings.
  if (!stopped() && result.research.length) {
    const reqs: ResearchReq[] = result.research;
    await send('status', { stage: `Consulting ${reqs.length} helper AI(s)…` });
    const rctx = `Coding task on an existing project. Request:\n${prompt.slice(0, 1400)}`;
    const findings = await Promise.all(reqs.map(async (r) => {
      await send('research', { name: r.name, status: 'working' });
      const f = await runResearchAgent(c.env, r, rctx, wantEffort, async () => {}, signal);
      await send('research', { name: r.name, findings: f.findings });
      return f;
    }));
    messages.push({ role: 'assistant', content: (result.chat || 'Let me research this first.').slice(0, 2000) });
    messages.push({
      role: 'user',
      content: 'Findings from your helper AIs:\n\n' + findings.map((f) => `### ${f.name}\n${f.findings}`).join('\n\n') +
        '\n\nNow make the change: output the complete updated files. Do not request more research.',
    });
    const pass2 = await streamOnce();
    const byPath = new Map<string, FileRow>();
    for (const f of result.files) byPath.set(f.path, f);
    for (const f of pass2.files) byPath.set(f.path, f);
    result = { ...pass2, chat: pass2.chat || result.chat, files: [...byPath.values()], tasks: pass2.tasks.length ? pass2.tasks : result.tasks };
  }

  let files: FileRow[] = result.files;
  let agentNote = '';

  // Parallel build agents (=== task: ===): each streams its own files live.
  if (!stopped() && result.tasks.length) {
    await send('status', { stage: `Launching ${result.tasks.length} agent(s)…` });
    const sharedContext =
      `You are part of a team editing ONE project. Request:\n${prompt.slice(0, 1500)}\n\n` +
      `Lead engineer's plan:\n${(result.chat || '').slice(0, 2000)}` +
      (files.length ? `\n\nThe lead already wrote these files — do NOT recreate them: ${files.map((f) => f.path).join(', ')}` : '') +
      (repoFiles.length ? `\n\nExisting project files you must stay consistent with: ${repoFiles.map((f) => f.path).join(', ')}` : '');
    const labelFor = (id?: string | null) => resolveModel(id || 'deepseek-v4-flash').label;
    for (const t of result.tasks as TaskReq[]) await send('worker', { name: t.name, kind: 'build', status: 'start', model: labelFor(t.model) });
    const results = await Promise.all((result.tasks as TaskReq[]).map(async (t) => {
      const res = await runSubAgent(c.env, t, sharedContext, send, wantEffort, async () => {}, signal);
      const n = res.files.length;
      await send('worker', { name: t.name, kind: 'build', status: n ? 'done' : 'fail', detail: n ? `${n} file(s)` : (res.error || 'no output'), model: labelFor(res.model || t.model) });
      return res;
    }));
    const byPath = new Map<string, FileRow>();
    for (const f of files) byPath.set(f.path, f);
    for (const res of results) for (const f of res.files) byPath.set(f.path, f);
    files = [...byPath.values()];
    const ok = results.filter((x) => x.files.length).map((x) => x.name);
    if (ok.length) agentNote = `\n\nBuilt in parallel by ${ok.length} agent${ok.length > 1 ? 's' : ''}: ${ok.join(', ')}.`;
  }

  const hasFiles = files.length > 0;
  let chatText = (result.chat || (hasFiles ? 'Applied your changes.' : 'Done.')) + agentNote +
    (stopped() ? '\n\n■ Stopped early — kept what was written so far.' : '');

  // Commit to GitHub (repo mode) — one commit per changed file, like the builder's push.
  const committed: string[] = [];
  const failed: string[] = [];
  if (mode === 'repo' && token && hasFiles && !stopped()) {
    await send('status', { stage: `Committing ${files.length} file(s) to ${body.repo}…` });
    const msg = `Yield Code: ${prompt.slice(0, 60).replace(/\s+/g, ' ').trim() || 'update'}`;
    for (const f of files) {
      try {
        await putRepoFile(token, body.repo!, body.branch || 'main', f.path, f.content, `${msg} (${f.path})`);
        committed.push(f.path);
        await send('committed', { path: f.path });
      } catch (e) {
        failed.push(f.path);
        await send('status', { stage: `Could not commit ${f.path}: ${shortReason(e)}` });
      }
    }
    if (failed.length) {
      chatText += committed.length
        ? `\n\n■ Committed ${committed.length} of ${files.length} file(s); ${failed.length} could not be pushed: ${failed.join(', ')}.`
        : `\n\n■ Could not push any of the ${files.length} file(s) to ${body.repo}: ${failed.join(', ')}.`;
    }
  }

  await send('done', {
    chat: chatText,
    files,
    hasCode: hasFiles,
    mode,
    repo: body.repo || null,
    branch: body.branch || null,
    committed,
    failed,
    githubUrl: mode === 'repo' && body.repo ? `https://github.com/${body.repo}` : null,
    model: model.id,
    label: model.label,
  });
}

// --- POST /api/code/run -------------------------------------------------------
async function runCodeStream(req: Request, c: Ctx): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as CodeBody;
  const prompt = (body.prompt || '').trim();
  if (!prompt) return error(400, 'prompt required');
  if (prompt.length > 12000) return error(413, 'prompt too long');
  const mode = body.mode || (body.repo ? 'repo' : body.projectId ? 'project' : 'local');

  // Project mode: reuse the full builder pipeline (agents, verify, GitHub sync,
  // version history) on a Yield project — Yield Code over your Yield app.
  if (mode === 'project') {
    if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });
    let project = body.projectId ? await getProject(c.env, body.projectId) : null;
    if (project && project.user_id !== c.user.id) return error(403, 'Not your project');
    if (!project) project = await createProject(c.env, c.user.id, prompt.slice(0, 60));
    const { response, send, close } = sse();
    const flagKey = `build:${project.id}`;
    c.ctx.waitUntil((async () => {
      await c.env.KV.put(flagKey, String(Date.now()), { expirationTtl: 1800 }).catch(() => {});
      try {
        await runBuild(c, { prompt, model: body.model, projectId: project!.id, thinking: body.thinking }, send, async () => {}, req.signal);
      } finally {
        await c.env.KV.delete(flagKey).catch(() => {});
        await close();
      }
    })());
    return response;
  }

  // Repo / local mode: the agentic edit stream. Thread the request's AbortSignal so the
  // client's Stop button (which aborts the fetch) actually cancels the in-flight model work.
  const { response, send, close } = sse();
  c.ctx.waitUntil((async () => {
    try { await runCode(c, body, send, req.signal); }
    catch (e: any) {
      console.error('code run failed:', e?.stack || e);
      await send('error', { message: `Something went wrong (${shortReason(e)}). Please try again.` });
    } finally { await close(); }
  })());
  return response;
}

// --- Dispatcher ---------------------------------------------------------------
export async function handleCode(req: Request, c: Ctx, action: string): Promise<Response> {
  if (action === 'status' && req.method === 'GET') return codeStatus(c);
  if (action === 'repos' && req.method === 'GET') return codeRepos(c);
  if (action === 'tree' && req.method === 'GET') return codeTree(c);
  if (action === 'file' && req.method === 'GET') return codeFile(c);
  if (action === 'run' && req.method === 'POST') return runCodeStream(req, c);
  return error(404, 'Unknown code endpoint');
}
