// Live Roblox documentation lookup for the AI. Roblox's official engine API
// reference and creator guides are open-sourced (github.com/Roblox/creator-docs,
// MIT-licensed, mirrors create.roblox.com/docs) as machine-generated YAML (one file
// per class/datatype) plus Markdown guide pages — fetched fresh via raw.githubusercontent.com
// so the AI can verify an exact property/method/event shape instead of guessing from
// training memory. DevForum community search is a third, best-effort source.
//
// Every source here is best-effort and capped by a short timeout: a slow, blocked, or
// malformed fetch just contributes nothing to the digest — this must never throw, and
// must never meaningfully slow down script generation.

import type { Env } from '../types';

const DOCS_RAW = 'https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us';
const DEVFORUM_SEARCH = 'https://devforum.roblox.com/search.json';
const UA = 'YieldRobloxDocs/1.0 (+https://github.com/Roblox/creator-docs consumer)';

async function fetchText(url: string, ms: number, headers?: Record<string, string>): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': UA, ...(headers || {}) } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// --- Class / datatype reference (content/en-us/reference/engine/{classes,datatypes}/*.yaml) ---
// Machine-generated, fixed 2-space-step indentation: a top-level `name:`/`summary:`,
// then `properties:` / `methods:` / `events:` / `constructors:` sections, each a list of
// `  - name: X` entries whose sibling fields (`summary:`, `type:`, `deprecation_message:`)
// are indented 4 spaces, with block-scalar (`|`) bodies indented 6 spaces. This is NOT a
// general YAML parser — it only needs to survive Roblox's own generator output.
function sectionRange(lines: string[], key: string): [number, number] | null {
  const s = lines.indexOf(`${key}:`);
  if (s === -1) return null;
  let e = lines.length;
  for (let i = s + 1; i < lines.length; i++) {
    if (/^[A-Za-z_]/.test(lines[i])) { e = i; break; }
  }
  return [s + 1, e];
}
function splitEntries(lines: string[], start: number, end: number): { name: string; body: string[] }[] {
  const starts: number[] = [];
  for (let i = start; i < end; i++) if (lines[i].startsWith('  - name: ')) starts.push(i);
  return starts.map((s, k) => ({
    name: lines[s].slice('  - name: '.length).trim(),
    body: lines.slice(s + 1, k + 1 < starts.length ? starts[k + 1] : end),
  }));
}
function fieldValue(body: string[], key: string, maxLines = 3): string {
  const re = new RegExp(`^    ${key}:\\s?(.*)$`);
  const idx = body.findIndex((l) => re.test(l));
  if (idx === -1) return '';
  let inline = (body[idx].match(re) || [])[1]?.trim() || '';
  // Strip one layer of matching YAML quotes (e.g. deprecation_message: '' is an
  // explicit EMPTY string, not the two-character truthy string "''").
  if (inline.length >= 2 && ((inline[0] === "'" && inline.endsWith("'")) || (inline[0] === '"' && inline.endsWith('"')))) {
    inline = inline.slice(1, -1);
  }
  if (inline && inline !== '|' && inline !== '>' && inline !== '>-' && inline !== '|-') return inline;
  const out: string[] = [];
  for (let i = idx + 1; i < body.length && out.length < maxLines; i++) {
    if (!body[i].startsWith('      ')) break;
    const t = body[i].trim();
    if (t) out.push(t);
  }
  return out.join(' ').slice(0, 240);
}
// Body of a TOP-LEVEL (0-indent key) block scalar, e.g. "summary: |\n  ...". Stops at
// the first dedented line — the next 0-indent key — rather than a fixed line count, so
// a one-line summary never bleeds into the "description:" key that follows it.
function topBlockScalar(lines: string[], key: string, maxLines = 4): string {
  const idx = lines.indexOf(`${key}: |`);
  if (idx === -1) return '';
  const out: string[] = [];
  for (let i = idx + 1; i < lines.length && out.length < maxLines; i++) {
    if (!lines[i].startsWith(' ')) break;
    const t = lines[i].trim();
    if (t) out.push(t);
  }
  return out.join(' ');
}

function condenseClassYaml(raw: string, fallbackName: string): string {
  const lines = raw.split('\n');
  const topName = (lines.find((l) => /^name: /.test(l)) || '').replace(/^name: /, '').trim() || fallbackName;
  const summary = topBlockScalar(lines, 'summary');

  const fmt = (e: { name: string; body: string[] }, withType: boolean) => {
    const dep = fieldValue(e.body, 'deprecation_message', 1);
    const type = withType ? fieldValue(e.body, 'type', 1) : '';
    const head = withType ? `${e.name}: ${type || '?'}` : `${e.name}(...)`;
    const s = fieldValue(e.body, 'summary');
    return `  ${head}${dep ? ' [DEPRECATED]' : ''}${s ? ' — ' + s.slice(0, 160) : ''}`;
  };

  const sections: [string, string, boolean][] = [
    ['properties', 'Properties', true],
    ['methods', 'Methods', false],
    ['events', 'Events', false],
    ['constructors', 'Constructors', false],
  ];
  const blocks: string[] = [`### ${topName} (Roblox reference)`];
  if (summary) blocks.push(summary);
  for (const [key, label, withType] of sections) {
    const range = sectionRange(lines, key);
    if (!range) continue;
    const entries = splitEntries(lines, range[0], range[1]).slice(0, 24);
    if (!entries.length) continue;
    blocks.push(`${label}:\n${entries.map((e) => fmt(e, withType)).join('\n')}`);
  }
  return blocks.join('\n').slice(0, 3200);
}

async function fetchClassOrDatatypeDoc(env: Env, name: string, ms: number): Promise<string | null> {
  if (!/^[A-Za-z0-9_]{2,60}$/.test(name)) return null;
  const cacheKey = `roblox_docs_class:${name}`;
  try {
    const cached = await env.KV.get(cacheKey);
    if (cached) return cached === '-' ? null : cached;
  } catch { /* KV best-effort */ }

  const [classRaw, dtRaw] = await Promise.all([
    fetchText(`${DOCS_RAW}/reference/engine/classes/${name}.yaml`, ms),
    fetchText(`${DOCS_RAW}/reference/engine/datatypes/${name}.yaml`, ms),
  ]);
  const raw = classRaw || dtRaw;
  const digest = raw ? condenseClassYaml(raw, name) : null;
  try { await env.KV.put(cacheKey, digest || '-', { expirationTtl: 60 * 60 * 24 * 14 }); } catch { /* best-effort */ }
  return digest;
}

// Pull candidate Roblox class/datatype names out of free text: PascalCase tokens,
// skipping ALL-CAPS acronyms (AI, UI, NPC — never real class names) and a short
// stoplist of common capitalized words that would otherwise waste a lookup.
const STOPWORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'What', 'When', 'Where', 'Which', 'How', 'Why',
  'Roblox', 'Studio', 'Script', 'Scripts', 'Please', 'Make', 'Build', 'Create', 'Add', 'Use',
  'Game', 'Player', 'Players', 'Yield',
]);
function candidateNames(text: string, max = 4): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const re = /\b[A-Z][A-Za-z0-9]{2,}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && found.length < max) {
    const w = m[0].split(/[:.]/)[0];
    if (w === w.toUpperCase() || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    found.push(w);
  }
  return found;
}

// --- Guide pages (curated, hand-verified paths — Roblox's docs have no public search
// API of their own, so this is a small keyword index into real content/en-us/*.md
// pages rather than a guess at every possible topic). ---
const GUIDE_TOPICS: { path: string; title: string; keywords: string[] }[] = [
  { path: 'scripting/events/remote.md', title: 'Remote events and callbacks', keywords: ['remote', 'remoteevent', 'remotefunction', 'fireserver', 'invokeserver', 'client-server'] },
  { path: 'scripting/events/index.md', title: 'Events overview', keywords: ['event', 'events', 'connect', 'signal'] },
  { path: 'scripting/index.md', title: 'Scripting overview', keywords: ['scripting', 'server script', 'localscript', 'modulescript'] },
  { path: 'workspace/raycasting.md', title: 'Raycasting', keywords: ['raycast', 'ray', 'raycastresult', 'raycastparams'] },
  { path: 'input/mouse-and-keyboard.md', title: 'Mouse and keyboard input', keywords: ['input', 'mouse', 'keyboard', 'userinputservice', 'contextactionservice'] },
  { path: 'characters/pathfinding.md', title: 'Pathfinding', keywords: ['pathfind', 'pathfindingservice', 'navigation', 'navmesh'] },
  { path: 'ui/index.md', title: 'User interface overview', keywords: ['ui', 'gui', 'screengui', 'frame', 'textbutton', 'guiobject'] },
  { path: 'art/modeling/surface-appearance.md', title: 'Surface appearance (PBR materials/textures)', keywords: ['texture', 'material', 'surfaceappearance', 'normal map', 'roughness', 'pbr', 'colormap', 'decal'] },
  { path: 'sound/index.md', title: 'Sound', keywords: ['sound', 'audio', 'soundservice'] },
  { path: 'animation/index.md', title: 'Animation', keywords: ['animation', 'animator', 'animationtrack', 'rig'] },
  { path: 'projects/assets/index.md', title: 'Assets and content IDs', keywords: ['asset', 'assetid', 'content', 'rbxassetid', 'contentid'] },
  { path: 'cloud-services/data-stores/index.md', title: 'Data stores', keywords: ['datastore', 'data store', 'save data', 'persist', 'globaldatastore'] },
  { path: 'players/leaderboards.md', title: 'Leaderboards', keywords: ['leaderboard', 'leaderstats', 'ranking'] },
];
function condenseMarkdown(raw: string, title: string, maxChars = 1400): string {
  let body = raw.replace(/^---[\s\S]*?---\n/, '');
  body = body.replace(/<[^>]+>/g, '');
  body = body.replace(/```[\s\S]*?```/g, (m) => m.slice(0, 240));
  body = body.replace(/\n{3,}/g, '\n\n').trim();
  return `### ${title} (Roblox guide)\n${body.slice(0, maxChars)}`;
}
async function fetchGuideDoc(query: string, ms: number): Promise<string | null> {
  const q = query.toLowerCase();
  let best: (typeof GUIDE_TOPICS)[number] | null = null;
  let bestScore = 0;
  for (const g of GUIDE_TOPICS) {
    const score = g.keywords.reduce((s, k) => s + (q.includes(k) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = g; }
  }
  if (!best) return null;
  const raw = await fetchText(`${DOCS_RAW}/${best.path}`, ms);
  return raw ? condenseMarkdown(raw, best.title) : null;
}

// --- DevForum community search (Discourse's public search.json — no auth). Purely
// best-effort: the host may be unreachable from some networks, and that's fine. ---
async function fetchDevForum(query: string, ms: number): Promise<string | null> {
  const raw = await fetchText(`${DEVFORUM_SEARCH}?q=${encodeURIComponent(query)}`, ms);
  if (!raw) return null;
  try {
    const data: any = JSON.parse(raw);
    const topics: any[] = Array.isArray(data?.topics) ? data.topics.slice(0, 3) : [];
    if (!topics.length) return null;
    const lines = topics
      .filter((t) => t?.title && t?.slug && t?.id)
      .map((t) => `- "${String(t.title).slice(0, 140)}" — https://devforum.roblox.com/t/${t.slug}/${t.id}`);
    return lines.length ? `### DevForum discussions for "${query}"\n${lines.join('\n')}` : null;
  } catch {
    return null;
  }
}

// --- Public entry points ------------------------------------------------------------

/** Lightweight auto-prefetch: pull class/datatype reference docs for any Roblox API
 *  names mentioned directly in free text (e.g. the user's own prompt), with no guide/
 *  DevForum lookup — kept fast enough to run before every generation call. */
export async function autoPrefetchDocs(env: Env, text: string): Promise<string> {
  const names = candidateNames(text, 3);
  if (!names.length) return '';
  const hits = await Promise.all(names.map((n) => fetchClassOrDatatypeDoc(env, n, 2500).catch(() => null)));
  return hits.filter(Boolean).join('\n\n');
}

/** Full targeted lookup for one AI-authored query (the `lookup_docs` op): class/datatype
 *  reference (if the query names one), a matching guide page, and DevForum discussion —
 *  each best-effort, run in parallel, cached per query. */
export async function lookupRobloxDocs(env: Env, rawQuery: string): Promise<{ text: string; hit: boolean }> {
  const query = String(rawQuery || '').trim().slice(0, 200);
  if (!query) return { text: '', hit: false };
  const cacheKey = `roblox_docs_q:${query.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 100)}`;
  try {
    const cached = await env.KV.get(cacheKey);
    if (cached) return { text: cached === '-' ? '' : cached, hit: cached !== '-' };
  } catch { /* KV best-effort */ }

  const names = candidateNames(query, 3);
  const [classHits, guideHit, devforumHit] = await Promise.all([
    Promise.all(names.map((n) => fetchClassOrDatatypeDoc(env, n, 4000).catch(() => null))),
    fetchGuideDoc(query, 4000).catch(() => null),
    fetchDevForum(query, 3500).catch(() => null),
  ]);
  const parts = [...classHits, guideHit, devforumHit].filter(Boolean) as string[];
  const text = parts.join('\n\n').slice(0, 6000);
  try { await env.KV.put(cacheKey, text || '-', { expirationTtl: 60 * 60 * 24 * 3 }); } catch { /* best-effort */ }
  return { text, hit: parts.length > 0 };
}
