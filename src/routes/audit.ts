// Security audit endpoint.
//   POST /api/audit            { files|code, language?, level?, projectId?, stream? } -> findings + codeHealthScore
//   GET  /api/audit/history?project=ID                                               -> score trend (metadata only)
//
// Levels: "basic" (deterministic patterns only — instant, no AI, no gate), "detailed"
// (patterns + AI ensemble over every top model, one at a time), "compliance" (detailed +
// GDPR/PCI focus). The analyzed code is NEVER stored — only finding metadata is persisted.

import type { Ctx } from '../types';
import { json, error, sse } from '../lib/response';
import { gateGeneration, recordGeneration } from '../lib/usage';
import { logUsage, recordAuditRun, listAuditRuns, getProject } from '../lib/db';
import {
  auditPatterns, buildResult, dedupeFindings, summarize, healthScore, detectLanguage,
  PRIVACY_NOTICE, type AuditInput, type AuditLevel, type AuditFinding,
} from '../lib/audit';
import { auditAI, AUDIT_MODELS } from '../lib/auditAI';

const LEVELS: AuditLevel[] = ['basic', 'detailed', 'compliance'];
const extFor: Record<string, string> = { python: 'py', go: 'go', java: 'java', typescript: 'ts', javascript: 'js', html: 'html' };

function sha256hex(s: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(
    (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''),
  );
}

// Normalize the request body into a list of files. Accepts {files:[{path,content}]} or a
// single {code, language} snippet.
function inputsFrom(body: any): AuditInput[] {
  if (Array.isArray(body?.files)) {
    return body.files
      .filter((f: any) => f && typeof f.content === 'string')
      .map((f: any) => ({ path: String(f.path || 'snippet.txt').slice(0, 200), content: String(f.content).slice(0, 600_000) }))
      .slice(0, 40);
  }
  if (typeof body?.code === 'string' && body.code.trim()) {
    const ext = extFor[String(body.language || '').toLowerCase()] || 'txt';
    return [{ path: `snippet.${ext}`, content: body.code.slice(0, 600_000) }];
  }
  return [];
}

// Persist ONLY metadata (score + finding type/severity/cwe/file/line) — never code.
async function persist(c: Ctx, projectId: string | null, level: AuditLevel, findings: AuditFinding[], score: number) {
  try {
    await recordAuditRun(c.env, {
      project_id: projectId, user_id: c.user?.id ?? null, level, score,
      summary: summarize(findings), findings,
    });
    await logUsage(c.env, { user_id: c.user?.id ?? null, kind: 'audit' });
  } catch { /* metadata persistence is best-effort */ }
}

export async function handleAudit(req: Request, c: Ctx): Promise<Response> {
  if (req.method === 'GET') return handleAuditHistory(c);
  if (req.method !== 'POST') return error(405, 'POST only');

  const body = (await req.json().catch(() => ({}))) as any;
  const level: AuditLevel = LEVELS.includes(body?.level) ? body.level : 'basic';
  const files = inputsFrom(body);
  if (!files.length) return error(400, 'Provide code to audit: { files:[{path,content}] } or { code, language }.');
  const projectId: string | null = body.projectId ? String(body.projectId) : null;
  const wantStream = body.stream !== false && (req.headers.get('accept') || '').includes('text/event-stream') || body.stream === true;
  const usesAI = level !== 'basic';

  // AI levels spend model calls -> respect the usage gate (High Usage Time, etc.).
  if (usesAI) {
    const gate = await gateGeneration(c);
    if (!gate.allowed) return error(gate.status, gate.reason || 'Paused during High Usage Time.', { code: gate.code });
  }

  // --- non-streaming JSON path -------------------------------------------------
  if (!wantStream) {
    const pattern = auditPatterns(files);
    let findings = pattern;
    if (usesAI) {
      const ai = await auditAI(c.env, files, level);
      findings = pattern.concat(ai);
      await recordGeneration(c);
    }
    const result = buildResult(files, findings, level);
    await persist(c, projectId, level, result.findings, result.codeHealthScore);
    return json(result);
  }

  // --- streaming (SSE) path: real-time feedback as findings are discovered ------
  const { response, send, close } = sse();
  const run = async () => {
    try {
      await send('meta', { level, models: usesAI ? AUDIT_MODELS : [], privacyNotice: PRIVACY_NOTICE, scannedFiles: files.length });
      // 1) Deterministic engine — instant. Stream each finding.
      const pattern = auditPatterns(files);
      for (const f of pattern) await send('finding', f);
      await send('progress', { stage: 'pattern', found: pattern.length });
      const all: AuditFinding[] = [...pattern];
      // 2) AI ensemble — every top model, one at a time.
      if (usesAI) {
        await auditAI(c.env, files, level, async ({ model, index, total, findings }) => {
          for (const f of findings) await send('finding', f);
          await send('progress', { stage: 'ai', model, index, total, found: findings.length });
          all.push(...findings);
        });
        await recordGeneration(c);
      }
      const result = buildResult(files, all, level);
      await persist(c, projectId, level, result.findings, result.codeHealthScore);
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
