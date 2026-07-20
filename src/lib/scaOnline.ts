// Online software-composition scanning: live vulnerability data from OSV.dev (the same
// feed that aggregates GitHub Advisories, NVD, PyPA, Go, etc.) and license compliance via
// the package registries. Results are cached in KV per package@version so repeat scans
// are fast and we stay well within rate limits. Both are best-effort and degrade to the
// curated DB / "unknown" rather than failing a scan.

import type { Env } from '../types';
import type { AuditFinding, Severity } from './audit';
import { parseDependencies, auditDependencies, type Dep } from './sca';
import type { AuditInput } from './audit';

const OSV = 'https://api.osv.dev/v1';

function sev(s: string | undefined): Severity {
  const u = (s || '').toUpperCase();
  if (u.includes('CRIT')) return 'CRITICAL';
  if (u.includes('HIGH')) return 'HIGH';
  if (u.includes('MOD') || u.includes('MED')) return 'MEDIUM';
  if (u.includes('LOW')) return 'LOW';
  return 'MEDIUM';
}

interface OsvHit { id: string; cve: string; severity: Severity; summary: string; fixed: string; }

// Pull the bits we show out of a full OSV vuln record.
function summarizeVuln(v: any): OsvHit {
  const cve = (v.aliases || []).find((a: string) => a.startsWith('CVE-')) || v.id;
  let severity = sev(v.database_specific?.severity);
  if (severity === 'MEDIUM' && Array.isArray(v.affected)) {
    for (const a of v.affected) { const s = a.database_specific?.severity; if (s) { severity = sev(s); break; } }
  }
  let fixed = '';
  for (const a of v.affected || []) for (const r of a.ranges || []) for (const e of r.events || []) if (e.fixed) fixed = e.fixed;
  return { id: v.id, cve, severity, summary: String(v.summary || v.details || '').slice(0, 240), fixed };
}

function hitToFinding(d: Dep, h: OsvHit): AuditFinding {
  return {
    type: 'DEPENDENCY_VULN', severity: h.severity, cwe: h.cve.startsWith('CVE') ? h.cve : 'CWE-1395',
    owasp: 'A06:2021 – Vulnerable and Outdated Components',
    description: `${d.name}@${d.version} is affected by ${h.id}${h.cve !== h.id ? ` (${h.cve})` : ''}: ${h.summary || 'known vulnerability'}.`,
    location: { file: d.file, line: d.line, column: 1 },
    fix: h.fixed ? `Upgrade ${d.name} to ${h.fixed} or later.` : `Upgrade ${d.name} to a patched version.`,
    example: { vulnerable: `"${d.name}": "${d.version}"`, safe: h.fixed ? `"${d.name}": "^${h.fixed}"` : `"${d.name}": "<patched>"` },
    source: 'pattern', confidence: 0.92,
  };
}

// Query OSV for the given dependencies (cached per package@version). Returns findings, or
// null if OSV is unreachable so the caller can fall back to the curated DB.
async function osvScan(env: Env, deps: Dep[]): Promise<AuditFinding[] | null> {
  if (!deps.length) return [];
  const findings: AuditFinding[] = [];
  const uncached: Dep[] = [];
  for (const d of deps) {
    const c = await env.KV.get(`osv:${d.ecosystem}:${d.name}:${d.version}`).catch(() => null);
    if (c != null) { try { for (const h of JSON.parse(c) as OsvHit[]) findings.push(hitToFinding(d, h)); } catch { /* ignore */ } }
    else uncached.push(d);
  }
  if (!uncached.length) return findings;

  let results: any[];
  try {
    const r = await fetch(`${OSV}/querybatch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries: uncached.slice(0, 200).map((d) => ({ package: { ecosystem: d.ecosystem, name: d.name }, version: d.version })) }),
    });
    if (!r.ok) return findings.length ? findings : null;
    results = ((await r.json()) as any).results || [];
  } catch {
    return findings.length ? findings : null; // OSV down -> fall back to curated
  }

  // Resolve detail for the (usually few) vulns that matched, then cache per dep.
  const detailCache = new Map<string, any>();
  let detailBudget = 40;
  for (let i = 0; i < uncached.length; i++) {
    const d = uncached[i];
    const vulns = results[i]?.vulns || [];
    const hits: OsvHit[] = [];
    let complete = true; // false if any vuln couldn't be fully resolved (budget/fetch)
    for (const vref of vulns) {
      if (detailBudget <= 0) { complete = false; break; }
      let full = detailCache.get(vref.id);
      if (!full) {
        try { const dr = await fetch(`${OSV}/vulns/${vref.id}`); if (dr.ok) { full = await dr.json(); detailCache.set(vref.id, full); detailBudget--; } } catch { /* skip */ }
      }
      if (full) hits.push(summarizeVuln(full)); else complete = false;
    }
    // Only cache when every matched vuln was resolved; a truncated/partial list must be
    // re-queried next scan so vulnerable packages aren't reported clean for 24h.
    if (complete) await env.KV.put(`osv:${d.ecosystem}:${d.name}:${d.version}`, JSON.stringify(hits), { expirationTtl: 86400 }).catch(() => {});
    for (const h of hits) findings.push(hitToFinding(d, h));
  }
  return findings;
}

// ---- license compliance -----------------------------------------------------
const COPYLEFT_STRONG = /\bA?GPL|SSPL\b/i;   // AGPL / GPL / SSPL — strong/network copyleft
const COPYLEFT_WEAK = /\bLGPL|MPL|EPL|CDDL|EUPL\b/i; // weaker copyleft

async function licenseFor(env: Env, d: Dep): Promise<string> {
  const key = `lic:${d.ecosystem}:${d.name}`;
  const cached = await env.KV.get(key).catch(() => null);
  if (cached != null) return cached;
  let lic = 'UNKNOWN';
  try {
    if (d.ecosystem === 'npm') {
      const r = await fetch(`https://registry.npmjs.org/${d.name.replace('/', '%2F')}`);
      if (r.ok) { const j: any = await r.json(); lic = (typeof j.license === 'string' ? j.license : j.license?.type) || j.versions?.[d.version]?.license || 'UNKNOWN'; }
    } else if (d.ecosystem === 'PyPI') {
      const r = await fetch(`https://pypi.org/pypi/${d.name}/json`);
      if (r.ok) { const j: any = await r.json(); lic = j.info?.license || (j.info?.classifiers || []).find((c: string) => c.startsWith('License ::'))?.split('::').pop()?.trim() || 'UNKNOWN'; }
    }
  } catch { /* registry hiccup */ }
  lic = String(lic || 'UNKNOWN').slice(0, 60);
  await env.KV.put(key, lic, { expirationTtl: 604800 }).catch(() => {});
  return lic;
}

async function licenseScan(env: Env, deps: Dep[]): Promise<AuditFinding[]> {
  const out: AuditFinding[] = [];
  const seen = new Set<string>();
  for (const d of deps.slice(0, 40)) {
    if (seen.has(d.name)) continue; seen.add(d.name);
    if (d.ecosystem === 'Go') continue; // no simple license endpoint
    const lic = await licenseFor(env, d);
    const strong = COPYLEFT_STRONG.test(lic), weak = COPYLEFT_WEAK.test(lic);
    if (!strong && !weak) continue;
    out.push({
      type: 'LICENSE_RISK', severity: strong ? 'MEDIUM' : 'LOW', cwe: 'CWE-1104',
      owasp: 'A06:2021 – Vulnerable and Outdated Components',
      description: `${d.name} is licensed under ${lic} — ${strong ? 'a strong/network copyleft license that can force you to open-source your own code' : 'a weak copyleft license with redistribution obligations'}.`,
      location: { file: d.file, line: d.line, column: 1 },
      fix: strong ? `Confirm ${lic} is compatible with your distribution model, or replace ${d.name} with a permissively-licensed (MIT/Apache-2.0/BSD) alternative.` : `Review the ${lic} obligations for ${d.name}.`,
      example: { vulnerable: `${d.name} — ${lic}`, safe: `a MIT / Apache-2.0 / BSD alternative` },
      source: 'pattern', confidence: 0.8,
    });
  }
  return out;
}

// The full online SCA pass: live OSV vulns (curated fallback) + license compliance.
export async function onlineScan(env: Env, files: AuditInput[]): Promise<{ deps: AuditFinding[]; license: AuditFinding[] }> {
  const deps = parseDependencies(files);
  if (!deps.length) return { deps: [], license: [] };
  const osv = await osvScan(env, deps);
  const depFindings = osv != null ? osv : auditDependencies(files); // OSV, else curated DB
  const license = await licenseScan(env, deps).catch(() => []);
  return { deps: depFindings, license };
}
