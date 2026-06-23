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
} from '../lib/db';
import { decryptToken, listRepos, listCommits, getCommitFiles } from '../lib/github';

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
