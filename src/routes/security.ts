// Yield Security — the standalone, subscription-gated product.
//   GET  /api/security/status                 -> { active, priceConfigured, projects, github, privacyNotice }
//   GET  /api/security/repos                  -> { repos }            (the user's GitHub repos)
//   POST /api/security/checkout               -> { url }              (Stripe checkout for the sub)
//   POST /api/security/scan { source, projectId|repo, branch?, level } -> findings + score (SSE/JSON)
//   GET  /api/security/history?source=...     -> score trend (metadata only)
//
// Scans either a Yield PROJECT or a connected GITHUB REPO. The whole product requires the
// Yield Security subscription (open testing mode unlocks it for demos). Code is fetched,
// analyzed in-memory, and discarded — only finding metadata is stored.

import type { Ctx } from '../types';
import { json, error, hmac, safeEqual, newId, now } from '../lib/response';
import { PRIVACY_NOTICE, type AuditInput, type AuditLevel } from '../lib/audit';
import { auditResponse, securityTier, scanGate, FREE_SCANS_PER_DAY, PRO_SCANS_PER_DAY } from './audit';
import { createSecurityCheckout } from '../lib/billing';
import {
  getProject, getProjectFiles, listProjects, getGithubAuth, listAuditRunsBySource,
  listAuditIgnores, addAuditIgnore, removeAuditIgnore, upsertFile, setProjectCode,
  addMonitor, listMonitors, getMonitor, getMonitorByRepo, removeMonitor, touchMonitor, listAllMonitors, setMonitorAutoFix,
  getIntegrations, setIntegrations, overviewStats, recordAuditRun, recentAuditRuns, latestFindingTypes, getUser, type MonitorRow,
} from '../lib/db';
import { decryptToken, encryptToken, listRepos, listCommits, getCommitFiles, getRepoFile, putRepoFile, createWebhook, deleteWebhook } from '../lib/github';
import { notifyScan, postSlack, type IntegrationConfig } from '../lib/integrations';
import type { AuditFinding } from '../lib/audit';
import { computeAudit, scansUsedToday } from './audit';
import { chat } from '../lib/nvidia';
import { resolveModel, keyForModel } from '../config/models';

const LEVELS: AuditLevel[] = ['basic', 'detailed', 'compliance'];

// Only scan source/text files — skip images, fonts, binaries, lockfiles, vendored deps.
const CODE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|py|go|java|rb|php|rs|c|h|cpp|cs|kt|swift|scala|html?|vue|svelte|css|scss|json|ya?ml|toml|sql|sh|env|tf|gradle)$/i;
const SKIP_PATH = /(?:^|\/)(?:node_modules|vendor|dist|build|\.min\.|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)/i;

function codeFilesOnly(files: AuditInput[]): AuditInput[] {
  return files.filter((f) => CODE_EXT.test(f.path) && !SKIP_PATH.test(f.path) && f.content.length < 600_000).slice(0, 60);
}

export async function handleSecurity(req: Request, c: Ctx, action?: string): Promise<Response> {
  if (action === 'status') return status(c);
  if (action === 'repos') return repos(c);
  if (action === 'webhook') return handleSecurityWebhook(req, c);
  if (action === 'history') return history(c);
  if (action === 'overview') return overview(c);
  if (action === 'monitors') return monitors(req, c);
  if (action === 'integrations') return integrations(req, c);
  if (action === 'ignores') return ignores(req, c);
  if (action === 'fix' && req.method === 'POST') return fix(req, c);
  if (action === 'fix-all' && req.method === 'POST') return fixAll(req, c);
  if (action === 'fix-status') return fixStatus(c);
  if (action === 'checkout' && req.method === 'POST') return checkout(c);
  if (action === 'scan' && req.method === 'POST') return scan(req, c);
  return error(404, 'Not found');
}

// GET /api/security/overview — latest score per source + monitors + score trend + usage.
async function overview(c: Ctx): Promise<Response> {
  if (!c.user) return json({ sources: [], monitors: [], trend: [], usage: null });
  const tier = await securityTier(c);
  const [{ results: sources }, { results: mons }, { results: trend }, { results: topTypes }, used, u] = await Promise.all([
    overviewStats(c.env, c.user.id), listMonitors(c.env, c.user.id), recentAuditRuns(c.env, c.user.id, 40), latestFindingTypes(c.env, c.user.id), scansUsedToday(c), getUser(c.env, c.user.id),
  ]);
  return json({
    sources, monitors: mons, tier, topTypes,
    trend: (trend as any[]).slice().reverse(), // oldest -> newest
    usage: { usedToday: used, cap: tier === 'pro' ? PRO_SCANS_PER_DAY : FREE_SCANS_PER_DAY, unlimited: c.env.AUTH_ENABLED === 'false' },
    account: { plan: u?.plan ?? 'free', security_active: !!u?.security_active, hasCustomer: !!u?.stripe_customer_id },
  });
}

// GET/POST/DELETE /api/security/monitors — continuous monitoring of a GitHub repo.
async function monitors(req: Request, c: Ctx): Promise<Response> {
  if ((await securityTier(c)) !== 'pro') return error(402, 'Continuous monitoring is a Yield Security (Pro) feature.', { code: 'security_required' });
  if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });
  if (req.method === 'GET') return json({ monitors: (await listMonitors(c.env, c.user.id)).results });

  const body = (await req.json().catch(() => ({}))) as any;
  const repo = String(body.repo || '');
  if (!/^[^/]+\/[^/]+$/.test(repo)) return error(400, 'repo must be "owner/name"');
  const auth = await getGithubAuth(c.env, c.user.id);
  if (!auth) return error(400, 'Connect GitHub first.', { code: 'github_not_connected' });
  const token = await decryptToken(c.env, auth.tokenEnc);

  if (req.method === 'POST') {
    if (await getMonitor(c.env, c.user.id, repo)) return json({ ok: true, already: true });
    let hookId: number | null = null;
    if (c.env.GITHUB_WEBHOOK_SECRET) {
      try { hookId = await createWebhook(token, repo, `${c.env.APP_URL}/api/security/webhook`, c.env.GITHUB_WEBHOOK_SECRET); }
      catch (e: any) { return error(502, `Could not add the webhook: ${String(e?.message || e).slice(0, 160)}`); }
    }
    await addMonitor(c.env, { user_id: c.user.id, repo, branch: String(body.branch || 'main'), hook_id: hookId, auto_fix: body.auto_fix === true });
    return json({ ok: true, monitoring: repo, scanOnPush: !!hookId });
  }
  if (req.method === 'PATCH') {
    if (!(await getMonitor(c.env, c.user.id, repo))) return error(404, 'Not monitored');
    await setMonitorAutoFix(c.env, c.user.id, repo, body.auto_fix === true);
    return json({ ok: true });
  }
  if (req.method === 'DELETE') {
    const m = await getMonitor(c.env, c.user.id, repo);
    if (m?.hook_id) await deleteWebhook(token, repo, m.hook_id);
    await removeMonitor(c.env, c.user.id, repo);
    return json({ ok: true });
  }
  return error(405, 'Method not allowed');
}

// GET/POST /api/security/integrations — Slack / Jira / GitHub PR-comment config.
async function integrations(req: Request, c: Ctx): Promise<Response> {
  if ((await securityTier(c)) !== 'pro') return error(402, 'Integrations are a Yield Security (Pro) feature.', { code: 'security_required' });
  if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });
  if (req.method === 'GET') {
    const g = await getIntegrations(c.env, c.user.id);
    return json({ integrations: g ? { slack: !!g.slack_webhook, jira: !!g.jira_base, jira_project: g.jira_project, post_pr_comments: g.post_pr_comments, post_commit_status: g.post_commit_status } : null });
  }
  if (req.method === 'POST') {
    const b = (await req.json().catch(() => ({}))) as any;
    const fields: any = {
      slack_webhook: typeof b.slack_webhook === 'string' ? b.slack_webhook : undefined,
      jira_base: typeof b.jira_base === 'string' ? b.jira_base : undefined,
      jira_email: typeof b.jira_email === 'string' ? b.jira_email : undefined,
      jira_project: typeof b.jira_project === 'string' ? b.jira_project : undefined,
      post_pr_comments: b.post_pr_comments ? 1 : 0,
      post_commit_status: b.post_commit_status === false ? 0 : 1,
    };
    if (typeof b.jira_token === 'string' && b.jira_token) fields.jira_token_enc = await encryptToken(c.env, b.jira_token);
    await setIntegrations(c.env, c.user.id, fields);
    return json({ ok: true });
  }
  return error(405, 'Method not allowed');
}

async function status(c: Ctx): Promise<Response> {
  const tier = await securityTier(c);
  let projects: { id: string; title: string; github_repo: string | null }[] = [];
  let github = { connected: false, login: null as string | null };
  if (c.user) {
    const { results } = await listProjects(c.env, c.user.id);
    projects = (results as any[]).map((p) => ({ id: p.id, title: p.title, github_repo: p.github_repo ?? null }));
    const auth = await getGithubAuth(c.env, c.user.id);
    github = { connected: !!auth, login: auth?.login ?? null };
  }
  return json({
    tier, // 'none' | 'free' | 'pro'
    active: tier === 'pro', // back-compat
    dailyCap: tier === 'pro' ? PRO_SCANS_PER_DAY : FREE_SCANS_PER_DAY,
    unlimited: c.env.AUTH_ENABLED === 'false',
    priceConfigured: !!c.env.SECURITY_PRICE_ID && !c.env.SECURITY_PRICE_ID.includes('PLACEHOLDER'),
    loginRequired: c.env.AUTH_ENABLED !== 'false' && !c.user,
    projects, github, privacyNotice: PRIVACY_NOTICE,
  });
}

async function repos(c: Ctx): Promise<Response> {
  if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });
  const auth = await getGithubAuth(c.env, c.user.id);
  if (!auth) return error(400, 'Connect GitHub first.', { code: 'github_not_connected' });
  const token = await decryptToken(c.env, auth.tokenEnc);
  return json({ repos: await listRepos(token) });
}

async function checkout(c: Ctx): Promise<Response> {
  if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });
  if (!c.env.SECURITY_PRICE_ID || c.env.SECURITY_PRICE_ID.includes('PLACEHOLDER')) {
    return error(400, 'Security subscription is not configured yet.', { code: 'not_configured' });
  }
  const url = await createSecurityCheckout(c.env, c.user.id, c.user.email);
  return json({ url });
}

async function history(c: Ctx): Promise<Response> {
  const source = c.url.searchParams.get('source');
  if (!source) return error(400, 'source required');
  const { results } = await listAuditRunsBySource(c.env, source);
  return json({ runs: results, privacyNotice: PRIVACY_NOTICE });
}

// POST /api/security/scan — fetch a project's or repo's files and audit them.
async function scan(req: Request, c: Ctx): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as any;
  const level: AuditLevel = LEVELS.includes(body?.level) ? body.level : 'detailed';
  const wantStream = body.stream !== false; // the product UI always streams
  const sourceKind = body.source === 'repo' ? 'repo' : 'project';

  // Tier gate + fair-use cap (free = basic only; AI = Pro; open testing = unlimited).
  const gate = await scanGate(c, level !== 'basic');
  if (!gate.ok) return error(gate.status, gate.error || 'Locked', { code: gate.code });

  let files: AuditInput[] = [];
  let sourceId = '';

  if (sourceKind === 'project') {
    if (!body.projectId) return error(400, 'projectId required');
    const project = await getProject(c.env, String(body.projectId));
    if (!project) return error(404, 'Project not found');
    if (c.user && project.user_id !== c.user.id) return error(403, 'Not your project');
    files = codeFilesOnly(await getProjectFiles(c.env, project));
    sourceId = `project:${project.id}`;
  } else {
    if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });
    const repo = String(body.repo || '');
    if (!/^[^/]+\/[^/]+$/.test(repo)) return error(400, 'repo must be "owner/name"');
    const auth = await getGithubAuth(c.env, c.user.id);
    if (!auth) return error(400, 'Connect GitHub first.', { code: 'github_not_connected' });
    const token = await decryptToken(c.env, auth.tokenEnc);
    const branch = String(body.branch || 'main');
    try {
      const commits = await listCommits(token, repo, branch, 1);
      const sha = commits[0]?.sha;
      if (!sha) return error(404, `No commits found on ${repo}@${branch}.`);
      files = codeFilesOnly(await getCommitFiles(token, repo, sha));
    } catch (e: any) {
      return error(502, `GitHub error: ${String(e?.message || e).slice(0, 200)}`);
    }
    sourceId = `repo:${repo}`;
  }

  if (!files.length) return error(400, 'No scannable source files were found.');
  return auditResponse(c, files, level, { stream: wantStream, projectId: sourceKind === 'project' ? String(body.projectId) : null, source: sourceId });
}

// GET/POST/DELETE /api/security/ignores — triage findings as false-positive / accepted.
async function ignores(req: Request, c: Ctx): Promise<Response> {
  if ((await securityTier(c)) === 'none') return error(401, 'Sign in to manage findings.', { code: 'login_required' });
  if (req.method === 'GET') {
    const source = c.url.searchParams.get('source');
    if (!source) return error(400, 'source required');
    const { results } = await listAuditIgnores(c.env, source);
    return json({ ignores: results });
  }
  const body = (await req.json().catch(() => ({}))) as any;
  if (!body.source || !body.type || !body.file) return error(400, 'source, type and file required');
  const line = body.line != null ? Number(body.line) : null;
  if (req.method === 'POST') {
    await addAuditIgnore(c.env, { user_id: c.user?.id ?? null, source: String(body.source), type: String(body.type), file: String(body.file), line, reason: body.reason ? String(body.reason) : null });
    return json({ ok: true });
  }
  if (req.method === 'DELETE') {
    await removeAuditIgnore(c.env, String(body.source), String(body.type), String(body.file), line);
    return json({ ok: true });
  }
  return error(405, 'Method not allowed');
}

// Ask a top model for the COMPLETE corrected file that fixes one finding (best-effort).
function stripFences(t: string): string {
  let s = (t || '').trim();
  const m = s.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (m) s = m[1];
  return s.trim();
}
type FixTarget = { type: string; cwe?: string; line: number; description?: string };
async function aiFixCore(env: Ctx['env'], path: string, content: string, findings: FixTarget[]): Promise<{ fixed: string; explanation: string } | null> {
  const plural = findings.length > 1;
  const list = findings.map((f) => `- ${f.type}${f.cwe ? ` (${f.cwe})` : ''} near line ${f.line}: ${f.description || ''}`).join('\n');
  const sys = `You are a senior security engineer. The given file "${path}" contains the following ${plural ? 'vulnerabilities' : 'vulnerability'}:\n${list}\nReturn the COMPLETE corrected contents of the file that fixes ${plural ? 'ALL of the above' : 'this vulnerability'} while preserving all other behavior, structure, and style. Output ONLY the full file content — no markdown fences, no commentary.`;
  const auditKey = env.YIELDNVIDIAAIKEY || env.NVIDIA_API_KEY;
  // Best security/coder models first — Claude Sonnet 5 & Fable 5 lead — then strong fallbacks.
  // Try each until one returns a usable rewrite. (GLM 5.1's upstream id is gone, so it's dropped.)
  for (const id of ['claude-sonnet-5-free', 'nemotron-3-ultra', 'deepseek-v4-pro', 'claude-fable-5-free', 'deepseek-v4-flash']) {
    try {
      const m = resolveModel(id);
      // Non-NVIDIA models (ZenMux Claude, etc.) use their own provider key; NVIDIA ones use the audit key + backup.
      const custom = !!m.provider.baseUrl;
      const { text } = await chat({
        baseUrl: m.provider.baseUrl || env.NVIDIA_CHAT_BASE,
        apiKey: custom ? keyForModel(env, m) : auditKey,
        apiKeyBackup: custom ? undefined : (env.NVIDIA_API_KEY_BACKUP || undefined),
        model: m.modelId, messages: [{ role: 'system', content: sys }, { role: 'user', content: content.slice(0, 40000) }],
        temperature: 0.1, max_tokens: 9000, timeoutMs: 120000,
      });
      const fixed = stripFences(text);
      if (fixed && fixed.length > 20 && fixed !== content.trim()) {
        return {
          fixed,
          explanation: plural
            ? `Rewrote ${path} to fix ${findings.length} findings.`
            : `Rewrote ${path} to fix ${findings[0].type}${findings[0].cwe ? ` (${findings[0].cwe})` : ''} near line ${findings[0].line}.`,
        };
      }
    } catch { /* try the next model */ }
  }
  return null;
}

// --- Background fix jobs (KV-backed) --------------------------------------------------
// An AI fix is a slow model call (sometimes several, back to back, for /fix-all) followed
// by a real GitHub commit — long enough that blocking the HTTP request on it is a bad
// experience and risks a Worker timeout. So /fix and /fix-all validate synchronously, then
// hand the actual work to a background task (via waitUntil) and return a jobId right away.
// The fix keeps running — and still gets committed — even if the tab is closed; the client
// polls /fix-status to find out when it's done.
interface FixJob {
  status: 'running' | 'done' | 'error';
  kind: 'single' | 'all';
  startedAt: number;
  updatedAt: number;
  filesDone?: number;
  filesTotal?: number;
  result?: any;
  error?: string;
}
const FIX_JOB_TTL = 3600; // 1 hour — plenty for a client to poll to completion
const fixJobKey = (id: string) => `secfix:${id}`;
async function putFixJob(env: Ctx['env'], id: string, job: FixJob): Promise<void> {
  try { await env.KV.put(fixJobKey(id), JSON.stringify(job), { expirationTtl: FIX_JOB_TTL }); } catch { /* best-effort */ }
}
async function getFixJob(env: Ctx['env'], id: string): Promise<FixJob | null> {
  try { const raw = await env.KV.get(fixJobKey(id)); return raw ? (JSON.parse(raw) as FixJob) : null; } catch { return null; }
}

// GET /api/security/fix-status?id=<jobId> — poll a background /fix or /fix-all job.
async function fixStatus(c: Ctx): Promise<Response> {
  const id = c.url.searchParams.get('id') || '';
  if (!id) return error(400, 'id required');
  const job = await getFixJob(c.env, id);
  if (!job) return error(404, 'Job not found or expired.');
  return json({ jobId: id, ...job });
}

// POST /api/security/fix — AI auto-fix one finding (Pro). Kicks off in the background;
// returns { jobId } immediately. Poll /fix-status?id=<jobId> for the result.
async function fix(req: Request, c: Ctx): Promise<Response> {
  const gate = await scanGate(c, true); // AI feature -> Pro + fair use
  if (!gate.ok) return error(gate.status, gate.error || 'Locked', { code: gate.code });
  const body = (await req.json().catch(() => ({}))) as any;
  const finding = body.finding || {};
  const filePath = String(body.file || finding.location?.file || '');
  if (!filePath) return error(400, 'file required');
  const apply = body.apply === true;

  if (body.source === 'repo') {
    if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });
    if (!String(body.repo || '')) return error(400, 'repo required');
    const auth = await getGithubAuth(c.env, c.user.id);
    if (!auth) return error(400, 'Connect GitHub first.', { code: 'github_not_connected' });
  } else if (!body.projectId) {
    return error(400, 'projectId required');
  }

  const jobId = newId();
  const startedAt = now();
  await putFixJob(c.env, jobId, { status: 'running', kind: 'single', startedAt, updatedAt: startedAt });
  c.ctx.waitUntil(runFixJob(c.env, c.user?.id ?? null, jobId, startedAt, {
    filePath, finding, apply, source: body.source, repo: body.repo, branch: body.branch, projectId: body.projectId,
  }));
  return json({ jobId, status: 'running' });
}

async function runFixJob(
  env: Ctx['env'], userId: string | null, jobId: string, startedAt: number,
  input: { filePath: string; finding: any; apply: boolean; source?: string; repo?: string; branch?: string; projectId?: string },
): Promise<void> {
  try {
    let content = '';
    let repoCtx: { token: string; repo: string; branch: string } | null = null;
    if (input.source === 'repo') {
      const auth = userId ? await getGithubAuth(env, userId) : null;
      if (!auth) throw new Error('Connect GitHub first.');
      const token = await decryptToken(env, auth.tokenEnc);
      const branch = String(input.branch || 'main');
      const rf = await getRepoFile(token, String(input.repo), branch, input.filePath);
      if (!rf) throw new Error('File not found in repo.');
      content = rf.content; repoCtx = { token, repo: String(input.repo), branch };
    } else {
      const project = await getProject(env, String(input.projectId || ''));
      if (!project) throw new Error('Project not found.');
      const files = await getProjectFiles(env, project);
      const ff = files.find((x) => x.path === input.filePath);
      if (!ff) throw new Error('File not found in project.');
      content = ff.content;
    }

    const out = await aiFixCore(env, input.filePath, content, [{
      type: input.finding.type, cwe: input.finding.cwe, line: input.finding.location?.line || 0, description: input.finding.description,
    }]);
    if (!out) throw new Error('Could not generate a fix — try again or fix it manually.');

    let applied = false; let applyError: string | undefined;
    if (input.apply) {
      try {
        if (repoCtx) {
          await putRepoFile(repoCtx.token, repoCtx.repo, repoCtx.branch, input.filePath, out.fixed, `Yield Security: fix ${input.finding.type || 'vulnerability'} in ${input.filePath}`);
          applied = true;
        } else if (input.projectId) {
          await upsertFile(env, String(input.projectId), input.filePath, out.fixed);
          if (input.filePath === 'index.html') await setProjectCode(env, String(input.projectId), out.fixed);
          applied = true;
        }
      } catch (e: any) { applyError = String(e?.message || e).slice(0, 200); }
    }
    await putFixJob(env, jobId, {
      status: 'done', kind: 'single', startedAt, updatedAt: now(),
      result: { file: input.filePath, fixedContent: out.fixed, explanation: out.explanation, applied, applyError },
    });
  } catch (e: any) {
    await putFixJob(env, jobId, { status: 'error', kind: 'single', startedAt, updatedAt: now(), error: String(e?.message || e).slice(0, 300) });
  }
}

// POST /api/security/fix-all — AI auto-fix every given finding, grouped by file (one AI
// call + one commit per file). "For you" bulk version of /fix — the whole reason Yield
// Security can push fixes on your behalf instead of one click at a time. Runs in the
// background (see FixJob above); returns { jobId } immediately, with live per-file
// progress (filesDone/filesTotal) visible via /fix-status while it works.
const FIX_ALL_MAX_FILES = 12;
async function fixAll(req: Request, c: Ctx): Promise<Response> {
  const gate = await scanGate(c, true); // one fair-use slot for the whole batch, not per file
  if (!gate.ok) return error(gate.status, gate.error || 'Locked', { code: gate.code });
  const body = (await req.json().catch(() => ({}))) as any;
  const findings: any[] = Array.isArray(body.findings) ? body.findings : [];
  const apply = body.apply === true;

  const byFile = new Map<string, FixTarget[]>();
  for (const f of findings) {
    const file = String(f.location?.file || f.file || '');
    if (!file || file.indexOf('.') < 0) continue; // skip anything without a real path
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push({ type: f.type, cwe: f.cwe, line: f.location?.line || 0, description: f.description });
  }
  if (!byFile.size) return error(400, 'No fixable findings (missing file paths).');

  if (body.source === 'repo') {
    if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });
    if (!String(body.repo || '')) return error(400, 'repo required');
    const auth = await getGithubAuth(c.env, c.user.id);
    if (!auth) return error(400, 'Connect GitHub first.', { code: 'github_not_connected' });
  } else if (!body.projectId) {
    return error(400, 'projectId required');
  }

  const entries = [...byFile.entries()].slice(0, FIX_ALL_MAX_FILES);
  const skipped = Math.max(0, byFile.size - entries.length);
  const jobId = newId();
  const startedAt = now();
  await putFixJob(c.env, jobId, { status: 'running', kind: 'all', startedAt, updatedAt: startedAt, filesDone: 0, filesTotal: entries.length });
  c.ctx.waitUntil(runFixAllJob(c.env, c.user?.id ?? null, jobId, startedAt, entries, apply, skipped, {
    source: body.source, repo: body.repo, branch: body.branch, projectId: body.projectId,
  }));
  return json({ jobId, status: 'running', filesTotal: entries.length });
}

async function fixOneFile(
  env: Ctx['env'], file: string, fs: FixTarget[], apply: boolean,
  repoCtx: { token: string; repo: string; branch: string } | null,
  project: { id: string } | null, projectFiles: { path: string; content: string }[] | null,
): Promise<{ file: string; findings: number; applied: boolean; error?: string }> {
  try {
    let content = '';
    if (repoCtx) {
      const rf = await getRepoFile(repoCtx.token, repoCtx.repo, repoCtx.branch, file);
      if (!rf) return { file, findings: fs.length, applied: false, error: 'not found in repo' };
      content = rf.content;
    } else {
      const ff = projectFiles!.find((x) => x.path === file);
      if (!ff) return { file, findings: fs.length, applied: false, error: 'not found in project' };
      content = ff.content;
    }
    const out = await aiFixCore(env, file, content, fs);
    if (!out) return { file, findings: fs.length, applied: false, error: 'AI fix failed' };
    let applied = false;
    if (apply) {
      if (repoCtx) {
        await putRepoFile(repoCtx.token, repoCtx.repo, repoCtx.branch, file, out.fixed, `Yield Security: auto-fix ${fs.length} finding${fs.length > 1 ? 's' : ''} in ${file}`);
        applied = true;
      } else if (project) {
        await upsertFile(env, project.id, file, out.fixed);
        if (file === 'index.html') await setProjectCode(env, project.id, out.fixed);
        applied = true;
      }
    }
    return { file, findings: fs.length, applied };
  } catch (e: any) {
    return { file, findings: fs.length, applied: false, error: String(e?.message || e).slice(0, 200) };
  }
}

async function runFixAllJob(
  env: Ctx['env'], userId: string | null, jobId: string, startedAt: number,
  entries: [string, FixTarget[]][], apply: boolean, skipped: number,
  src: { source?: string; repo?: string; branch?: string; projectId?: string },
): Promise<void> {
  let repoCtx: { token: string; repo: string; branch: string } | null = null;
  let project: { id: string } | null = null;
  let projectFiles: { path: string; content: string }[] | null = null;
  try {
    if (src.source === 'repo') {
      const auth = userId ? await getGithubAuth(env, userId) : null;
      if (!auth) throw new Error('Connect GitHub first.');
      const token = await decryptToken(env, auth.tokenEnc);
      repoCtx = { token, repo: String(src.repo), branch: String(src.branch || 'main') };
    } else {
      const p = await getProject(env, String(src.projectId || ''));
      if (!p) throw new Error('Project not found.');
      project = { id: p.id };
      projectFiles = await getProjectFiles(env, p);
    }
  } catch (e: any) {
    await putFixJob(env, jobId, { status: 'error', kind: 'all', startedAt, updatedAt: now(), error: String(e?.message || e).slice(0, 300) });
    return;
  }

  const results: { file: string; findings: number; applied: boolean; error?: string }[] = [];
  for (const [file, fs] of entries) {
    results.push(await fixOneFile(env, file, fs, apply, repoCtx, project, projectFiles));
    await putFixJob(env, jobId, { status: 'running', kind: 'all', startedAt, updatedAt: now(), filesDone: results.length, filesTotal: entries.length });
  }
  await putFixJob(env, jobId, {
    status: 'done', kind: 'all', startedAt, updatedAt: now(), filesDone: results.length, filesTotal: entries.length,
    result: { results, filesFixed: results.filter((r) => r.applied).length, skipped },
  });
}

// Auto-fix critical/high findings on a monitored repo and commit directly (bounded, best-effort).
// This is the "push and commit the fixes for you" path — no manual click required.
const AUTO_FIX_MAX_FILES = 5;
const AUTO_FIX_MAX_FINDINGS = 10;
async function autoFixMonitor(env: Ctx['env'], mon: MonitorRow, token: string, branch: string, findings: AuditFinding[]): Promise<number> {
  const fixable = findings.filter((f) => (f.severity === 'CRITICAL' || f.severity === 'HIGH') && !!f.location?.file && f.location.file.indexOf('.') > -1).slice(0, AUTO_FIX_MAX_FINDINGS);
  if (!fixable.length) return 0;
  const byFile = new Map<string, FixTarget[]>();
  for (const f of fixable) {
    const file = f.location.file;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push({ type: f.type, cwe: f.cwe, line: f.location.line, description: f.description });
  }
  let fixedFiles = 0;
  for (const [file, fs] of [...byFile.entries()].slice(0, AUTO_FIX_MAX_FILES)) {
    try {
      const rf = await getRepoFile(token, mon.repo, branch, file);
      if (!rf) continue;
      const out = await aiFixCore(env, file, rf.content, fs);
      if (!out) continue;
      await putRepoFile(token, mon.repo, branch, file, out.fixed, `Yield Security: auto-fix ${fs.length} finding${fs.length > 1 ? 's' : ''} in ${file}`);
      fixedFiles++;
    } catch { /* one file failing must not break the rest */ }
  }
  return fixedFiles;
}

// Scan one monitored repo (at `sha`, or latest on its branch), record it, and notify.
async function scanRepoMonitor(env: Ctx['env'], mon: MonitorRow, appUrl: string, sha?: string): Promise<void> {
  try {
    if (!mon.github_token_enc) return;
    const token = await decryptToken(env, mon.github_token_enc);
    const branch = mon.branch || 'main';
    let useSha = sha;
    if (!useSha) { const cs = await listCommits(token, mon.repo, branch, 1); useSha = cs[0]?.sha; }
    if (!useSha) return;
    const files = codeFilesOnly(await getCommitFiles(token, mon.repo, useSha));
    if (!files.length) return;
    const result = await computeAudit(env, files, 'basic');
    await recordAuditRun(env, { source: `repo:${mon.repo}`, user_id: mon.user_id, level: 'basic', score: result.codeHealthScore, summary: result.summary, findings: result.findings });
    await touchMonitor(env, mon.repo, result.codeHealthScore);

    const fixedFiles = mon.auto_fix ? await autoFixMonitor(env, mon, token, branch, result.findings) : 0;

    const integ = await getIntegrations(env, mon.user_id);
    await notifyScan(env, (integ as IntegrationConfig | null), { repo: mon.repo, sha: useSha, githubToken: token, appUrl }, result);
    if (fixedFiles > 0 && integ?.slack_webhook) {
      await postSlack(integ.slack_webhook, `🔧 Yield Security auto-fixed ${fixedFiles} file${fixedFiles > 1 ? 's' : ''} in ${mon.repo} and pushed the commit to ${branch}.`);
    }
  } catch { /* one repo failing must not break the batch */ }
}

// POST /api/security/webhook — GitHub push/PR webhook. Verifies the signature, then scans
// the pushed commit and reports back (commit status / PR comment / Slack / Jira).
export async function handleSecurityWebhook(req: Request, c: Ctx): Promise<Response> {
  if (req.method !== 'POST') return error(405, 'POST only');
  const raw = await req.text();
  const sig = req.headers.get('x-hub-signature-256') || '';
  if (!c.env.GITHUB_WEBHOOK_SECRET) return error(503, 'Monitoring not configured');
  const expected = 'sha256=' + (await hmac(c.env.GITHUB_WEBHOOK_SECRET, raw));
  if (!sig || !safeEqual(sig, expected)) return error(401, 'Bad signature');

  const event = req.headers.get('x-github-event') || '';
  let payload: any = {};
  try { payload = JSON.parse(raw); } catch { return json({ ok: true }); }
  if (event === 'ping') return json({ ok: true, pong: true });

  const repo = payload.repository?.full_name;
  const sha = event === 'pull_request' ? payload.pull_request?.head?.sha : payload.after;
  if (!repo || !sha || /^0+$/.test(String(sha))) return json({ ok: true, skipped: true });

  const mon = await getMonitorByRepo(c.env, repo);
  if (!mon) return json({ ok: true, unmonitored: true });
  // Scan in the background so GitHub gets a fast 200.
  c.ctx.waitUntil(scanRepoMonitor(c.env, mon, c.env.APP_URL, sha));
  return json({ ok: true, scanning: repo });
}

// Cron entry: re-scan every monitored repo (daily). Bounded + best-effort.
export async function runScheduledScans(env: Ctx['env']): Promise<void> {
  const { results } = await listAllMonitors(env);
  for (const mon of results.slice(0, 200)) await scanRepoMonitor(env, mon, env.APP_URL);
}
