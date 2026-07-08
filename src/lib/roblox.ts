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
  // Bound the input BEFORE any regex/split touches it — an untrusted caller (the
  // plugin, or a hand-crafted API request) could otherwise hand us an enormous
  // string (e.g. megabytes of "/") and make the trim/replace/split below do
  // needless work over it. A real path is never anywhere near this long (8
  // segments x 80 chars is the actual cap below).
  if (!raw || raw.length > 600) return null;
  const path = raw.trim().replace(/^\/+|\/+$/g, '');
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
  // "=== concept: a swamp mood board ===" — show a generated concept-art image in
  // chat (reuses the same image-gen infra the web builder uses).
  const CONCEPT = /^={2,}\s*concept:\s*(.+?)\s*={2,}\s*$/i;
  const REASON_OPEN = /<(think|thinking|reasoning|tool_call)>/i;
  const STRUCTURAL = /^\s*(?:={2,}\s*(?:script|summary|recap|done|notes|ask|concept)\b|```)/i;

  // A fenced ```yield-ops (aka yield-edits/yield-build/yield-actions) block: the AI's
  // way to DO things in the game beyond writing scripts — build maps, edit/create/
  // delete/move any instance, ask the server to find a free marketplace model, or
  // generate a 3D model. Its body is a JSON array of op objects the server resolves.
  const YIELD_OPS_LANG = /^yield[-_]?(ops|edits|edit|build|actions|action)$/i;

  let buf = '';
  let mode: 'chat' | 'script' | 'ops' = 'chat';
  let reasonClose: string | null = null;
  let fenceOpen = false;
  let fenceIndex = 0;
  let asked = false;
  let lastStatus = '';
  const chatLines: string[] = [];
  const imagePrompts: string[] = [];
  const scripts: { path: string; className: string; lines: string[] }[] = [];
  let cur: { path: string; className: string; lines: string[] } | null = null;
  let opsBuf: string[] | null = null;
  const opsRaw: any[] = [];

  function flushOpsBlock() {
    if (!opsBuf) return;
    const text = opsBuf.join('\n').trim();
    opsBuf = null;
    if (!text) return;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) opsRaw.push(...parsed);
      else if (parsed && typeof parsed === 'object') opsRaw.push(parsed);
    } catch { /* a malformed ops block is just dropped — scripts/chat still land */ }
  }

  async function handleLine(line: string): Promise<void> {
    // Inside a yield-ops block, accumulate raw JSON lines until the closing fence —
    // never interpret them as chat/script/markers.
    if (mode === 'ops') {
      if (/^\s*\`\`\`/.test(line)) { flushOpsBlock(); mode = 'chat'; return; }
      if (opsBuf) opsBuf.push(line);
      return;
    }
    if (reasonClose) {
      if (!STRUCTURAL.test(line)) {
        const close = line.toLowerCase().indexOf(reasonClose);
        if (close === -1) { await send('thinking', line + '\n'); return; }
        const before = line.slice(0, close);
        if (before.trim()) await send('thinking', before + '\n');
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
    if ((m = line.match(CONCEPT))) {
      const p = m[1].trim();
      if (p && imagePrompts.length < 4) imagePrompts.push(p);
      return;
    }
    if (SUMMARY.test(line)) { mode = 'chat'; fenceOpen = false; cur = null; await send('status', { stage: 'Wrapping up…' }); return; }

    // Fallback: some coder models ignore the marker format and just use ```lua fences.
    const fenceM = line.match(/^\s*```([A-Za-z0-9.\-_/:+]*)\s*$/);
    if (fenceM) {
      if (mode === 'chat' && YIELD_OPS_LANG.test(fenceM[1] || '')) { mode = 'ops'; opsBuf = []; await send('status', { stage: 'Editing the game…' }); return; }
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
      if (mode === 'ops') { flushOpsBlock(); mode = 'chat'; }
      if (buf.length) { await handleLine(buf); buf = ''; }
    },
    reset() {
      buf = ''; mode = 'chat'; reasonClose = null; fenceOpen = false; lastStatus = ''; asked = false;
      cur = null; opsBuf = null;
      scripts.length = 0; chatLines.length = 0; imagePrompts.length = 0; opsRaw.length = 0;
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
      return { chat: chat || (out.length || opsRaw.length ? 'Here you go.' : ''), scripts: out, asked, images: imagePrompts.slice(0, 4), ops: opsRaw.slice(0, 200) };
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

// Unbiased pick from `alphabet` via rejection sampling: reduce a random byte modulo
// alphabet.length only when it falls in the largest range evenly divisible by that
// length, discarding (and redrawing) the few high values that would otherwise skew
// toward the earlier letters. (A plain `byte % alphabet.length` is what static
// analyzers flag as "biased" — this is the standard fix, and works for any
// alphabet length, not just a power of two.)
function unbiasedPick(alphabet: string): string {
  const limit = 256 - (256 % alphabet.length);
  let byte: number;
  do {
    byte = crypto.getRandomValues(new Uint8Array(1))[0];
  } while (byte >= limit);
  return alphabet[byte % alphabet.length];
}

// The link is USER-scoped and permanent: the web mints a one-time link code tied to
// the signed-in user; the plugin redeems it ONCE for a long-lived token that never
// expires. After that the plugin auto-picks-up whichever place is open (by PlaceId)
// with zero further setup — no per-game naming, no re-pairing.
export async function createLinkCode(env: Env, userId: string): Promise<{ code: string; expiresAt: number }> {
  let code = '';
  for (let i = 0; i < 8; i++) code += unbiasedPick(PAIR_ALPHABET);
  const expiresAt = now() + PAIR_TTL;
  await env.KV.put(`roblox_link:${code}`, JSON.stringify({ userId }), { expirationTtl: PAIR_TTL });
  return { code, expiresAt };
}

export async function redeemLinkCode(env: Env, rawCode: string): Promise<{ userId: string } | null> {
  const code = (rawCode || '').trim().toUpperCase();
  if (!code) return null;
  const key = `roblox_link:${code}`;
  const val = await env.KV.get(key);
  if (!val) return null;
  await env.KV.delete(key); // one-time use
  try { return JSON.parse(val); } catch { return null; }
}

// Permanent, user-scoped plugin token (no TTL). Revocable from the website WITHOUT
// the website ever holding the token: each token carries the user's "link epoch",
// and web-side "unlink" bumps that epoch (revokeAllUserTokens) so every outstanding
// token stops resolving. The lone-token delete path is also kept for the plugin's
// own unlink.
async function linkEpoch(env: Env, userId: string): Promise<number> {
  const v = await env.KV.get(`roblox_link_epoch:${userId}`);
  return v ? parseInt(v, 10) || 1 : 1;
}

export async function mintUserToken(env: Env, userId: string): Promise<string> {
  const epoch = await linkEpoch(env, userId);
  const token = `rbxu_${newId()}${newId()}`;
  await env.KV.put(`roblox_user_token:${token}`, JSON.stringify({ userId, epoch }));
  return token;
}

export async function resolveUserToken(env: Env, token: string): Promise<{ userId: string } | null> {
  if (!token) return null;
  const val = await env.KV.get(`roblox_user_token:${token}`);
  if (!val) return null;
  let parsed: { userId: string; epoch?: number };
  try { parsed = JSON.parse(val); } catch { return null; }
  // Reject (and clean up) tokens minted before the user's last web-side unlink.
  const current = await linkEpoch(env, parsed.userId);
  if ((parsed.epoch || 1) !== current) { await env.KV.delete(`roblox_user_token:${token}`).catch(() => {}); return null; }
  return { userId: parsed.userId };
}

export async function revokeUserToken(env: Env, token: string): Promise<void> {
  if (token) await env.KV.delete(`roblox_user_token:${token}`).catch(() => {});
}

// Web-side "unlink everything": bump the epoch so all outstanding tokens for this
// user stop resolving on their next request.
export async function revokeAllUserTokens(env: Env, userId: string): Promise<void> {
  const next = (await linkEpoch(env, userId)) + 1;
  await env.KV.put(`roblox_link_epoch:${userId}`, String(next));
}

/** Pull the bearer token off a plugin request and resolve it to a user id. */
export async function authenticatePlugin(env: Env, req: Request): Promise<{ userId: string; token: string } | null> {
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  const resolved = await resolveUserToken(env, token);
  return resolved ? { userId: resolved.userId, token } : null;
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

// Total resolved model instances across a whole map — generous enough for an
// "extravagant" scene (forests, crowds of props, full villages) while still
// bounding one sync payload/build pass to something the plugin can apply quickly.
const MAX_MODEL_PLACEMENTS = 400;

function resolveModels(raw: unknown, library: PinnedAsset[]): { placements: ResolvedModelPlacement[]; unresolved: string[] } {
  const placements: ResolvedModelPlacement[] = [];
  // Every role the AI asked for that didn't end up with at least one placement —
  // either no pinned asset matched it, or the total-placement budget ran out first.
  // Both are surfaced identically: the user needs to either pin/search a model for
  // it, or (for a budget cutoff) accept a smaller scene / split it into two builds.
  const unresolved: string[] = [];
  const arr = Array.isArray(raw) ? (raw as RawModelRole[]).slice(0, 40) : [];
  let total = 0;
  for (const m of arr) {
    const role = String(m.role || '').slice(0, 120);
    const tags = Array.isArray(m.tags) ? m.tags.map((t) => String(t).slice(0, 30)).slice(0, 8) : [];
    const asset = matchAsset(role, tags, library);
    if (!asset) { if (role) unresolved.push(role); continue; }
    const base = vec3(m.position, [0, 0, 0], -5000, 5000);
    const rotation = vec3(m.rotation, [0, 0, 0], -360, 360);
    const scale = num(m.scale, 1, 0.1, 10);
    const count = Math.max(1, Math.min(30, Math.round(m.count || 1)));
    let placedForRole = 0;
    for (let i = 0; i < count && total < MAX_MODEL_PLACEMENTS; i++, total++, placedForRole++) {
      // Spread repeats along X so a "row of trees" doesn't stack on one point.
      const position = count > 1 ? [base[0] + i * 12, base[1], base[2]] : base;
      placements.push({ assetId: asset.asset_id, name: asset.name, position, rotation, scale });
    }
    // Matched a real asset, but the scene-wide budget was already exhausted before
    // any (or all) of this role's copies could be placed — don't let it disappear
    // silently, the AI asked for it and it's not there.
    if (placedForRole === 0 && role) unresolved.push(role);
  }
  return { placements, unresolved };
}

export interface SanitizedMapSpec {
  clear?: boolean;
  baseplate?: { size: [number, number]; material: string; color: string };
  parts: Record<string, unknown>[];
  // AI-modeled props: detailed scenery the AI sculpts OUT OF PARTS itself (a Model
  // whose child parts are positioned relative to the prop origin) — no marketplace
  // asset needed, so it works with zero setup and lets the AI hit very high detail.
  props?: { name: string; position: [number, number, number]; parts: Record<string, unknown>[] }[];
  models: ResolvedModelPlacement[];
  lighting?: Record<string, unknown>;
}

function sanitizePartList(raw: unknown, limit: number, defSize: [number, number, number], posRange: number): Record<string, unknown>[] {
  const arr = Array.isArray(raw) ? raw.slice(0, limit) : [];
  const out: Record<string, unknown>[] = [];
  for (const p of arr) {
    if (!p || typeof p !== 'object') continue;
    out.push({
      name: String((p as any).name || 'Part').slice(0, 60),
      shape: SHAPES.has((p as any).shape) ? (p as any).shape : 'Block',
      size: vec3((p as any).size, defSize, 0.1, 2000),
      position: vec3((p as any).position, [0, 0, 0], -posRange, posRange),
      rotation: vec3((p as any).rotation, [0, 0, 0], -360, 360),
      color: hex((p as any).color, '#9a9a9a'),
      material: MATERIALS.has((p as any).material) ? (p as any).material : 'Plastic',
      anchored: (p as any).anchored !== false,
      transparency: num((p as any).transparency, 0, 0, 1),
    });
  }
  return out;
}

/** Clamp/validate an AI-produced map spec and resolve its model "roles" against the
 *  project's pinned asset library. Never throws — a malformed field is just dropped.
 *  `clear` controls whether the plugin wipes the previous YieldMap-tagged build first
 *  (true for a fresh/first build, false to add onto what's already there). */
export function sanitizeMapSpec(raw: any, library: PinnedAsset[], clear: boolean): { spec: SanitizedMapSpec; unresolved: string[] } {
  const spec: SanitizedMapSpec = { clear, parts: [], models: [] };

  if (raw?.baseplate) {
    const size = raw.baseplate.size;
    spec.baseplate = {
      size: Array.isArray(size) ? [num(size[0], 512, 16, 4000), num(size[1], 512, 16, 4000)] : [512, 512],
      material: MATERIALS.has(raw.baseplate.material) ? raw.baseplate.material : 'Grass',
      color: hex(raw.baseplate.color, '#3a7d3a'),
    };
  }

  spec.parts = sanitizePartList(raw?.parts, 200, [4, 4, 4], 5000);

  // AI-modeled props (Models built from parts) — the AI sculpts detailed scenery
  // itself. Each prop's child parts are placed relative to the prop origin.
  const rawProps = Array.isArray(raw?.props) ? raw.props.slice(0, 60) : [];
  if (rawProps.length) {
    spec.props = [];
    for (const pr of rawProps) {
      if (!pr || typeof pr !== 'object') continue;
      const pieces = sanitizePartList((pr as any).parts, 80, [2, 2, 2], 500);
      if (pieces.length) spec.props.push({ name: String((pr as any).name || 'Prop').slice(0, 60), position: vec3((pr as any).position, [0, 0, 0], -5000, 5000), parts: pieces });
    }
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

// --- Whole-game read: the tree the plugin pushes (the AI's "eyes" on the place) --
// Stored in KV (no D1 migration needed) so a game of any size can be kept + fed to
// the AI as context and rendered in the web Explorer.
export interface GameTreeNode { path: string; className: string; props?: Record<string, unknown> }
export interface GameTreePayload { tree: GameTreeNode[]; truncated?: boolean; at: number; scriptCount?: number }

export async function setGameTree(env: Env, projectId: string, payload: GameTreePayload): Promise<void> {
  try { await env.KV.put(`roblox_tree:${projectId}`, JSON.stringify(payload)); } catch { /* best-effort — a snapshot failing must not break the sync */ }
}
export async function getGameTree(env: Env, projectId: string): Promise<GameTreePayload | null> {
  const v = await env.KV.get(`roblox_tree:${projectId}`);
  if (!v) return null;
  try { return JSON.parse(v) as GameTreePayload; } catch { return null; }
}

// Compact outline of the game the coder AI reads so it knows exactly what exists and
// can target real paths when it edits — kept short to stay within the token budget.
export function formatGameTreeForPrompt(payload: GameTreePayload | null, maxLines = 280): string {
  if (!payload || !Array.isArray(payload.tree) || !payload.tree.length) return '';
  const lines: string[] = [];
  for (const n of payload.tree) {
    if (lines.length >= maxLines) break;
    let line = `${n.path} [${n.className}]`;
    const p = n.props as any;
    if (p && Array.isArray(p.size)) line += ` size=${p.size.join('x')} pos=(${(p.position || []).join(',')}) ${p.material || ''} ${p.color || ''}`.replace(/\s+/g, ' ').trimEnd();
    lines.push(line);
  }
  const more = payload.tree.length > lines.length ? `\n…and ${payload.tree.length - lines.length} more` : '';
  return `The linked Studio place currently contains ${payload.tree.length} instance(s)${payload.truncated ? ' (truncated)' : ''}:\n${lines.join('\n')}${more}`;
}

// --- Agentic edit ops: validate the direct ops the AI emits in a yield-ops block --
// (find_model / gen_model are resolved separately in the route, since they need the
// user's Roblox key + the marketplace/3D APIs.) Never throws — a bad op returns null.
const OP_PATH_RE = /^[A-Za-z0-9_ .\-]+(?:\/[A-Za-z0-9_ .\-]+)*$/;
function cleanOpPath(p: unknown): string | null {
  const s = String(p ?? '').trim().replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  return s.length >= 1 && s.length <= 400 && OP_PATH_RE.test(s) ? s : null;
}
function cleanOpProps(pr: unknown): Record<string, unknown> {
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) return {};
  return Object.fromEntries(Object.entries(pr as Record<string, unknown>).slice(0, 40).map(([k, v]) => [String(k).slice(0, 60), v]));
}
export function sanitizeGenericOp(op: any): Record<string, unknown> | null {
  if (!op || typeof op !== 'object') return null;
  const type = String(op.type || '');
  switch (type) {
    case 'set_properties': { const path = cleanOpPath(op.path); return path ? { type, path, properties: cleanOpProps(op.properties) } : null; }
    case 'create_instance': {
      const parent = cleanOpPath(op.parent);
      const className = String(op.className || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
      return parent && className ? { type, parent, className, name: String(op.name || className).slice(0, 60), properties: cleanOpProps(op.properties) } : null;
    }
    case 'delete_instance': { const path = cleanOpPath(op.path); return path ? { type, path } : null; }
    case 'rename_instance': { const path = cleanOpPath(op.path); const name = String(op.name || '').slice(0, 60); return path && name ? { type, path, name } : null; }
    case 'move_instance': { const path = cleanOpPath(op.path); const parent = cleanOpPath(op.parent); return path && parent ? { type, path, parent } : null; }
    case 'insert_model': {
      const m = String(op.assetId ?? '').match(/\d{3,20}/);
      return m ? { type, assetId: m[0], name: String(op.name || 'Model').slice(0, 60), position: vec3(op.position, [0, 5, 0], -5000, 5000), rotation: vec3(op.rotation, [0, 0, 0], -360, 360), scale: num(op.scale, 1, 0.1, 20) } : null;
    }
    default: return null;
  }
}

// --- Marketplace Key: the user's Roblox Open Cloud key -----------------------------
// Yield calls it the "Marketplace Key". It's ACCOUNT-LEVEL (added once, used for
// every game the user builds) so the AI can search free marketplace models and
// upload 3D-generated models. Stored AES-GCM ENCRYPTED (the caller encrypts via
// encryptToken before calling here) in KV — never in D1, never returned to the
// client, never logged. Only a boolean "connected" + the (non-secret) creator id
// are ever surfaced.
export interface MarketplaceKeyRecord { enc: string; creatorType: 'User' | 'Group'; creatorId: string | null }

export async function setMarketplaceKey(env: Env, userId: string, encKey: string | null, creatorType: 'User' | 'Group', creatorId: string | null): Promise<void> {
  const k = `roblox_mkt_key:${userId}`;
  if (!encKey) { await env.KV.delete(k); return; }
  await env.KV.put(k, JSON.stringify({ enc: encKey, creatorType, creatorId, connectedAt: now() }));
}
export async function getMarketplaceKey(env: Env, userId: string): Promise<MarketplaceKeyRecord | null> {
  const v = await env.KV.get(`roblox_mkt_key:${userId}`);
  if (!v) return null;
  try { const o = JSON.parse(v); return { enc: o.enc, creatorType: o.creatorType === 'Group' ? 'Group' : 'User', creatorId: o.creatorId ?? null }; } catch { return null; }
}
// Non-secret status for the UI (never includes the key itself).
export async function marketplaceKeyStatus(env: Env, userId: string): Promise<{ connected: boolean; creatorType?: 'User' | 'Group'; creatorId?: string | null; connectedAt?: number }> {
  const v = await env.KV.get(`roblox_mkt_key:${userId}`);
  if (!v) return { connected: false };
  try { const o = JSON.parse(v); return { connected: true, creatorType: o.creatorType === 'Group' ? 'Group' : 'User', creatorId: o.creatorId ?? null, connectedAt: o.connectedAt }; } catch { return { connected: false }; }
}
// Best-effort validation so we never store a junk/expired key: an authenticated
// probe that only REJECTS on a clear auth failure (401/403); any other outcome
// (200/404/429/5xx/network) is accepted so Roblox flakiness never blocks the user.
export async function validateMarketplaceKey(apiKey: string): Promise<{ ok: boolean; reason?: string }> {
  if (!apiKey || apiKey.trim().length < 12) return { ok: false, reason: 'That key looks too short — paste the full Open Cloud API key.' };
  if (/\s/.test(apiKey.trim())) return { ok: false, reason: 'The key contains spaces — copy it exactly, with no line breaks.' };
  try {
    const r = await fetch('https://apis.roblox.com/toolbox-service/v1/items?category=Model&keyword=tree&limit=1', { headers: { 'x-api-key': apiKey.trim(), accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'Roblox rejected the key — make sure it has Toolbox/Assets read permission and has not expired.' };
    return { ok: true };
  } catch { return { ok: true }; }
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

// --- Custom 3D-model upload (Roblox Open Cloud Assets API) ----------------------
// Turns a generated .glb (from the AI 3D-model endpoint, src/routes/media.ts's
// generate3dModel/TRELLIS) into a real, insertable Roblox asset in the user's own
// account, so map generation can place genuinely custom props — not just free
// catalog models — when a Roblox Open Cloud key is connected. VERIFY the exact
// path/shape at create.roblox.com/docs/reference/cloud/assets if Roblox changes
// this surface; best-effort like every other external-API call in this file —
// returns null on any failure rather than throwing.
export interface RobloxCreator { type: 'User' | 'Group'; id: string }

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The AI 3D-model endpoint returns either a data: URL (inline base64) or a plain
// provider URL — normalize either into raw bytes + a MIME type.
async function materializeBytes(urlOrDataUrl: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (urlOrDataUrl.startsWith('data:')) {
    const m = urlOrDataUrl.match(/^data:([^;]+);base64,([\s\S]*)$/);
    if (!m) return null;
    return { bytes: b64ToBytes(m[2]), mime: m[1] || 'model/gltf-binary' };
  }
  try {
    const r = await fetch(urlOrDataUrl);
    if (!r.ok) return null;
    return { bytes: new Uint8Array(await r.arrayBuffer()), mime: r.headers.get('content-type') || 'model/gltf-binary' };
  } catch {
    return null;
  }
}

function buildMultipart(boundary: string, requestJson: string, fileBytes: Uint8Array, filename: string, fileMime: string): Uint8Array {
  const enc = new TextEncoder();
  const head1 = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="request"\r\n\r\n${requestJson}\r\n--${boundary}\r\nContent-Disposition: form-data; name="fileContent"; filename="${filename}"\r\nContent-Type: ${fileMime}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head1.length + fileBytes.length + tail.length);
  out.set(head1, 0);
  out.set(fileBytes, head1.length);
  out.set(tail, head1.length + fileBytes.length);
  return out;
}

/** Upload a 3D model (.glb bytes) to Roblox as a new asset the account owns, polling
 *  the Open Cloud operation until it resolves. Returns the new numeric asset id, or
 *  null on any failure (unsupported format, quota, network, timeout). */
export async function uploadRobloxModelAsset(
  apiKey: string, creator: RobloxCreator, glbUrlOrDataUrl: string, displayName: string, description: string,
): Promise<string | null> {
  const file = await materializeBytes(glbUrlOrDataUrl);
  if (!file) return null;
  try {
    const boundary = `yield${crypto.randomUUID().replace(/-/g, '')}`;
    const requestJson = JSON.stringify({
      assetType: 'Model',
      displayName: displayName.slice(0, 50) || 'Yield AI model',
      description: description.slice(0, 1000),
      creationContext: { creator: creator.type === 'Group' ? { groupId: Number(creator.id) } : { userId: Number(creator.id) } },
    });
    const body = buildMultipart(boundary, requestJson, file.bytes, 'model.glb', file.mime || 'model/gltf-binary');
    const createRes = await fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    if (!createRes.ok) return null;
    const op: any = await createRes.json().catch(() => null);
    if (!op) return null;
    if (op.done && op.response?.assetId) return String(op.response.assetId);
    const opPath: string | undefined = op.path;
    if (!opPath) return null;

    // The upload is processed asynchronously — poll briefly (Open Cloud asset
    // processing is typically seconds, not minutes, for a small mesh).
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const pr = await fetch(`https://apis.roblox.com/assets/v1/${opPath.replace(/^\/+/, '')}`, { headers: { 'x-api-key': apiKey, accept: 'application/json' } });
      if (!pr.ok) continue;
      const pd: any = await pr.json().catch(() => null);
      if (pd?.done && pd.response?.assetId) return String(pd.response.assetId);
      if (pd?.done) return null; // done with an error, not a result
    }
    return null;
  } catch {
    return null;
  }
}
