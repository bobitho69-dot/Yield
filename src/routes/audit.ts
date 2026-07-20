// Audit execution + the builder's "lite teaser" endpoint.
//   POST /api/audit            { files|code, language?, level?, projectId?, stream? } -> findings + codeHealthScore
//   GET  /api/audit/history?project=ID                                               -> score trend (metadata only)
//
// "basic" (deterministic patterns) is FREE — it's the teaser shown in the builder. The
// "detailed"/"compliance" AI scans are part of the paid Yield Security product, so they
// require the security entitlement (see securityEntitled). The standalone product surface
// (scan GitHub repos / Yield projects) lives in routes/security.ts and reuses auditResponse.

import type { Ctx } from '../types';
import { json, error, sse } from '../lib/response';
import { recordGeneration } from '../lib/usage';
import { logUsage, recordAuditRun, listAuditRuns, getProject, getUser } from '../lib/db';
import {
  scanStatic, buildResult, PRIVACY_NOTICE,
  type AuditInput, type AuditLevel, type AuditFinding,
} from '../lib/audit';
import { onlineScan } from '../lib/scaOnline';
import { listAuditIgnores } from '../lib/db';
import { auditAI, AUDIT_MODELS } from '../lib/auditAI';

const LEVELS: AuditLevel[] = ['basic', 'detailed', 'compliance'];
const extFor: Record<string, string> = { python: 'py', go: 'go', java: 'java', typescript: 'ts', javascript: 'js', html: 'html' };

export function sha256hex(s: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(
    (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''),
  );
}

// --- Security product tiers + fair-use limits --------------------------------
// Free (logged-in, not subscribed): basic pattern scans only, a few per day.
// Pro (subscribed): AI ensemble + compliance, unlimited sources, generous fair-use cap
//   (protects the shared NVIDIA quota). Open testing mode is UNLIMITED (inf) for demos.
export type SecTier = 'none' | 'free' | 'pro';
export const FREE_SCANS_PER_DAY = 3;
export const PRO_SCANS_PER_DAY = 60; // fair use — effectively unlimited for normal use

export async function securityTier(c: Ctx): Promise<SecTier> {
  if (c.env.AUTH_ENABLED === 'false') return 'pro'; // open testing: everything unlocked + unlimited
  if (!c.user) return 'none';
  const u = await getUser(c.env, c.user.id);
  return u && u.security_active ? 'pro' : 'free';
}

// Back-compat: "entitled" == has the paid product (Pro / open testing).
export async function securityEntitled(c: Ctx): Promise<boolean> {
  return (await securityTier(c)) === 'pro';
}

const today = () => new Date().toISOString().slice(0, 10);
async function dailyScans(c: Ctx, uid: string): Promise<number> {
  return parseInt((await c.env.KV.get(`secq:${uid}:${today()}`).catch(() => null)) || '0', 10) || 0;
}
async function bumpScans(c: Ctx, uid: string): Promise<void> {
  const k = `secq:${uid}:${today()}`;
  const n = (await dailyScans(c, uid)) + 1;
  await c.env.KV.put(k, String(n), { expirationTtl: 172800 }).catch(() => {});
}
export async function scansUsedToday(c: Ctx): Promise<number> {
  return c.user ? dailyScans(c, c.user.id) : 0;
}

export interface ScanGate { ok: boolean; status: number; error?: string; code?: string }

// Decide whether THIS scan may run (and reserve a daily slot when it can). Open testing
// is always allowed. usesAI requires Pro; free is basic-only with a small daily cap.
export async function scanGate(c: Ctx, usesAI: boolean): Promise<ScanGate> {
  if (c.env.AUTH_ENABLED === 'false') return { ok: true, status: 200 }; // testing = inf
  const tier = await securityTier(c);
  if (tier === 'none') return { ok: false, status: 401, error: 'Sign in to use Yield Security.', code: 'login_required' };
  if (usesAI && tier !== 'pro') {
    return { ok: false, status: 402, error: 'AI deep & compliance scans are a Yield Security (Pro) feature. Subscribe to unlock them — plus unlimited repos & projects.', code: 'security_required' };
  }
  const cap = tier === 'pro' ? PRO_SCANS_PER_DAY : FREE_SCANS_PER_DAY;
  const used = await dailyScans(c, c.user!.id);
  if (used >= cap) {
    return tier === 'pro'
      ? { ok: false, status: 429, error: `Fair-use limit reached (${cap} scans today) — this protects the shared model quota. Try again tomorrow.`, code: 'rate_limited' }
      : { ok: false, status: 402, error: `Free plan: ${cap} basic scans/day. Upgrade to Yield Security for AI deep scans and unlimited usage.`, code: 'security_required' };
  }
  await bumpScans(c, c.user!.id);
  return { ok: true, status: 200 };
}

export function inputsFrom(body: any): AuditInput[] {
  if (Array.isArray(body?.files)) {
    return body.files
      .filter((f: any) => f && typeof f.content === 'string')
      .map((f: any) => ({ path: String(f.path || 'snippet.txt').slice(0, 200), content: String(f.content).slice(0, 600_000) }))
      .slice(0, 60);
  }
  if (typeof body?.code === 'string' && body.code.trim()) {
    const ext = extFor[String(body.language || '').toLowerCase()] || 'txt';
    return [{ path: `snippet.${ext}`, content: body.code.slice(0, 600_000) }];
  }
  return [];
}

// Persist ONLY metadata (score + finding type/severity/cwe/file/line) — never code.
async function persist(c: Ctx, projectId: string | null, source: string | null, level: AuditLevel, findings: AuditFinding[], score: number) {
  try {
    const summary = { critical: 0, high: 0, medium: 0, low: 0, total: findings.length };
    for (const f of findings) {
      if (f.severity === 'CRITICAL') summary.critical++; else if (f.severity === 'HIGH') summary.high++;
      else if (f.severity === 'MEDIUM') summary.medium++; else summary.low++;
    }
    await recordAuditRun(c.env, { project_id: projectId, source, user_id: c.user?.id ?? null, level, score, summary, findings });
    await logUsage(c.env, { user_id: c.user?.id ?? null, kind: 'audit' });
  } catch { /* metadata persistence is best-effort */ }
}

// Run a scan and return the result object (no HTTP) — used by scan-on-push + cron re-scans.
export async function computeAudit(env: Ctx['env'], files: AuditInput[], level: AuditLevel): Promise<ReturnType<typeof buildResult>> {
  const online = await onlineScan(env, files);
  let findings = scanStatic(files).concat(online.deps, online.license);
  if (level !== 'basic') findings = findings.concat(await auditAI(env, files, level));
  return buildResult(files, findings, level);
}

// A finding's stable key (type + file + line) — used for triage/ignore matching.
export function findingKey(f: AuditFinding): string { return `${f.type}|${f.location.file}|${f.location.line}`; }
async function loadIgnoreMatcher(c: Ctx, source: string | null): Promise<(f: AuditFinding) => boolean> {
  if (!source) return () => false;
  try {
    const { results } = await listAuditIgnores(c.env, source);
    const exact = new Set<string>(); const fileWide = new Set<string>();
    for (const r of results as any[]) (r.line ? exact : fileWide).add(`${r.type}|${r.file}${r.line ? '|' + r.line : ''}`);
    return (f) => exact.has(findingKey(f)) || fileWide.has(`${f.type}|${f.location.file}`);
  } catch { return () => false; }
}

// THE CORE: run an audit over a set of files at a level, stream or JSON, persist metadata.
// Shared by the builder teaser (/api/audit) and the product (/api/security/scan). Runs the
// full static suite (SAST + SCA + IaC), then the AI ensemble for detailed/compliance.
export async function auditResponse(
  c: Ctx, files: AuditInput[], level: AuditLevel, opts: { stream: boolean; projectId?: string | null; source?: string | null },
): Promise<Response> {
  const usesAI = level !== 'basic';
  const source = opts.source ?? (opts.projectId ? `project:${opts.projectId}` : null);
  const ignored = await loadIgnoreMatcher(c, source);

  if (!opts.stream) {
    // Cache deterministic results in the edge cache, keyed by a content hash (AI is not).
    const cacheKey = !usesAI ? new Request(`https://audit.cache/${await sha256hex(level + ' ' + (source ?? '') + ' ' + files.map((f) => f.path + f.content).join(' '))}`) : null;
    if (cacheKey) {
      const hit = await caches.default.match(cacheKey).catch(() => undefined);
      if (hit) return new Response(hit.body, { headers: { 'content-type': 'application/json; charset=utf-8', 'x-audit-cache': 'hit' } });
    }
    const online = await onlineScan(c.env, files); // live OSV vulns + license compliance
    let findings = scanStatic(files).concat(online.deps, online.license);
    if (usesAI) { findings = findings.concat(await auditAI(c.env, files, level)); await recordGeneration(c); }
    findings = findings.filter((f) => !ignored(f));
    const result = buildResult(files, findings, level);
    await persist(c, opts.projectId ?? null, source, level, result.findings, result.codeHealthScore);
    const res = json(result);
    if (cacheKey) c.ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'max-age=3600' } })).catch(() => {}));
    return res;
  }

  const { response, send, close } = sse();
  const run = async () => {
    try {
      await send('meta', { level, models: usesAI ? AUDIT_MODELS : [], privacyNotice: PRIVACY_NOTICE, scannedFiles: files.length, aiNote: usesAI ? 'Deep scans send the code to the AI model for analysis only — it is never stored.' : '' });
      const online = await onlineScan(c.env, files); // live OSV vulns + license compliance
      const stat = scanStatic(files).concat(online.deps, online.license).filter((f) => !ignored(f));
      for (const f of stat) await send('finding', f);
      await send('progress', { stage: 'static', found: stat.length });
      const all: AuditFinding[] = [...stat];
      if (usesAI) {
        await auditAI(c.env, files, level, async ({ model, index, total, findings }) => {
          const keep = findings.filter((f) => !ignored(f));
          for (const f of keep) await send('finding', f);
          await send('progress', { stage: 'ai', model, index, total, found: keep.length });
          all.push(...keep);
        });
        await recordGeneration(c);
      }
      const result = buildResult(files, all, level);
      await persist(c, opts.projectId ?? null, source, level, result.findings, result.codeHealthScore);
      await send('done', result);
    } catch (e: any) {
      await send('error', { message: String(e?.message || e).slice(0, 300) });
    } finally {
      await close();
    }
  };
  c.ctx.waitUntil(run());
  return response;
}

// /api/audit — the builder's lite teaser (file-based). Basic is free; AI levels need the
// Yield Security subscription.
export async function handleAudit(req: Request, c: Ctx): Promise<Response> {
  if (req.method === 'GET') return handleAuditHistory(c);
  if (req.method !== 'POST') return error(405, 'POST only');

  const body = (await req.json().catch(() => ({}))) as any;
  const level: AuditLevel = LEVELS.includes(body?.level) ? body.level : 'basic';
  const files = inputsFrom(body);
  if (!files.length) return error(400, 'Provide code to audit: { files:[{path,content}] } or { code, language }.');
  const projectId: string | null = body.projectId ? String(body.projectId) : null;
  const wantStream = (body.stream !== false && (req.headers.get('accept') || '').includes('text/event-stream')) || body.stream === true;

  // The builder teaser: "basic" is free + local (no gate/quota). AI levels go through the
  // Yield Security tier gate (Pro-only + fair use).
  if (level !== 'basic') {
    const gate = await scanGate(c, true);
    if (!gate.ok) return error(gate.status, gate.error || 'Locked', { code: gate.code });
  }
  return auditResponse(c, files, level, { stream: wantStream, projectId });
}

// GET /api/audit/history?project=ID — score trend + severity counts over time (metadata).
async function handleAuditHistory(c: Ctx): Promise<Response> {
  const projectId = c.url.searchParams.get('project');
  if (!projectId) return error(400, 'project required');
  const project = await getProject(c.env, projectId);
  if (!project) return error(404, 'Project not found');
  if (c.user && project.user_id !== c.user.id) return error(403, 'Not your project');
  const { results } = await listAuditRuns(c.env, projectId);
  return json({ runs: results, privacyNotice: PRIVACY_NOTICE });
}
