// POST /api/generate  — chat + app build (streaming SSE)
// POST /api/route     — auto-pick the best coder model for a prompt (gpt-oss-20b)
//
// The model replies conversationally AND emits structured blocks the streamer
// splits live: plain text -> 'chat'; "<think>…" -> 'thinking'; "=== file: ===" ->
// 'code' (+ saved files); "=== research: ===" -> helper AIs; "=== task: ===" ->
// parallel build agents; "=== agent/secret: ===" -> app runtime needs.

import type { Ctx, Env } from '../types';
import { sse, json, error } from '../lib/response';
import { checkPrompt } from '../lib/jailbreak';
import { gateGeneration, recordGeneration } from '../lib/usage';
import { CODER_MODELS, ROUTER_MODEL, resolveModel, endpointFor, visionModelId, type ModelDef } from '../config/models';
import { chat, chatStream, type ContentPart } from '../lib/nvidia';
import { CONVO_SYSTEM, SUBAGENT_SYSTEM, RESEARCH_SYSTEM, ENHANCE_SYSTEM, routerSystem } from '../lib/prompts';
import { PLATFORM_GUIDE } from '../lib/platformGuide';
import { verifyFiles } from '../lib/verify';
import {
  addMessage, createAgent, createProject, getProject, getProjectFiles, listAgents, listMessages,
  logUsage, saveFiles, setProjectBranding, updateAgent, type FileRow,
} from '../lib/db';
import { syncProjectToGithub } from './githubRoutes';
import { generateImage } from './media';

// A file the user attached to a build request. Images are interpreted by the vision
// model (a pre-pass that describes them); docs contribute their extracted text. They
// are one-shot context for THIS turn — not stored in the project's message history.
// (Future: when auth + GitHub linking is on, store uploaded images in the repo and
// reference them by URL instead of inlining the data.)
export interface Attachment {
  kind: 'image' | 'doc';
  name?: string;
  mime?: string;
  dataUrl?: string; // images: a data: URL the vision model can read
  text?: string;    // docs: extracted text content
}

export interface GenBody {
  prompt: string;
  model?: string;
  projectId?: string;
  thinking?: string; // reasoning effort: 'low' | 'medium' | 'high'
  enhance?: boolean; // Prompt Max: rewrite/improve the prompt before building
  attachments?: Attachment[]; // images/docs the user uploaded with this request
}

// Validate the user's chosen thinking level; default to medium (balanced — high
// reasoning with no token ceiling can run away / loop).
function effortOf(v: string | undefined): 'low' | 'medium' | 'high' {
  return v === 'low' || v === 'medium' || v === 'high' ? v : 'medium';
}

// Turn an upstream error into a short, user-facing reason for the fallback notice.
function shortReason(e: unknown): string {
  const msg = String((e as any)?.message || e || '');
  const code = msg.match(/\b(4\d\d|5\d\d)\b/)?.[1] || '';
  if (code === '401' || code === '403') return `${code} auth — check the API key`;
  if (code === '404') return '404 model id not found';
  if (code === '429') return '429 rate-limited';
  if (code === '402') return '402 payment/credits required';
  if (/abort/i.test(msg)) return 'timed out';
  return code ? `error ${code}` : (msg.slice(0, 60) || 'error');
}

// Reliable anchor models tried as the FINAL fallback when the routed model and Auto's
// re-picks all fail (e.g. a model id that 404s on this account). Ordered reliable-first
// so a build still completes rather than erroring out. (Same anchors the sub-agents use.)
const STABLE_FALLBACKS = ['glm-5.1', 'deepseek-v4-flash', 'nemotron-3-ultra'];

// Use gpt-oss-20b to choose the best coder model. Falls back to a heuristic.
export async function routeModel(c: Ctx, prompt: string, exclude: string[] = []): Promise<{ id: string; reason: string }> {
  // Pool of models Auto may choose from, minus any already-tried (failed) ones.
  const avail = CODER_MODELS.filter((m) => !exclude.includes(m.id));
  const pool = avail.length ? avail : CODER_MODELS;
  const menu = pool.map((m) => ({ id: m.id, tier: m.tier, blurb: m.blurb }));
  try {
    const router = resolveModel(ROUTER_MODEL.id);
    const ep = endpointFor(c.env, router);
    const { text } = await chat({
      baseUrl: ep.baseUrl,
      apiKey: ep.apiKey,
      apiKeyBackup: ep.apiKeyBackup,
      model: ep.modelId,
      messages: [
        { role: 'system', content: routerSystem(menu) },
        { role: 'user', content: prompt.slice(0, 4000) },
      ],
      temperature: 0,
      max_tokens: 2000,
      timeoutMs: 35000,
      // gpt-oss is a reasoning model — keep it fast so routing doesn't time out.
      extra: { reasoning_effort: 'low' },
    });
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]) as { model?: string; reason?: string };
      if (parsed.model && pool.some((x) => x.id === parsed.model)) {
        return { id: parsed.model, reason: parsed.reason || 'auto-selected' };
      }
    }
  } catch {
    /* fall through to heuristic */
  }
  // Heuristic by complexity + quality signals (no scary "fallback" wording),
  // clamped to a model that's actually in the pool (respects `exclude`).
  const has = (id: string) => pool.some((m) => m.id === id);
  const pick = (id: string, reason: string) => ({ id: has(id) ? id : pool[0].id, reason });
  const p = prompt.toLowerCase();
  const len = prompt.length;
  const wantsBest = /\b(best|polished|production|complete|full|impressive|beautiful|professional|advanced|complex)\b/.test(p);
  const multiFeature = /\b(and|with|plus|including|also)\b/g.test(p) && (p.match(/\b(and|with|plus|including|also)\b/g)?.length || 0) >= 3;
  const tinyEdit = len < 120 && /\b(change|tweak|fix|rename|color|colour|text|move|smaller|bigger|remove|add a button)\b/.test(p);
  if (tinyEdit) return pick('deepseek-v4-flash', 'quick edit');
  if (wantsBest || multiFeature || len > 600) return pick('deepseek-v4-pro', 'building for quality');
  if (len > 200) return pick('glm-5.1', 'standard build');
  return pick('deepseek-v4-flash', 'quick build');
}

export async function handleRoute(req: Request, c: Ctx): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as GenBody;
  if (!body.prompt) return error(400, 'prompt required');
  const choice = await routeModel(c, body.prompt);
  const model = resolveModel(choice.id);
  return json({ ...choice, label: model.label, tier: model.tier, pros: model.pros, cons: model.cons });
}

// Prompt Max: rewrite the user's request into a sharper, more complete build brief
// (same intent, better specified). Uses a FAST, non-reasoning model and NO reasoning
// flag so it stays snappy — the Auto router (gpt-oss) is a reasoning model and "thinks"
// far too long for a quick rewrite. Best-effort — returns the original prompt on any
// failure, a timeout, or a non-sane rewrite.
async function enhancePrompt(c: Ctx, prompt: string, heartbeat: () => Promise<void>): Promise<{ prompt: string; changed: boolean }> {
  try {
    const fast = resolveModel('deepseek-v4-flash');
    const ep = endpointFor(c.env, fast);
    const { text } = await chat({
      baseUrl: ep.baseUrl, apiKey: ep.apiKey, apiKeyBackup: ep.apiKeyBackup, model: ep.modelId,
      messages: [
        { role: 'system', content: ENHANCE_SYSTEM },
        { role: 'user', content: prompt.slice(0, 4000) },
      ],
      temperature: 0.4, max_tokens: 700, timeoutMs: 15000, // short cap + tight timeout = snappy
    });
    await heartbeat();
    // Strip any reasoning/tool-call artifacts the model may have emitted, so the rewrite
    // (which is shown in the Thinking panel AND fed to the builder) stays clean.
    const out = (text || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
      .replace(/<\/?(?:think|reasoning|tool_call|tool_response)[^>]*>/gi, '')
      .replace(/^["'`\s]+|["'`\s]+$/g, '')
      .trim();
    // Only adopt a sane rewrite: non-empty, not a refusal, not absurdly long, actually different.
    if (out && out.length >= 12 && out.length <= 6000 && out.toLowerCase() !== prompt.trim().toLowerCase()) {
      return { prompt: out, changed: true };
    }
  } catch { /* fall back to the original prompt */ }
  return { prompt, changed: false };
}

// Describe uploaded images with the vision model (a pre-pass): returns a detailed
// text description the coder can build from (match a mockup, use a logo, read a chart).
// Best-effort — returns '' on any failure so a build never breaks over an image.
async function describeImages(c: Ctx, prompt: string, images: Attachment[]): Promise<string> {
  try {
    const content: ContentPart[] = [{
      type: 'text',
      text:
        `The user is building a web app and attached ${images.length} image(s). For EACH image, describe — concretely and in detail — everything relevant to building or designing the app:\n` +
        `- If it's a UI mockup/screenshot/wireframe: the layout, every component, the color palette (with hex if you can), typography, spacing, and all visible text, so it can be recreated faithfully.\n` +
        `- If it's a logo/icon/photo/illustration: what it depicts, its style, and its colors.\n` +
        `- If it's a chart/table/diagram/document: the data, labels, and structure (transcribe values/text).\n` +
        `Number each image. Be specific and complete — this description is the ONLY thing the builder will see.\n\n` +
        `The user's request: "${prompt.slice(0, 600)}"`,
    }];
    for (const im of images) if (im.dataUrl) content.push({ type: 'image_url', image_url: { url: im.dataUrl } });
    const { text } = await chat({
      baseUrl: c.env.NVIDIA_CHAT_BASE,
      apiKey: c.env.NVIDIA_API_KEY,
      apiKeyBackup: c.env.NVIDIA_API_KEY_BACKUP || undefined,
      model: visionModelId(c.env),
      messages: [{ role: 'user', content }],
      temperature: 0.2, max_tokens: 1500, timeoutMs: 60000,
    });
    return (text || '').trim();
  } catch { return ''; }
}

// Build the one-shot context block for any images/docs the user attached this turn:
// docs contribute their extracted text; images are run through the vision model. The
// returned string (if any) is added to the build messages so the coder can use them.
async function buildAttachmentContext(
  c: Ctx, prompt: string, attachments: Attachment[] | undefined,
  send: SendFn, heartbeat: () => Promise<void>,
): Promise<string> {
  const atts = (attachments || []).slice(0, 6);
  if (!atts.length) return '';
  const parts: string[] = [];

  // Docs: include their extracted text (capped so a huge file can't blow the context).
  const docs = atts.filter((a) => a.kind === 'doc' && a.text && a.text.trim());
  let docBudget = 30000;
  for (const d of docs) {
    if (docBudget <= 0) break;
    const body = d.text!.slice(0, Math.min(12000, docBudget));
    docBudget -= body.length;
    parts.push(`Attached document "${d.name || 'document'}":\n${body}`);
  }

  // Images: describe them with the vision model (best-effort).
  const imgs = atts.filter((a) => a.kind === 'image' && a.dataUrl);
  if (imgs.length) {
    if (c.env.NVIDIA_API_KEY) {
      await send('status', { stage: `👁 Looking at ${imgs.length} image(s)…` });
      await heartbeat();
      const desc = await describeImages(c, prompt, imgs);
      await heartbeat();
      if (desc) {
        parts.push(`What the user's attached image(s) show (interpret and use these — e.g. match the design, use the content):\n${desc}`);
        await send('thinking', `👁 From your image(s):\n\n${desc}\n\n`);
      } else {
        parts.push(`The user attached ${imgs.length} image(s), but they couldn't be read this time — ask them to describe what's in them if it matters.`);
      }
    } else {
      parts.push(`The user attached ${imgs.length} image(s) (image understanding isn't configured).`);
    }
  }

  if (!parts.length) return '';
  return `The user attached files to THIS request. Use them as you build:\n\n${parts.join('\n\n')}`;
}

// Fallback: pull files out of a model reply that didn't use the === file: ===
// format — markdown ```code fences, or a single raw HTML document.
function guessName(before: string, lang: string, only: boolean): string {
  const tail = before.split('\n').slice(-3).join('\n');
  const named = tail.match(/([\w./-]+\.(?:html|css|js|mjs|json|svg|md|ts|jsx|tsx))/i);
  if (named) return named[1].replace(/^\/+/, '');
  const l = (lang || '').toLowerCase();
  if (l === 'html' || (only && !l)) return 'index.html';
  if (l === 'css') return 'styles.css';
  if (l === 'js' || l === 'javascript') return 'app.js';
  if (l === 'json') return 'data.json';
  return `file.${l || 'txt'}`;
}

// Guess a filename for a bare ```lang code fence (used live when a model ignores the
// "=== file: ===" format). Honors an explicit name in the fence (```index.html) or in
// the preceding chat line, else maps the language to a sensible default file.
function fenceGuess(token: string, recentChat: string[]): string {
  const t = ((token || '').trim().split(':').pop() || '').trim();
  if (/\.[A-Za-z0-9]+$/.test(t)) return t.replace(/^\/+/, '');
  const tail = recentChat.slice(-3).join('\n');
  const named = tail.match(/([\w./-]+\.(?:html?|css|js|mjs|json|svg|md|ts|jsx|tsx))/i);
  if (named) return named[1].replace(/^\/+/, '');
  const l = t.toLowerCase();
  if (l === 'html' || l === '') return 'index.html';
  if (l === 'css') return 'styles.css';
  if (l === 'js' || l === 'javascript' || l === 'jsx') return 'app.js';
  if (l === 'json') return 'data.json';
  if (l === 'svg') return 'image.svg';
  return `file.${l}`;
}

function extractFilesFromText(text: string): { chat: string; files: FileRow[] } {
  // Tolerant of a missing newline before the closing fence and of an UNTERMINATED
  // fence (model truncated) — otherwise that code is silently dropped → empty build.
  const fenceRe = /```([a-zA-Z0-9.\-_/]*)[ \t]*\n([\s\S]*?)(?:\n?```|$)/g;
  const blocks: { lang: string; code: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text))) blocks.push({ lang: m[1], code: m[2], index: m.index });
  if (blocks.length) {
    const used = new Set<string>();
    const files: FileRow[] = blocks.map((b, i) => {
      let path = guessName(text.slice(0, b.index), b.lang, blocks.length === 1);
      while (used.has(path)) path = path.replace(/(\.\w+)$/, `-${i}$1`);
      used.add(path);
      return { path, content: b.code };
    });
    const chat = text.replace(fenceRe, '').replace(/\n{3,}/g, '\n\n').trim();
    return { chat, files };
  }
  // Raw HTML document with no fences.
  const start = text.search(/<!DOCTYPE html>|<html[\s>]/i);
  if (start !== -1) {
    return { chat: text.slice(0, start).trim() || 'Here is your app.', files: [{ path: 'index.html', content: text.slice(start).trim() }] };
  }
  return { chat: text.trim(), files: [] };
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
export interface TaskReq { name: string; model: string | null; instructions: string }
export interface ResearchReq { name: string; model: string | null; instructions: string }

// Streaming parser: chat text streams live; "=== file: path ===" starts a file,
// "=== agent: Name | model ===" declares a runtime agent, "=== secret: NAME — why ==="
// requests a secret, "=== task: Name | model ===" delegates a build sub-task to a
// parallel agent (run after the orchestrator stream ends).
function makeFileStreamer(send: (event: string, data: unknown) => Promise<void>, agentLabel = 'Yield') {
  const FILE = /^={2,}\s*file:\s*(.+?)\s*={2,}\s*$/i;
  const SECRET = /^={2,}\s*secret:\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:[—:-]\s*(.*?))?\s*={2,}\s*$/i;
  const AGENT = /^={2,}\s*agent:\s*([^|=]+?)\s*(?:\|\s*([^=]+?)\s*)?={2,}\s*$/i;
  const TASK = /^={2,}\s*task:\s*([^|=]+?)\s*(?:\|\s*([^=]+?)\s*)?={2,}\s*$/i;
  const RESEARCH = /^={2,}\s*research:\s*([^|=]+?)\s*(?:\|\s*([^=]+?)\s*)?={2,}\s*$/i;
  // Closing recap the model emits AFTER all files — flips parsing back to chat so the
  // text streams into the chat bubble (a "here's what I built / next steps" message)
  // instead of being appended to the last file.
  const SUMMARY = /^={2,}\s*(?:summary|recap|done|notes)\s*={2,}\s*$/i;
  // "=== name: My App ===" sets the auto app name; "=== logo ===" starts an inline-SVG
  // app logo block (captured until the next marker). Both are used to brand a new app.
  const NAME = /^={2,}\s*name:\s*(.+?)\s*={2,}\s*$/i;
  const LOGO = /^={2,}\s*logo\s*={2,}\s*$/i;
  // "=== ask: Question? | Option A | Option B ===" — a clarifying question with optional
  // clickable choices; surfaced as an 'ask' event (a pop-up) and produces no files.
  const ASK = /^={2,}\s*ask:\s*(.+?)\s*={2,}\s*$/i;
  // "=== image: a sunset over mountains ===" — generate an illustration to show in chat.
  const IMAGE = /^={2,}\s*image:\s*(.+?)\s*={2,}\s*$/i;
  const imagePrompts: string[] = [];
  let asked = false;
  let buf = '';
  let mode: 'chat' | 'file' | 'agent' | 'task' | 'research' | 'logo' = 'chat';
  let inThink = false;
  let appName = '';
  const logoLines: string[] = [];
  let fenceOpen = false; // inside a ```-fenced file we inferred from a bare code fence
  let curFile: { path: string; lines: string[] } | null = null;
  let curAgent: { name: string; model: string | null; lines: string[] } | null = null;
  let curTask: { name: string; model: string | null; lines: string[] } | null = null;
  let curResearch: { name: string; model: string | null; lines: string[] } | null = null;
  let lastStatus = '';
  const chatLines: string[] = [];
  const thinkLines: string[] = []; // raw <think> text, kept only to recover code a reasoning model buried there
  const files: { path: string; lines: string[] }[] = [];
  const agents: { name: string; model: string | null; lines: string[] }[] = [];
  const tasks: { name: string; model: string | null; lines: string[] }[] = [];
  const research: { name: string; model: string | null; lines: string[] }[] = [];
  const secrets: SecretReq[] = [];

  async function handleLine(line: string): Promise<void> {
    // Route <think>…</think> reasoning to the Thinking panel.
    if (inThink) {
      const close = line.indexOf('</think>');
      if (close === -1) { thinkLines.push(line); await send('thinking', line + '\n'); return; }
      const before = line.slice(0, close);
      if (before) { thinkLines.push(before); await send('thinking', before + '\n'); }
      inThink = false;
      const after = line.slice(close + 8);
      if (after.trim()) await handleLine(after);
      return;
    }
    const open = line.indexOf('<think>');
    if (open !== -1) {
      const before = line.slice(0, open);
      if (before.trim()) await handleLine(before);
      inThink = true;
      await handleLine(line.slice(open + 7)); // remainder is inside <think>
      return;
    }
    // Note: we do NOT short-circuit on a <tool_call> here — an unclosed one would eat
    // the whole build (files included). Tool-call artifacts are stripped from the final
    // chat text in result() instead, which can never drop file output.

    let m;
    if ((m = line.match(FILE))) {
      mode = 'file';
      curFile = { path: m[1].trim().replace(/^\/+/, ''), lines: [] };
      files.push(curFile);
      if (curFile.path !== lastStatus) { lastStatus = curFile.path; await send('status', { stage: `Writing ${curFile.path}` }); }
      await send('code', { agent: agentLabel, path: curFile.path, delta: '', start: true });
      return;
    }
    if ((m = line.match(RESEARCH))) {
      mode = 'research';
      curResearch = { name: m[1].trim().slice(0, 80), model: m[2] ? m[2].trim() : null, lines: [] };
      research.push(curResearch);
      await send('status', { stage: `Helper AI: ${curResearch.name}` });
      return;
    }
    if ((m = line.match(TASK))) {
      mode = 'task';
      curTask = { name: m[1].trim().slice(0, 80), model: m[2] ? m[2].trim() : null, lines: [] };
      tasks.push(curTask);
      await send('status', { stage: `Planning agent: ${curTask.name}` });
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
    if ((m = line.match(NAME))) { if (!appName) appName = m[1].trim().slice(0, 60); return; } // single-line
    if ((m = line.match(IMAGE))) { const p = m[1].trim(); if (p && imagePrompts.length < 4) imagePrompts.push(p); return; } // single-line
    if ((m = line.match(ASK))) { // single-line clarifying question with optional choices
      const parts = m[1].split('|').map((s) => s.trim()).filter(Boolean);
      const question = parts[0] || '';
      if (question) { asked = true; await send('ask', { question, options: parts.slice(1, 7) }); }
      return;
    }
    if (LOGO.test(line)) { mode = 'logo'; return; } // start inline-SVG logo block
    if (SUMMARY.test(line)) { mode = 'chat'; fenceOpen = false; curFile = null; await send('status', { stage: 'Wrapping up…' }); return; }
    // Markdown code fences: some models ignore "=== file: ===" and wrap code in ```lang
    // blocks. Route that code into the CODE section live (as files) instead of dumping
    // it into the chat. Also strips a stray ``` wrapper inside a real === file === block.
    const fenceM = line.match(/^\s*```([A-Za-z0-9.\-_/:+]*)\s*$/);
    if (fenceM) {
      if (mode === 'file' && fenceOpen) { fenceOpen = false; mode = 'chat'; curFile = null; return; } // closing fence
      if (mode === 'chat') { // opening fence -> start an inferred file
        let path = fenceGuess(fenceM[1], chatLines);
        if (files.some((f) => f.path === path)) {
          const dot = path.lastIndexOf('.');
          const base = dot > 0 ? path.slice(0, dot) : path;
          const ext = dot > 0 ? path.slice(dot) : '';
          let n = 2;
          while (files.some((f) => f.path === `${base}-${n}${ext}`)) n++;
          path = `${base}-${n}${ext}`;
        }
        curFile = { path, lines: [] }; files.push(curFile); mode = 'file'; fenceOpen = true;
        if (path !== lastStatus) { lastStatus = path; await send('status', { stage: `Writing ${path}` }); }
        await send('code', { agent: agentLabel, path, delta: '', start: true });
        return;
      }
      if (mode === 'file' && !fenceOpen) return; // stray ``` wrapper inside a === file === block — drop it
    }
    if (mode === 'chat') { chatLines.push(line); await send('chat', line + '\n'); }
    else if (mode === 'file' && curFile) { curFile.lines.push(line); await send('code', { agent: agentLabel, path: curFile.path, delta: line + '\n' }); }
    else if (mode === 'agent' && curAgent) curAgent.lines.push(line);
    else if (mode === 'task' && curTask) curTask.lines.push(line);
    else if (mode === 'research' && curResearch) curResearch.lines.push(line);
    else if (mode === 'logo') logoLines.push(line);
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
    // Clear ALL parse state before a retry — not just the transient cursors but the
    // accumulated output — so a partial/empty attempt can't leave stale or duplicate
    // entries that survive into the retry's result. Only ever called when nothing
    // worth keeping was produced (see `produced`).
    reset() {
      buf = ''; mode = 'chat'; inThink = false; fenceOpen = false; lastStatus = ''; appName = ''; asked = false;
      curFile = curAgent = curTask = curResearch = null;
      files.length = chatLines.length = agents.length = tasks.length = research.length = secrets.length = thinkLines.length = logoLines.length = imagePrompts.length = 0;
    },
    // "Produced something worth keeping": real file content, real chat, or a delegation.
    // A bare "=== file: path ===" header with no body must NOT count — otherwise a
    // dropped connection right after a header would disable the retry/fallback ladder
    // and then get filtered out to an empty build.
    get produced() {
      return files.some((f) => f.lines.some((l) => l.trim())) || chatLines.some((l) => l.trim()) ||
        agents.length > 0 || tasks.length > 0 || research.length > 0;
    },
    result() {
      // Drop reasoning-model scratchpads if any leaked into the text.
      let chat = chatLines.join('\n')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
        .replace(/<\/?(?:think|reasoning|tool_call|tool_response)[^>]*>/gi, '')
        .trim();
      let fs: FileRow[] = files
        .map((f) => ({ path: f.path, content: cleanFile(f.lines.join('\n')) }))
        .filter((f) => f.path && f.content.trim());
      const ags: AgentReq[] = agents
        .map((a) => ({ name: a.name, model: a.model, system_prompt: cleanFile(a.lines.join('\n')) }))
        .filter((a) => a.name && a.system_prompt.trim());
      const tks: TaskReq[] = tasks
        .map((t) => ({ name: t.name, model: t.model, instructions: cleanFile(t.lines.join('\n')) }))
        .filter((t) => t.name && t.instructions.trim())
        .slice(0, 6); // cap parallel agents
      const rsc: ResearchReq[] = research
        .map((r) => ({ name: r.name, model: r.model, instructions: cleanFile(r.lines.join('\n')) }))
        .filter((r) => r.name && r.instructions.trim())
        .slice(0, 4); // cap helper AIs
      // The model didn't use === file: === — recover code from fences / raw HTML.
      // (Only when no tasks/research were delegated; those produce the files instead.)
      if (fs.length === 0 && tks.length === 0 && rsc.length === 0) {
        // Recover code from the chat text; as a last resort, from the reasoning text
        // (some models emit the whole app as fences/raw HTML inside <think>).
        let fb = extractFilesFromText(chat);
        if (!fb.files.length && thinkLines.length) fb = extractFilesFromText(thinkLines.join('\n'));
        if (fb.files.length) { fs = fb.files; chat = chat || fb.chat || 'Here is your app.'; }
      }
      return { chat, files: fs, hasFiles: fs.length > 0, agents: ags, secrets, tasks: tks, research: rsc, name: appName, logo: sanitizeLogo(logoLines.join('\n')), asked, images: imagePrompts.slice(0, 4) };
    },
  };
}

// Pull a clean, safe inline SVG out of a "=== logo ===" block: keep only the <svg>…</svg>,
// strip <script>/<foreignObject> and on* handlers, and cap size. Returns '' if none.
function sanitizeLogo(text: string): string {
  const m = text.match(/<svg[\s\S]*?<\/svg>/i);
  if (!m) return '';
  let svg = m[0]
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '');
  if (svg.length > 8000) return ''; // a logo should be tiny; reject anything suspiciously large
  return svg.trim();
}

export type SendFn = (event: string, data: unknown) => Promise<void>;

// Run one helper/research AI (from a "=== research: ===" block). It does NOT write
// code — it returns findings/analysis (text) that the coder then builds with.
async function runResearchAgent(env: Env, req: ResearchReq, context: string, effort: 'low' | 'medium' | 'high', heartbeat: () => Promise<void> = async () => {}): Promise<{ name: string; findings: string }> {
  const messages = [
    { role: 'system' as const, content: RESEARCH_SYSTEM },
    { role: 'user' as const, content: `Context: ${context}\n\nResearch task ("${req.name}"):\n${req.instructions}` },
  ];
  const order = [req.model, 'glm-5.1', 'deepseek-v4-flash'].filter(Boolean) as string[];
  const seen = new Set<string>();
  for (const cid of order) {
    const model = resolveModel(cid);
    if (seen.has(model.id)) continue; // dedupe on the RESOLVED id (a bad id resolves to the default)
    seen.add(model.id);
    const ep = endpointFor(env, model);
    for (const eff of [effort, null] as const) {
      await heartbeat();
      try {
        const { text } = await chat({
          baseUrl: ep.baseUrl, apiKey: ep.apiKey, apiKeyBackup: ep.apiKeyBackup, model: ep.modelId, messages,
          temperature: 0.4, max_tokens: 8000, timeoutMs: 150000,
          ...(eff ? { extra: { reasoning_effort: eff } } : {}),
        });
        await heartbeat();
        if (text && text.trim()) return { name: req.name, findings: text.trim() };
      } catch { /* try plain, then next model */ }
    }
  }
  return { name: req.name, findings: '(no findings — proceed with your best judgement)' };
}

// Run one parallel build agent (from a "=== task: ===" block). It streams its code
// live (tagged with the agent's name via `send`) and returns the file(s) it built.
// Falls back through stable models so one bad model id doesn't waste the agent.
async function runSubAgent(env: Env, task: TaskReq, sharedContext: string, send: SendFn, effort: 'low' | 'medium' | 'high', heartbeat: () => Promise<void> = async () => {}): Promise<{ name: string; files: FileRow[]; error?: string; model?: string }> {
  const messages = [
    { role: 'system' as const, content: SUBAGENT_SYSTEM },
    { role: 'system' as const, content: sharedContext },
    { role: 'user' as const, content: `Your task ("${task.name}"):\n\n${task.instructions}` },
  ];
  const order = [task.model, 'deepseek-v4-flash', 'glm-5.1'].filter(Boolean) as string[];
  const seen = new Set<string>();
  let lastErr = 'agent produced nothing';
  let usedModel = '';
  for (const cid of order) {
    const model = resolveModel(cid);
    if (seen.has(model.id)) continue; // dedupe on the RESOLVED id
    seen.add(model.id);
    usedModel = model.id;
    const ep = endpointFor(env, model);
    // Try with the chosen reasoning effort first; if the model rejects the flag,
    // retry plainly (null).
    for (const eff of [effort, null] as const) {
      // Forward only the agent's live code (already tagged with its name).
      const sub = makeFileStreamer(async (ev, d) => { if (ev === 'code') await send('code', d); }, task.name);
      try {
        await chatStream(
          {
            baseUrl: ep.baseUrl, apiKey: ep.apiKey, apiKeyBackup: ep.apiKeyBackup, model: ep.modelId, messages,
            temperature: 0.3, max_tokens: 30000, timeoutMs: 300000,
            ...(eff ? { extra: { reasoning_effort: eff } } : {}),
          },
          async (delta) => { await sub.feed(delta); await heartbeat(); },
        );
        await sub.end();
        const files = sub.result().files;
        if (files.length) return { name: task.name, files, model: model.id };
        lastErr = `no files from ${model.id}`;
        break; // got a clean response but no files — move to the next model
      } catch (e: any) {
        // Keep partial output if this attempt already wrote file(s) before erroring
        // (e.g. a slow timeout) instead of throwing the work away.
        try { await sub.end(); } catch { /* ignore */ }
        const partial = sub.result().files;
        if (partial.length) return { name: task.name, files: partial, model: model.id };
        lastErr = String(e?.message || e);
        // effort failed -> loop retries plainly; plain failed -> next model
      }
    }
  }
  return { name: task.name, files: [], error: lastErr, model: usedModel };
}

// Verify the finished app actually holds together and auto-repair it once if not.
// Static checks (broken links/missing pages, placeholder text, dead links, raw
// dialogs) run with zero model calls; only if a HARD issue is found do we spend one
// repair pass asking the model to fix exactly those problems and re-emit the files.
// This is what makes multi-page apps "work" — it catches nav links to pages that
// were never built, scripts pointing at missing files, and leftover placeholders.
async function verifyAndRepair(
  env: Env, model: ModelDef, files: FileRow[], send: SendFn,
  heartbeat: () => Promise<void>, effort: 'low' | 'medium' | 'high',
): Promise<FileRow[]> {
  if (!files.length) return files;
  // Up to 2 repair passes: re-verify after each so the app actually converges to a
  // complete, working state (one pass often leaves or re-introduces an issue).
  for (let pass = 1; pass <= 2; pass++) {
    const { hardIssues, softIssues } = verifyFiles(files);
    if (!hardIssues.length) {
      await send('status', { stage: 'Verified — checks passed ✓' });
      return files;
    }
    await send('status', { stage: `Verifying — fixing ${hardIssues.length} issue(s)…` });
    await send('worker', { name: 'Verify', kind: 'verify', status: 'start', model: model.label });
    await heartbeat();
    const dump = files.map((f) => `=== file: ${f.path} ===\n${f.content}`).join('\n\n');
    const messages = [
      { role: 'system' as const, content: CONVO_SYSTEM },
      { role: 'system' as const, content: PLATFORM_GUIDE },
      {
        role: 'user' as const,
        content:
          `Here is the app that was just built:\n\n${dump}\n\n` +
          `Automated verification found problems that MUST be fixed so the app actually works:\n` +
          [...hardIssues, ...softIssues].map((i) => `- ${i}`).join('\n') +
          `\n\nFix EVERY issue:\n` +
          `- If a file was cut off / truncated, or left parts out ("rest of the code", "// ..."), RE-OUTPUT THAT WHOLE FILE from its first line to its last — never abbreviate or summarize code.\n` +
          `- Fill any empty file with its real, working code.\n` +
          `- Create any page or file that a link/script references but is missing — build it FULLY (no "coming soon"). Every nav link must lead to a real, complete page.\n` +
          `- Make every button, link and form do something real; remove dead links (href="#") and raw dialogs.\n` +
          `- Remove ALL placeholder/stub text; use real content. Do NOT add mock/sample data unless the app was explicitly asked for it.\n` +
          `Re-output IN FULL every file you change or add, using === file: path === blocks. Output ONLY files — no chat, no <think>.`,
      },
    ];
    const repair = makeFileStreamer(async (ev, d) => { if (ev === 'code') await send('code', d); }, 'Verify');
    const ep = endpointFor(env, model);
    for (const eff of [effort, null] as const) {
      try {
        await chatStream(
          {
            baseUrl: ep.baseUrl, apiKey: ep.apiKey, apiKeyBackup: ep.apiKeyBackup, model: ep.modelId, messages,
            temperature: 0.2, top_p: 0.95, max_tokens: 40000, timeoutMs: 600000,
            ...(eff ? { extra: { reasoning_effort: eff } } : {}),
          },
          async (delta) => { await repair.feed(delta); await heartbeat(); },
          async (rr) => { await send('thinking', rr); await heartbeat(); },
        );
        break;
      } catch { if (repair.produced) break; /* effort rejected -> retry plain -> give up */ }
    }
    await repair.end();
    const fixed = repair.result().files;
    if (!fixed.length) { await send('worker', { name: 'Verify', kind: 'verify', status: 'done', model: model.label }); return files; }
    const byPath = new Map(files.map((f) => [f.path, f] as const));
    for (const f of fixed) byPath.set(f.path, f);
    files = [...byPath.values()];
    const after = verifyFiles(files);
    await send('worker', { name: 'Verify', kind: 'verify', status: after.hardIssues.length ? 'fail' : 'done', detail: `${fixed.length} file(s)`, model: model.label });
    if (!after.hardIssues.length) { await send('status', { stage: 'Verified — all checks passed ✓' }); return files; }
    // else: issues remain — loop once more for a targeted second pass.
  }
  await send('status', { stage: 'Verified — applied best-effort fixes' });
  return files;
}

// The full build pipeline: jailbreak guard -> usage gate -> model route -> stream
// -> parse files/agents/secrets -> persist (D1 + GitHub) -> 'done'. It streams SSE
// events via `send` and calls `heartbeat` periodically (to keep a "building" flag
// fresh). It has no dependency on the HTTP request lifetime, so it can run inside a
// Durable Object (survives tab close/refresh) or inline (best-effort) as a fallback.
export async function runBuild(
  c: Ctx,
  body: GenBody,
  send: SendFn,
  heartbeat: () => Promise<void> = async () => {},
): Promise<void> {
  const prompt = (body.prompt || '').trim();
  try {
    await send('status', { stage: 'Screening prompt' });
    await heartbeat();

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

    // 2.5) Prompt Max: rewrite the prompt into a better build brief before building.
    let buildPrompt = prompt;
    if (body.enhance && prompt.length >= 8) {
      await send('status', { stage: '⚡ Prompt Max — improving your prompt…' });
      await heartbeat();
      const enh = await enhancePrompt(c, prompt, heartbeat);
      buildPrompt = enh.prompt;
      if (enh.changed) {
        // Show what it became (Thinking panel) so the user can see what was built from.
        await send('thinking', `⚡ Prompt Max rewrote your request as:\n\n${buildPrompt}\n\n`);
        await send('status', { stage: '⚡ Prompt Max applied' });
      }
    }

    // 3) Resolve model (Auto -> route via gpt-oss-20b).
    let modelId = body.model || 'auto';
    let routeReason: string | undefined;
    if (modelId === 'auto') {
      await send('status', { stage: 'Picking the best model' });
      const choice = await routeModel(c, buildPrompt);
      modelId = choice.id;
      routeReason = choice.reason;
    }
    const model = resolveModel(modelId);

    // 4) Project (normally pre-created by the caller; resolve it here).
    let project = body.projectId ? await getProject(c.env, body.projectId) : null;
    if (project && c.user && project.user_id !== c.user.id) {
      await send('error', { message: 'Not your project.' });
      return;
    }
    if (!project && c.user) project = await createProject(c.env, c.user.id, prompt.slice(0, 60));
    await heartbeat();

    // Persist the user's prompt to history IMMEDIATELY — before the risky model work —
    // so it is never lost if the build fails mid-flight. (A thrown build used to save
    // NOTHING: the prompt vanished and the whole turn looked like "code isn't saving".)
    let userMsgSaved = false;
    if (project && c.user) {
      try { await addMessage(c.env, { project_id: project.id, role: 'user', content: prompt }); userMsgSaved = true; }
      catch (e) { console.error('early user-message save failed:', e); }
    }

    await send('meta', { model: model.id, label: model.label, projectId: project?.id ?? null, routeReason });

    // 5) Build the message list: system + platform reference + current app +
    //    recent history + new turn. The platform guide tells the model exactly how
    //    Yield's runtime (entities, agents, secrets, image, workers) actually works.
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: CONVO_SYSTEM },
      { role: 'system', content: PLATFORM_GUIDE },
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
    // Images/docs the user attached this turn: docs add their text, images are described
    // by the vision model. Added as context so the coder can build from them.
    const attachCtx = await buildAttachmentContext(c, prompt, body.attachments, send, heartbeat);
    if (attachCtx) messages.push({ role: 'system', content: attachCtx });
    messages.push({ role: 'user', content: buildPrompt });

    // 6) Stream: separate chat from multi-file output. Coder models run with MAX
    //    reasoning (reasoning_effort: high) and a long timeout for thorough code.
    //    Resilience: if a model rejects the reasoning flag we retry it plainly; if
    //    it errors before producing anything we fall back to a stable model; and if
    //    it errors AFTER producing code (e.g. a slow timeout) we KEEP the partial
    //    result instead of throwing it away.
    const wantEffort = effortOf(body.thinking); // user-chosen thinking level
    let activeModel = model;

    // One orchestrator pass: stream code into a fresh parser, with reasoning-flag
    // and stable-model fallbacks, keeping any partial output a slow model produced.
    const streamOnce = async () => {
      const streamer = makeFileStreamer(send);
      const streamWith = async (mdef: typeof model, eff: 'low' | 'medium' | 'high' | null) => {
        const ep = endpointFor(c.env, mdef);
        await chatStream(
          {
            baseUrl: ep.baseUrl, apiKey: ep.apiKey, apiKeyBackup: ep.apiKeyBackup, model: ep.modelId, messages,
            temperature: 0.3, top_p: 0.95, max_tokens: 40000, timeoutMs: 600000,
            ...(eff ? { extra: { reasoning_effort: eff } } : {}),
          },
          async (delta) => { await streamer.feed(delta); await heartbeat(); },
          async (rr) => { await send('thinking', rr); await heartbeat(); },
        );
      };
      try {
        await streamWith(activeModel, wantEffort);
      } catch (e) {
        if (streamer.produced) {
          await send('status', { stage: 'Finalizing what was built…' }); // keep partial output
        } else {
          // The selected/routed model failed (unavailable id, rate limit, etc.). Retry
          // it PLAINLY first (it may have only rejected the reasoning flag). If it still
          // fails, DON'T silently downgrade to a fixed flash model — let Auto (gpt-oss)
          // intelligently pick a DIFFERENT model, excluding any we've already tried.
          const selectedLabel = activeModel.label;
          let selErr: unknown = e;
          let ok = false;
          streamer.reset(); // clear any partial-line state before retrying
          try { await streamWith(activeModel, null); ok = true; }
          catch (e2) { if (streamer.produced) ok = true; else selErr = e2; }
          if (!ok && !streamer.produced) {
            const reason = shortReason(selErr);
            const tried = new Set<string>([activeModel.id]);
            for (let attempt = 0; attempt < 3 && !ok && !streamer.produced; attempt++) {
              const choice = await routeModel(c, prompt, [...tried]);
              if (tried.has(choice.id)) break; // Auto has nothing new to suggest
              tried.add(choice.id);
              const fb = resolveModel(choice.id);
              activeModel = fb;
              await send('status', { stage: `${selectedLabel} unavailable (${reason}) — Auto picked ${fb.label}` });
              await send('meta', { model: fb.id, label: fb.label, projectId: project?.id ?? null, routeReason: `${selectedLabel} unavailable (${reason}); Auto chose ${fb.label}: ${choice.reason}` });
              streamer.reset();
              try { await streamWith(fb, null); ok = true; }
              catch (e3) { if (streamer.produced) ok = true; else selErr = e3; }
            }
            // LAST RESORT: Auto's picks can all be unavailable (a model id that 404s on
            // this account, etc.), which would otherwise sink the whole build. Always end
            // on the most reliable anchor models so a build still completes. These are the
            // same stable fallbacks the sub-agents/research use.
            for (const sid of STABLE_FALLBACKS) {
              if (ok || streamer.produced) break;
              if (tried.has(sid)) continue;
              tried.add(sid);
              const fb = resolveModel(sid);
              activeModel = fb;
              await send('status', { stage: `Retrying on ${fb.label}…` });
              await send('meta', { model: fb.id, label: fb.label, projectId: project?.id ?? null, routeReason: `${selectedLabel} unavailable (${reason}); retrying on ${fb.label}` });
              streamer.reset();
              try { await streamWith(fb, null); ok = true; }
              catch (e4) { if (streamer.produced) ok = true; else selErr = e4; }
            }
          }
          if (!ok && !streamer.produced) throw selErr;
        }
      }
      await streamer.end();
      return streamer.result();
    };

    let result = await streamOnce();

    // Helper AIs: if the coder asked to research/plan a tricky part first
    // ("=== research: Name ==="), run those helpers in parallel, surface their
    // findings in the Thinking panel, then build again WITH the findings. Bounded
    // to a single research round so it always converges to code.
    if (result.research.length) {
      const reqs = result.research;
      await send('status', { stage: `Consulting ${reqs.length} helper AI(s)…` });
      await heartbeat();
      const rctx = `App being built. Goal:\n${prompt.slice(0, 1400)}`;
      const findings = await Promise.all(reqs.map(async (r) => {
        await send('status', { stage: `🔬 ${r.name} researching…` });
        await send('research', { name: r.name, status: 'working' });
        const f = await runResearchAgent(c.env, r, rctx, wantEffort, heartbeat);
        await send('research', { name: r.name, findings: f.findings });
        await heartbeat();
        return f;
      }));
      messages.push({ role: 'assistant', content: (result.chat || 'Let me research this first.').slice(0, 2000) });
      messages.push({
        role: 'user',
        content:
          'Findings from your helper AIs:\n\n' +
          findings.map((f) => `### ${f.name}\n${f.findings}`).join('\n\n') +
          '\n\nNow build the COMPLETE app using these findings. Do not request more research — write the files.',
      });
      const pass1 = result;
      const pass2 = await streamOnce();
      // Merge so anything the first pass already produced isn't lost (the second
      // pass is authoritative on conflicts).
      const fileMap = new Map<string, FileRow>();
      for (const f of pass1.files) fileMap.set(f.path, f);
      for (const f of pass2.files) fileMap.set(f.path, f);
      const agentMap = new Map<string, AgentReq>();
      for (const a of [...pass1.agents, ...pass2.agents]) agentMap.set(a.name, a);
      const secretMap = new Map<string, SecretReq>();
      for (const s of [...pass1.secrets, ...pass2.secrets]) secretMap.set(s.name, s);
      result = {
        chat: pass2.chat || pass1.chat,
        files: [...fileMap.values()],
        hasFiles: fileMap.size > 0,
        agents: [...agentMap.values()],
        secrets: [...secretMap.values()],
        tasks: pass2.tasks.length ? pass2.tasks : pass1.tasks,
        research: [],
        name: pass2.name || pass1.name,
        logo: pass2.logo || pass1.logo,
        asked: pass2.asked || pass1.asked,
        images: [...pass1.images, ...pass2.images].slice(0, 4),
      };
    }

    let chatBody = result.chat;
    const agentReqs = result.agents;
    let files = result.files;

    // Fan out: if the orchestrator delegated "=== task: ===" blocks, run them as
    // parallel build agents — each streams its own code live (tagged by name).
    let agentNote = '';
    if (result.tasks.length) {
      await send('status', { stage: `Launching ${result.tasks.length} build agents…` });
      await heartbeat();
      const sharedContext =
        `You are part of a team building ONE app. App goal:\n${prompt.slice(0, 1500)}\n\n` +
        `Orchestrator plan/notes:\n${(chatBody || '').slice(0, 2000)}` +
        (files.length ? `\n\nThe orchestrator already wrote these files — do NOT recreate them: ${files.map((f) => f.path).join(', ')}` : '');
      // Mark every agent as working up-front (roster appears immediately), then
      // flip each to done/failed — tagged with the MODEL each agent is running on,
      // so the roster shows which AI is doing the work (not just the agent's name).
      const labelFor = (id?: string | null) => resolveModel(id || 'deepseek-v4-flash').label;
      for (const t of result.tasks) await send('worker', { name: t.name, kind: 'build', status: 'start', model: labelFor(t.model) });
      const results = await Promise.all(result.tasks.map(async (t) => {
        await send('status', { stage: `Agent ${t.name} working…` });
        const res = await runSubAgent(c.env, t, sharedContext, send, wantEffort, heartbeat);
        const n = res.files.length;
        await send('worker', { name: t.name, kind: 'build', status: n ? 'done' : 'fail', detail: n ? `${n} file(s)` : (res.error || 'no output'), model: labelFor(res.model || t.model) });
        await send('status', { stage: n ? `Agent ${t.name}: ${n} file(s) ✓` : `Agent ${t.name}: no output` });
        return res;
      }));
      await heartbeat();
      // Merge: orchestrator's own files first, then each agent's files (by path).
      const byPath = new Map<string, FileRow>();
      for (const f of files) byPath.set(f.path, f);
      for (const res of results) for (const f of res.files) byPath.set(f.path, f);
      files = [...byPath.values()];
      const ok = results.filter((x) => x.files.length).map((x) => x.name);
      if (ok.length) agentNote = `\n\n🤖 Built in parallel by ${ok.length} agent${ok.length > 1 ? 's' : ''}: ${ok.join(', ')}.`;
    }

    // GUARANTEED OUTPUT: an app-builder result with NO files is almost always a failed
    // build — the model returned only prose, delegated to agents that produced nothing,
    // or its code was unparseable. Do ONE direct build pass to recover, regardless of
    // whether it delegated. Skip only for obvious small-talk, which legitimately has no
    // files (otherwise "thanks!" would fabricate an app).
    const chitchat = /^(thanks?|thank you|ok(ay)?|cool|nice|great|awesome|hi|hello|hey|yo|yes|no|sure|👍|🙏)[\s!.?]*$/i.test(prompt.trim());
    // Don't force a build when the model deliberately asked a clarifying question.
    if (!files.length && !chitchat && !result.asked) {
      await send('status', { stage: 'No code yet — building it directly…' });
      await heartbeat();
      messages.push({ role: 'assistant', content: (chatBody || 'I planned the app.').slice(0, 1500) });
      messages.push({
        role: 'user',
        content:
          'No code was produced yet. Do NOT delegate to build agents and do NOT request research — ' +
          'write the COMPLETE app YOURSELF right now: output every file in full using "=== file: path ===" ' +
          'blocks. Every button/link/page must work; no placeholders; no mock data unless I asked for it.',
      });
      const direct = await streamOnce();
      if (direct.files.length) {
        const byPath = new Map<string, FileRow>();
        for (const f of files) byPath.set(f.path, f);
        for (const f of direct.files) byPath.set(f.path, f);
        files = [...byPath.values()];
        chatBody = chatBody || direct.chat;
        for (const a of direct.agents) if (!agentReqs.find((x) => x.name === a.name)) agentReqs.push(a);
      }
    }

    // Verify the finished app and auto-repair broken links / missing pages /
    // placeholders once (best-effort — never let it sink a delivered build).
    if (files.length) {
      try { files = await verifyAndRepair(c.env, activeModel, files, send, heartbeat, wantEffort); }
      catch (e) { console.error('verify step failed:', e); }
    }

    const hasFiles = files.length > 0;
    const chatText = (chatBody || (hasFiles ? 'Updated your app.' : 'Done.')) + agentNote;

    // 7) Create/update AI-declared agents (project-scoped). Best-effort — a DB
    //    hiccup here must NOT prevent the 'done' event (which carries the files),
    //    or a reconnecting tab would see no code. (Secrets are no longer stored by
    //    Yield — they live in the user's own Cloudflare Worker backend.)
    const createdAgents: Record<string, string> = {};
    const secretsNeeded: SecretReq[] = [];
    try {
      if (project && c.user && agentReqs.length) {
        const { results: existing } = await listAgents(c.env, c.user.id, project.id);
        for (const a of agentReqs) {
          const mdl = CODER_MODELS.some((m) => m.id === a.model) ? a.model! : 'glm-5.1';
          const found = existing.find((e) => e.name === a.name && e.project_id === project!.id);
          if (found) { await updateAgent(c.env, found.id, { system_prompt: a.system_prompt, model: mdl }); createdAgents[a.name] = found.id; }
          else { const ag = await createAgent(c.env, c.user.id, { name: a.name, system_prompt: a.system_prompt, model: mdl, is_public: true, project_id: project.id }); createdAgents[a.name] = ag.id; }
        }
      }
    } catch (e) { console.error('agent step failed:', e); }

    // Persist files BEFORE 'done' so the preview can fetch them immediately
    // (best-effort: never let a save error swallow the result).
    try {
      if (project && c.user && hasFiles) await saveFiles(c.env, project.id, files, activeModel.id);
    } catch (e) { console.error('saveFiles failed:', e); }

    // Auto-branding: on a NEW app's first successful build, set the generated app name
    // and inline-SVG logo (only when not already set, so edits don't keep renaming).
    try {
      if (project && c.user && hasFiles && !project.logo) {
        const name = (result.name || '').trim() || null;
        const logo = (result.logo || '').trim() || null;
        if (name || logo) await setProjectBranding(c.env, project.id, name, logo);
      }
    } catch (e) { console.error('branding step failed:', e); }

    // Illustrations the model asked for ("=== image: ... ===") — generate each and show
    // it inline in chat. Best-effort; never blocks the result.
    try {
      for (const p of result.images || []) {
        await send('status', { stage: '🎨 Generating an image…' });
        const url = await generateImage(c.env, p);
        await heartbeat();
        if (url) await send('image', { url, prompt: p });
      }
    } catch (e) { console.error('image step failed:', e); }

    await send('done', { chat: chatText, files, hasCode: hasFiles, projectId: project?.id ?? null, secretsNeeded, agents: createdAgents });

    // Tail work — fully best-effort; the build is already delivered + saved.
    try {
      if (project && c.user) {
        // The user prompt was saved up-front (userMsgSaved); only save it here if that
        // early write failed, so it's recorded exactly once.
        if (!userMsgSaved) await addMessage(c.env, { project_id: project.id, role: 'user', content: prompt });
        await addMessage(c.env, { project_id: project.id, role: 'assistant', content: chatText, model: activeModel.id });
        if (hasFiles) await syncProjectToGithub(c, project, files);
      }
      await recordGeneration(c);
      await logUsage(c.env, { user_id: c.user?.id ?? null, kind: hasFiles ? 'generate' : 'chat', model: activeModel.id, high_usage: gate.usage.highUsage });
    } catch (e) { console.error('post-build tail failed:', e); }
  } catch (e: any) {
    const reason = shortReason(e);
    console.error('build failed:', e?.stack || e);
    // Record the failure in history (best-effort) so the user's prompt + what went wrong
    // are preserved instead of the whole turn vanishing.
    try {
      const project = body.projectId ? await getProject(c.env, body.projectId) : null;
      if (project && c.user) {
        await addMessage(c.env, { project_id: project.id, role: 'assistant', content: `⚠️ The build didn't finish (${reason}). Your prompt is saved — please try again.`, model: 'system' });
      }
    } catch { /* ignore */ }
    await send('error', { message: `The AI provider errored (${reason}). Your prompt was saved — please try again.` });
  }
}

// Clamp untrusted attachments to safe bounds: at most 6 items; each image data URL
// <= ~6MB; each doc text <= 16k chars. Drops anything malformed. Keeps the build (and
// the Durable Object job it's serialized into) a sane size.
function sanitizeAttachments(input: unknown): Attachment[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: Attachment[] = [];
  let total = 0; // running byte budget across all attachments (~10MB)
  const BUDGET = 10_000_000;
  for (const a of input) {
    if (!a || typeof a !== 'object') continue;
    const kind = (a as any).kind;
    if (kind === 'image') {
      const url = (a as any).dataUrl;
      if (typeof url === 'string' && url.startsWith('data:') && url.length <= 6_000_000 && total + url.length <= BUDGET) {
        total += url.length;
        out.push({ kind: 'image', name: String((a as any).name || '').slice(0, 120), mime: String((a as any).mime || '').slice(0, 80), dataUrl: url });
      }
    } else if (kind === 'doc') {
      const text = (a as any).text;
      if (typeof text === 'string' && text.trim() && total < BUDGET) {
        const body = text.slice(0, 16000);
        total += body.length;
        out.push({ kind: 'doc', name: String((a as any).name || '').slice(0, 120), mime: String((a as any).mime || '').slice(0, 80), text: body });
      }
    }
    if (out.length >= 6) break;
  }
  return out.length ? out : undefined;
}

export async function handleGenerate(req: Request, c: Ctx): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as GenBody;
  const prompt = (body.prompt || '').trim();
  if (!prompt) return error(400, 'prompt required');
  if (prompt.length > 12000) return error(413, 'prompt too long');

  // Sanitize attachments: cap count + per-item size so an over-size payload can't blow
  // the build (and so the Durable Object's job stays a sane size). Images keep a data:
  // URL the vision model reads; docs keep extracted text.
  const attachments = sanitizeAttachments(body.attachments);

  // Pre-create the project (when signed-in/guest) so the build can be keyed to a
  // stable Durable Object and its result persists across a tab close/refresh.
  let project = body.projectId ? await getProject(c.env, body.projectId) : null;
  if (project && c.user && project.user_id !== c.user.id) return error(403, 'Not your project');
  if (!project && c.user) project = await createProject(c.env, c.user.id, prompt.slice(0, 60));
  const startBody: GenBody = { prompt, model: body.model, projectId: project?.id, thinking: body.thinking, enhance: body.enhance, attachments };

  // Preferred: run the build inside a Durable Object. The DO's lifetime is
  // independent of this HTTP request, so the build keeps running and SAVES even if
  // the browser tab is refreshed or closed. The response is the DO's live stream.
  if (project && c.env.BUILDER) {
    try {
      // The DO's begin() sets the "building" flag synchronously before it returns the
      // stream, so we don't pre-write it here (saves a KV write per build).
      const stub = c.env.BUILDER.get(c.env.BUILDER.idFromName(project.id));
      return await stub.fetch('https://build.yield/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: startBody, user: c.user, deviceId: c.deviceId }),
      });
    } catch {
      /* fall through to inline streaming */
    }
  }

  // Fallback: inline streaming via waitUntil (best-effort durability).
  const { response, send, close } = sse();
  const flagKey = project ? `build:${project.id}` : null;
  // Write the "building" flag once (not per token); delete it when the build ends.
  const heartbeat = async () => {};
  c.ctx.waitUntil(
    (async () => {
      if (flagKey) await c.env.KV.put(flagKey, String(Date.now()), { expirationTtl: 1800 }).catch(() => {});
      try { await runBuild(c, startBody, send, heartbeat); }
      finally {
        if (flagKey) await c.env.KV.delete(flagKey).catch(() => {});
        await close();
      }
    })(),
  );
  return response;
}
