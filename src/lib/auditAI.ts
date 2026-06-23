// AI security-audit ensemble. For the "detailed" / "compliance" levels we run the code
// through EACH top model, ONE AT A TIME, and merge their structured findings with the
// deterministic ones. Different models catch different issues; agreement raises confidence.
//
// Uses a DEDICATED key (YIELDNVIDIAAIKEY) so this feature can be metered/keyed separately,
// falling back to NVIDIA_API_KEY (and NVIDIA_API_KEY_BACKUP on a 429/402) so it works today.
// Privacy: code is sent to the model for analysis and then discarded — never stored.

import type { Env } from '../types';
import { chat } from './nvidia';
import { resolveModel } from '../config/models';
import type { AuditFinding, AuditInput, AuditLevel, Severity } from './audit';

// The top models the audit runs through, in order (best reasoning first). Models whose id
// doesn't resolve on the account simply error and are skipped — the ensemble still completes.
export const AUDIT_MODELS = ['nemotron-3-ultra', 'deepseek-v4-pro', 'qwen3.5-397b', 'kimi-k2.6', 'glm-5.1'];

// The dedicated audit key, falling back to the shared NVIDIA key until it's created.
function auditKey(env: Env): string {
  return (env as any).YIELDNVIDIAAIKEY || env.NVIDIA_API_KEY;
}

const SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

function auditSystem(level: AuditLevel): string {
  const base = `You are a senior application security auditor. Analyze the provided source code for REAL, exploitable security vulnerabilities.

Detect and classify these (use the exact CWE): SQL injection (CWE-89), cross-site scripting/XSS (CWE-79), authentication/authorization bypass (CWE-287), cryptographic failures (CWE-327), hardcoded secrets/API keys (CWE-798), PII/sensitive-data exposure (CWE-359), insecure/outdated dependencies (CWE-1104), command injection (CWE-78), path traversal (CWE-22), and CORS/CSRF misconfiguration (CWE-352).

CRITICAL — avoid false positives. Do NOT flag safe equivalents: parameterized/prepared queries, secrets read from env vars or a secret store, textContent or DOMPurify-sanitized HTML, array-form exec (no shell), constant-time secret comparison, verified JWTs, or normalized+validated file paths.

Cite the EXACT file path and line number using the numbered source provided (each line is prefixed "<n>| "). Output ONLY a JSON array — no prose, no markdown fences. Each element:
{"type":"SQL_INJECTION","severity":"CRITICAL|HIGH|MEDIUM|LOW","cwe":"CWE-89","owasp":"A03:2021 – Injection","description":"...","file":"path","line":12,"column":5,"fix":"...","example":{"vulnerable":"...","safe":"..."},"confidence":0.0}
If there are no real vulnerabilities, return []. Keep descriptions and fixes to one concise sentence each.`;
  if (level === 'compliance') {
    return base + `

COMPLIANCE FOCUS (GDPR + PCI-DSS): in addition, flag PII/cardholder data handled without encryption-at-rest/in-transit, PII written to logs, missing data-minimization or retention controls, and card data (PAN/CVV) stored in plaintext. Map these to CWE-359 and note the regulation (GDPR/PCI) in the description.`;
  }
  return base;
}

// Build a single numbered code blob (with file headers) the model can cite by file+line.
function numberedCode(files: AuditInput[], budget = 24000): string {
  let out = '';
  for (const f of files) {
    if (out.length >= budget) break;
    out += `\n=== file: ${f.path} ===\n`;
    const lines = f.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (out.length >= budget) { out += '… (truncated)\n'; break; }
      out += `${i + 1}| ${lines[i]}\n`;
    }
  }
  return out.trim();
}

// Pull the JSON array of findings out of a model reply (tolerant of prose / fences).
function parseFindings(text: string): any[] {
  if (!text) return [];
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = t.indexOf('['); const end = t.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  t = t.slice(start, end + 1);
  try {
    const arr = JSON.parse(t);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function normSeverity(s: unknown): Severity {
  const up = String(s || '').toUpperCase();
  return (SEVERITIES.includes(up as Severity) ? up : 'MEDIUM') as Severity;
}

// Coerce a raw model finding into our strict AuditFinding shape (best-effort, bounded).
function coerce(raw: any, model: string, files: AuditInput[]): AuditFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || raw.vulnerability || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 40);
  if (!type) return null;
  const file = String(raw.file || raw.path || files[0]?.path || 'index.html').slice(0, 200);
  const line = Math.max(1, Math.min(1_000_000, parseInt(raw.line, 10) || 1));
  const column = Math.max(1, Math.min(100_000, parseInt(raw.column, 10) || 1));
  const conf = typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.6;
  const ex = raw.example && typeof raw.example === 'object' ? raw.example : {};
  return {
    type,
    severity: normSeverity(raw.severity),
    cwe: String(raw.cwe || '').slice(0, 16) || 'CWE-0',
    owasp: String(raw.owasp || '').slice(0, 80),
    description: String(raw.description || '').slice(0, 500),
    location: { file, line, column },
    fix: String(raw.fix || raw.remediation || '').slice(0, 500),
    example: { vulnerable: String(ex.vulnerable || '').slice(0, 300), safe: String(ex.safe || '').slice(0, 300) },
    source: 'ai',
    confidence: conf,
    model,
  };
}

// Run ONE model over the code. Returns its findings (or [] on any failure). Best-effort.
async function runModel(env: Env, modelId: string, level: AuditLevel, code: string, files: AuditInput[], signal?: AbortSignal): Promise<AuditFinding[]> {
  try {
    const m = resolveModel(modelId);
    const baseUrl = m.provider.baseUrl || env.NVIDIA_CHAT_BASE;
    const key = m.provider.baseUrl ? (env.OPENROUTER_API_KEY || auditKey(env)) : auditKey(env);
    const { text } = await chat({
      baseUrl, apiKey: key, apiKeyBackup: m.provider.baseUrl ? undefined : (env.NVIDIA_API_KEY_BACKUP || undefined),
      model: m.modelId,
      messages: [
        { role: 'system', content: auditSystem(level) },
        { role: 'user', content: `Audit this code and return ONLY the JSON array of findings:\n\n${code}` },
      ],
      temperature: 0.1, max_tokens: 4000, timeoutMs: 120000, signal,
      extra: { reasoning_effort: 'low' },
    });
    return parseFindings(text).map((r) => coerce(r, modelId, files)).filter((f): f is AuditFinding => !!f && !!f.cwe).slice(0, 40);
  } catch {
    return [];
  }
}

// Run the FULL ensemble: every top model, one at a time. `onModel` reports progress
// (and lets the endpoint stream findings as each model finishes).
export async function auditAI(
  env: Env, files: AuditInput[], level: AuditLevel,
  onModel?: (info: { model: string; index: number; total: number; findings: AuditFinding[]; ok: boolean }) => Promise<void>,
  signal?: AbortSignal,
): Promise<AuditFinding[]> {
  if (!auditKey(env)) return [];
  const code = numberedCode(files);
  if (!code) return [];
  const all: AuditFinding[] = [];
  for (let i = 0; i < AUDIT_MODELS.length; i++) {
    if (signal?.aborted) break;
    const modelId = AUDIT_MODELS[i];
    const findings = await runModel(env, modelId, level, code, files, signal);
    all.push(...findings);
    if (onModel) await onModel({ model: modelId, index: i + 1, total: AUDIT_MODELS.length, findings, ok: findings.length >= 0 });
  }
  return all;
}
