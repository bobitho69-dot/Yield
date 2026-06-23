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
import { json, error } from '../lib/response';
import { PRIVACY_NOTICE, type AuditInput, type AuditLevel } from '../lib/audit';
import { auditResponse, securityTier, scanGate, FREE_SCANS_PER_DAY, PRO_SCANS_PER_DAY } from './audit';
import { createSecurityCheckout } from '../lib/billing';
import {
  getProject, getProjectFiles, listProjects, getGithubAuth, listAuditRunsBySource,
  listAuditIgnores, addAuditIgnore, removeAuditIgnore, upsertFile, setProjectCode,
} from '../lib/db';
import { decryptToken, listRepos, listCommits, getCommitFiles, getRepoFile, putRepoFile } from '../lib/github';
import { chat } from '../lib/nvidia';
import { resolveModel } from '../config/models';

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
  if (action === 'history') return history(c);
  if (action === 'ignores') return ignores(req, c);
  if (action === 'fix' && req.method === 'POST') return fix(req, c);
  if (action === 'checkout' && req.method === 'POST') return checkout(c);
  if (action === 'scan' && req.method === 'POST') return scan(req, c);
  return error(404, 'Not found');
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
async function aiFix(c: Ctx, path: string, content: string, f: any): Promise<{ fixed: string; explanation: string } | null> {
  const sys = `You are a senior security engineer. The given file "${path}" contains a ${f.type} vulnerability (${f.cwe}) at/near line ${f.line}: ${f.description || ''}. Return the COMPLETE corrected contents of the file that fixes ONLY this vulnerability while preserving all other behavior, structure, and style. Output ONLY the full file content — no markdown fences, no commentary.`;
  const key = c.env.YIELDNVIDIAAIKEY || c.env.NVIDIA_API_KEY;
  for (const id of ['nemotron-3-ultra', 'glm-5.1', 'deepseek-v4-flash']) {
    try {
      const m = resolveModel(id);
      const { text } = await chat({
        baseUrl: c.env.NVIDIA_CHAT_BASE, apiKey: key, apiKeyBackup: c.env.NVIDIA_API_KEY_BACKUP || undefined,
        model: m.modelId, messages: [{ role: 'system', content: sys }, { role: 'user', content: content.slice(0, 40000) }],
        temperature: 0.1, max_tokens: 9000, timeoutMs: 120000,
      });
      const fixed = stripFences(text);
      if (fixed && fixed.length > 20 && fixed !== content.trim()) {
        return { fixed, explanation: `Rewrote ${path} to fix ${f.type} (${f.cwe}) near line ${f.line}.` };
      }
    } catch { /* try the next model */ }
  }
  return null;
}

// POST /api/security/fix — AI auto-fix one finding (Pro). Optionally apply it to the source.
async function fix(req: Request, c: Ctx): Promise<Response> {
  const gate = await scanGate(c, true); // AI feature -> Pro + fair use
  if (!gate.ok) return error(gate.status, gate.error || 'Locked', { code: gate.code });
  const body = (await req.json().catch(() => ({}))) as any;
  const finding = body.finding || {};
  const filePath = String(body.file || finding.location?.file || '');
  if (!filePath) return error(400, 'file required');
  const apply = body.apply === true;

  // Load the current file content from the source.
  let content = '';
  let repoCtx: { token: string; repo: string; branch: string } | null = null;
  if (body.source === 'repo') {
    if (!c.user) return error(401, 'Sign in required.', { code: 'login_required' });
    const repo = String(body.repo || '');
    const auth = await getGithubAuth(c.env, c.user.id);
    if (!auth) return error(400, 'Connect GitHub first.', { code: 'github_not_connected' });
    const token = await decryptToken(c.env, auth.tokenEnc);
    const branch = String(body.branch || 'main');
    const rf = await getRepoFile(token, repo, branch, filePath);
    if (!rf) return error(404, 'File not found in repo.');
    content = rf.content; repoCtx = { token, repo, branch };
  } else {
    const project = await getProject(c.env, String(body.projectId || ''));
    if (!project) return error(404, 'Project not found');
    if (c.user && project.user_id !== c.user.id) return error(403, 'Not your project');
    const files = await getProjectFiles(c.env, project);
    const ff = files.find((x) => x.path === filePath);
    if (!ff) return error(404, 'File not found in project.');
    content = ff.content;
  }

  const out = await aiFix(c, filePath, content, { type: finding.type, cwe: finding.cwe, line: finding.location?.line || body.line || 0, description: finding.description });
  if (!out) return error(502, 'Could not generate a fix — try again or fix it manually.');

  let applied = false;
  if (apply) {
    try {
      if (repoCtx) {
        await putRepoFile(repoCtx.token, repoCtx.repo, repoCtx.branch, filePath, out.fixed, `Yield Security: fix ${finding.type || 'vulnerability'} in ${filePath}`);
        applied = true;
      } else if (body.projectId) {
        await upsertFile(c.env, String(body.projectId), filePath, out.fixed);
        if (filePath === 'index.html') await setProjectCode(c.env, String(body.projectId), out.fixed);
        applied = true;
      }
    } catch (e: any) { return json({ file: filePath, fixedContent: out.fixed, explanation: out.explanation, applied: false, applyError: String(e?.message || e).slice(0, 200) }); }
  }
  return json({ file: filePath, fixedContent: out.fixed, explanation: out.explanation, applied });
}
