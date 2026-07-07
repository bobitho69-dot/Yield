// Yield Roblox — business logic shared by src/routes/roblox.ts:
//  - plugin pairing (KV-backed opaque tokens, same pattern as web sessions)
//  - the streaming parser for AI-generated Luau "=== script: ===" blocks
//  - map-spec sanitization + free-model role resolution against a project's
//    pinned asset library
//  - a best-effort free-model marketplace search proxy (Roblox Open Cloud)

import type { Env } from '../types';
import { newId, now } from './response';

// --- Path / class validation ----------------------------------------------------
// The DataModel roots a generated script is allowed to live under. Anything else
// (or a path the plugin couldn't safely resolve) is rejected rather than guessed.
const VALID_ROOTS = new Set([
  'Workspace', 'ServerScriptService', 'ServerStorage', 'ReplicatedStorage',
  'StarterPlayerScripts', 'StarterGui', 'StarterPack', 'StarterCharacterScripts', 'Lighting',
]);
const VALID_CLASS = new Set(['Script', 'LocalScript', 'ModuleScript']);
const SEGMENT_RE = /^[A-Za-z0-9_ .-]{1,80}$/;

export function sanitizeScriptPath(raw: string): string | null {
  const path = (raw || '').trim().replace(/^\/+|\/+$/g, '');
  if (!path) return null;
  const segs = path.split('/').map((s) => s.trim()).filter(Boolean);
  if (segs.length < 2 || segs.length > 8) return null; // need Service/.../Name, cap depth
  if (!VALID_ROOTS.has(segs[0])) return null;
  if (!segs.every((s) => SEGMENT_RE.test(s))) return null;
  return segs.join('/');
}

export function sanitizeClassName(raw: string): string {
  const c = (raw || '').trim();
  return VALID_CLASS.has(c) ? c : 'Script';
}

// --- Streaming parser for AI-generated Luau script blocks -----------------------
// Mirrors the shape of makeFileStreamer (src/routes/generate.ts) but scoped to
// Roblox: chat text vs "=== script: path | ClassName ===" blocks, a one-line
// "=== ask: ... ===" clarifying question, and a "=== summary ===" closing recap.
export interface RobloxScriptOut { path: string; className: string; source: string }

export function makeScriptStreamer(send: (event: string, data: unknown) => Promise<void>) {
  const SCRIPT = /^={2,}\s*script:\s*([^|=]+?)\s*\|\s*([A-Za-z]+)\s*={2,}\s*$/i;
  const SUMMARY = /^={2,}\s*(?:summary|recap|done|notes)\s*={2,}\s*$/i;
  const ASK = /^={2,}\s*ask:\s*(.+)$/i;
  const REASON_OPEN = /<(think|thinking|reasoning|tool_call)>/i;
  const STRUCTURAL = /^\s*(?:={2,}\s*(?:script|summary|recap|done|notes|ask)\b|```)/i;

  let buf = '';
  let mode: 'chat' | 'script' = 'chat';
  let reasonClose: string | null = null;
  let fenceOpen = false;
  let fenceIndex = 0;
  let asked = false;
  let lastStatus = '';
  const chatLines: string[] = [];
  const thinkLines: string[] = [];
  const scripts: { path: string; className: string; lines: string[] }[] = [];
  let cur: { path: string; className: string; lines: string[] } | null = null;

  async function handleLine(line: string): Promise<void> {
    if (reasonClose) {
      if (!STRUCTURAL.test(line)) {
        const close = line.toLowerCase().indexOf(reasonClose);
        if (close === -1) { thinkLines.push(line); await send('thinking', line + '\n'); return; }
        const before = line.slice(0, close);
        if (before.trim()) { thinkLines.push(before); await send('thinking', before + '\n'); }
        const after = line.slice(close + reasonClose.length);
        reasonClose = null;
        if (after.trim()) await handleLine(after);
        return;
      }
      reasonClose = null;
    }
    const om = line.match(REASON_OPEN);
    if (om && om.index !== undefined) {
      const before = line.slice(0, om.index);
      if (before.trim()) await handleLine(before);
      reasonClose = `</${om[1].toLowerCase()}>`;
      await handleLine(line.slice(om.index + om[0].length));
      return;
    }

    let m;
    if ((m = line.match(SCRIPT))) {
      const path = sanitizeScriptPath(m[1]);
      const className = sanitizeClassName(m[2]);
      mode = 'script';
      cur = { path: path || m[1].trim(), className, lines: [] };
      scripts.push(cur);
      if (cur.path !== lastStatus) { lastStatus = cur.path; await send('status', { stage: `Writing ${cur.path}` }); }
      await send('code', { path: cur.path, className, delta: '', start: true });
      return;
    }
    if ((m = line.match(ASK))) {
      const raw = m[1].replace(/\s*={2,}\s*$/, '');
      const parts = raw.split('|').map((s) => s.trim()).filter(Boolean);
      const question = parts[0] || '';
      if (question) { asked = true; await send('ask', { question, options: parts.slice(1, 6) }); }
      return;
    }
    if (SUMMARY.test(line)) { mode = 'chat'; fenceOpen = false; cur = null; await send('status', { stage: 'Wrapping up…' }); return; }

    // Fallback: some coder models ignore the marker format and just use ```lua fences.
    const fenceM = line.match(/^\s*```([A-Za-z0-9.\-_/:+]*)\s*$/);
    if (fenceM) {
      if (mode === 'script' && fenceOpen) { fenceOpen = false; mode = 'chat'; cur = null; return; }
      if (mode === 'chat') {
        fenceIndex += 1;
        const path = `ServerScriptService/YieldGenerated/Script${fenceIndex}`;
        cur = { path, className: 'Script', lines: [] };
        scripts.push(cur); mode = 'script'; fenceOpen = true;
        await send('status', { stage: `Writing ${path}` });
        await send('code', { path, className: 'Script', delta: '', start: true });
        return;
      }
      if (mode === 'script' && !fenceOpen) return;
    }
    if (mode === 'chat') { chatLines.push(line); await send('chat', line + '\n'); }
    else if (mode === 'script' && cur) { cur.lines.push(line); await send('code', { path: cur.path, className: cur.className, delta: line + '\n' }); }
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
    reset() {
      buf = ''; mode = 'chat'; reasonClose = null; fenceOpen = false; lastStatus = ''; asked = false;
      cur = null;
      scripts.length = 0; chatLines.length = 0; thinkLines.length = 0;
    },
    get produced() {
      return scripts.some((f) => f.lines.some((l) => l.trim())) || chatLines.some((l) => l.trim());
    },
    result() {
      const chat = chatLines.join('\n')
        .replace(/<(think|thinking|reasoning|tool_call|tool_response)>[\s\S]*?<\/\1>/gi, '')
        .replace(/<(?:think|thinking|reasoning|tool_call|tool_response)>[\s\S]*$/i, '')
        .replace(/<\/?(?:think|thinking|reasoning|tool_call|tool_response)[^>]*>/gi, '')
        .trim();
      const out: RobloxScriptOut[] = scripts
        .map((s) => ({ path: s.path, className: s.className, source: cleanSource(s.lines.join('\n')) }))
        .filter((s) => sanitizeScriptPath(s.path) && s.source.trim());
      return { chat: chat || (out.length ? 'Here you go.' : ''), scripts: out, asked };
    },
  };
}

function cleanSource(s: string): string {
  let t = s.replace(/^\n+|\n+$/g, '');
  const fence = t.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```$/);
  if (fence) t = fence[1];
  return t;
}

// --- Pairing: the web app mints a short code; the plugin exchanges it for a ------
// long-lived bearer token. Both live in KV (same opaque-token pattern as sessions
// in src/lib/auth.ts) — no secret is ever persisted in D1.
const PAIR_TTL = 600; // 10 minutes to redeem a pairing code
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to type in Studio

export async function createPairCode(env: Env, projectId: string): Promise<{ code: string; expiresAt: number }> {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = '';
  for (const b of bytes) code += PAIR_ALPHABET[b % PAIR_ALPHABET.length];
  const expiresAt = now() + PAIR_TTL;
  await env.KV.put(`roblox_pair:${code}`, JSON.stringify({ projectId }), { expirationTtl: PAIR_TTL });
  return { code, expiresAt };
}

export async function redeemPairCode(env: Env, rawCode: string): Promise<{ projectId: string } | null> {
  const code = (rawCode || '').trim().toUpperCase();
  if (!code) return null;
  const key = `roblox_pair:${code}`;
  const val = await env.KV.get(key);
  if (!val) return null;
  await env.KV.delete(key); // one-time use
  try { return JSON.parse(val); } catch { return null; }
}

export async function mintPluginToken(env: Env, projectId: string): Promise<string> {
  const token = `rbx_${newId()}${newId()}`;
  await env.KV.put(`roblox_token:${token}`, JSON.stringify({ projectId }));
  return token;
}

export async function resolvePluginToken(env: Env, token: string): Promise<{ projectId: string } | null> {
  if (!token) return null;
  const val = await env.KV.get(`roblox_token:${token}`);
  if (!val) return null;
  try { return JSON.parse(val); } catch { return null; }
}

export async function revokePluginToken(env: Env, token: string): Promise<void> {
  if (token) await env.KV.delete(`roblox_token:${token}`).catch(() => {});
}

/** Pull the bearer token off a plugin request and resolve it to a project id. */
export async function authenticatePlugin(env: Env, req: Request): Promise<{ projectId: string; token: string } | null> {
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  const resolved = await resolvePluginToken(env, token);
  return resolved ? { projectId: resolved.projectId, token } : null;
}

// --- Map spec sanitization + free-model role resolution -------------------------
const MATERIALS = new Set([
  'Plastic', 'Wood', 'Brick', 'Concrete', 'Metal', 'Neon', 'Glass', 'Grass', 'Sand', 'Ice', 'Fabric',
  'Cobblestone', 'DiamondPlate', 'Slate', 'Marble', 'Granite', 'ForceField', 'Rock', 'Snow', 'Mud', 'Asphalt',
]);
const SHAPES = new Set(['Block', 'Cylinder', 'Ball', 'Wedge']);

function hex(raw: unknown, fallback: string): string {
  const s = String(raw ?? '').trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(s) ? `#${s.toLowerCase()}` : fallback;
}
function num(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function vec3(raw: unknown, fallback: [number, number, number], min: number, max: number): [number, number, number] {
  if (!Array.isArray(raw) || raw.length < 3) return fallback;
  return [num(raw[0], fallback[0], min, max), num(raw[1], fallback[1], min, max), num(raw[2], fallback[2], min, max)];
}

export interface PinnedAsset { asset_id: string; name: string; tags: string | null }

interface RawModelRole { role?: string; tags?: string[]; position?: unknown; rotation?: unknown; scale?: number; count?: number }
export interface ResolvedModelPlacement { assetId: string; name: string; position: number[]; rotation: number[]; scale: number }

// Score a pinned asset against a role's free-text description + tags by simple
// keyword overlap (no external NLP needed — the library is small and user-curated).
function matchAsset(role: string, tags: string[], library: PinnedAsset[]): PinnedAsset | null {
  const words = new Set(`${role} ${tags.join(' ')}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  if (!words.size) return null;
  let best: PinnedAsset | null = null;
  let bestScore = 0;
  for (const a of library) {
    const hay = `${a.name} ${a.tags || ''}`.toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score++;
    if (score > bestScore) { bestScore = score; best = a; }
  }
  return bestScore > 0 ? best : null;
}

function resolveModels(raw: unknown, library: PinnedAsset[]): { placements: ResolvedModelPlacement[]; unresolved: string[] } {
  const placements: ResolvedModelPlacement[] = [];
  const unresolved: string[] = [];
  const arr = Array.isArray(raw) ? (raw as RawModelRole[]).slice(0, 25) : [];
  let total = 0;
  for (const m of arr) {
    const role = String(m.role || '').slice(0, 120);
    const tags = Array.isArray(m.tags) ? m.tags.map((t) => String(t).slice(0, 30)).slice(0, 8) : [];
    const asset = matchAsset(role, tags, library);
    if (!asset) { if (role) unresolved.push(role); continue; }
    const base = vec3(m.position, [0, 0, 0], -5000, 5000);
    const rotation = vec3(m.rotation, [0, 0, 0], -360, 360);
    const scale = num(m.scale, 1, 0.1, 10);
    const count = Math.max(1, Math.min(20, Math.round(m.count || 1)));
    for (let i = 0; i < count && total < 150; i++, total++) {
      // Spread repeats along X so a "row of trees" doesn't stack on one point.
      const position = count > 1 ? [base[0] + i * 12, base[1], base[2]] : base;
      placements.push({ assetId: asset.asset_id, name: asset.name, position, rotation, scale });
    }
  }
  return { placements, unresolved };
}

export interface SanitizedMapSpec {
  clear?: boolean;
  baseplate?: { size: [number, number]; material: string; color: string };
  parts: Record<string, unknown>[];
  models: ResolvedModelPlacement[];
  lighting?: Record<string, unknown>;
}

/** Clamp/validate an AI-produced map spec and resolve its model "roles" against the
 *  project's pinned asset library. Never throws — a malformed field is just dropped. */
export function sanitizeMapSpec(raw: any, library: PinnedAsset[]): { spec: SanitizedMapSpec; unresolved: string[] } {
  const spec: SanitizedMapSpec = { clear: true, parts: [], models: [] };

  if (raw?.baseplate) {
    const size = raw.baseplate.size;
    spec.baseplate = {
      size: Array.isArray(size) ? [num(size[0], 512, 16, 4000), num(size[1], 512, 16, 4000)] : [512, 512],
      material: MATERIALS.has(raw.baseplate.material) ? raw.baseplate.material : 'Grass',
      color: hex(raw.baseplate.color, '#3a7d3a'),
    };
  }

  const parts = Array.isArray(raw?.parts) ? raw.parts.slice(0, 60) : [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    spec.parts.push({
      name: String(p.name || 'Part').slice(0, 60),
      shape: SHAPES.has(p.shape) ? p.shape : 'Block',
      size: vec3(p.size, [4, 4, 4], 0.2, 2000),
      position: vec3(p.position, [0, 5, 0], -5000, 5000),
      rotation: vec3(p.rotation, [0, 0, 0], -360, 360),
      color: hex(p.color, '#9a9a9a'),
      material: MATERIALS.has(p.material) ? p.material : 'Plastic',
      anchored: p.anchored !== false,
      transparency: num(p.transparency, 0, 0, 1),
    });
  }

  const { placements, unresolved } = resolveModels(raw?.models, library);
  spec.models = placements;

  if (raw?.lighting && typeof raw.lighting === 'object') {
    const l: Record<string, unknown> = {};
    if (raw.lighting.ambient) l.ambient = hex(raw.lighting.ambient, '#2b2b3a');
    if (raw.lighting.brightness != null) l.brightness = num(raw.lighting.brightness, 2, 0, 10);
    if (raw.lighting.clockTime != null) l.clockTime = num(raw.lighting.clockTime, 14, 0, 24);
    if (raw.lighting.fogEnd != null) l.fogEnd = num(raw.lighting.fogEnd, 900, 50, 100000);
    if (Object.keys(l).length) spec.lighting = l;
  }

  return { spec, unresolved };
}

// --- Free-model marketplace search (best-effort; needs the user's own Roblox ----
// Open Cloud API key). VERIFY the exact path/response shape at
// create.roblox.com/docs/cloud/api/toolbox-service — Roblox's Open Cloud surface
// is versioned and can move; this calls the officially documented search shape and
// degrades to an empty result (never throws) so the rest of the app keeps working,
// same "best effort, verify at deploy time" pattern as generateImage/generate3dModel
// in src/routes/media.ts.
export interface RobloxSearchResult { assetId: string; name: string; creator: string | null; thumbnail: string | null }

export async function searchFreeModels(apiKey: string, query: string): Promise<RobloxSearchResult[]> {
  if (!apiKey || !query.trim()) return [];
  const url = `https://apis.roblox.com/toolbox-service/v1/items?category=Model&keyword=${encodeURIComponent(query.slice(0, 100))}&limit=12`;
  try {
    const r = await fetch(url, { headers: { 'x-api-key': apiKey, accept: 'application/json' } });
    if (!r.ok) return [];
    const data: any = await r.json().catch(() => null);
    const items: any[] = data?.data || data?.items || data?.results || [];
    return items
      .map((it) => ({
        assetId: String(it.id ?? it.assetId ?? it.Asset?.Id ?? it.asset?.id ?? ''),
        name: String(it.name ?? it.Asset?.Name ?? it.asset?.name ?? 'Untitled'),
        creator: it.creatorName ?? it.Creator?.Name ?? it.creator?.name ?? null,
        thumbnail: it.thumbnailUrl ?? it.Thumbnail?.Url ?? it.thumbnail?.url ?? null,
      }))
      .filter((x) => x.assetId)
      .slice(0, 12);
  } catch {
    return [];
  }
}
