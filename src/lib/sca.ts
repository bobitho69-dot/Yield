// Extra scanners beyond the line-pattern engine: software-composition analysis (SCA —
// known-vulnerable dependencies) and IaC / config misconfiguration checks. Both return
// the same AuditFinding shape and are merged into every scan, so the product covers
// SAST + SCA + IaC like a real security platform.
//
// The vuln DB here is a CURATED subset of well-known CVEs (not a full feed) — enough to
// catch the common dangerous pins; swap in a live advisory feed later for full coverage.

import type { AuditFinding, AuditInput } from './audit';

const A06 = 'A06:2021 – Vulnerable and Outdated Components';
const A05 = 'A05:2021 – Security Misconfiguration';

interface Vuln { range: string; fixed: string; severity: AuditFinding['severity']; cwe: string; cve: string; title: string; }
// package (lowercased) -> known-vulnerable version rules. `range` is an upper bound "<x.y.z".
const VULN_DB: Record<string, Vuln[]> = {
  // npm
  lodash: [{ range: '<4.17.21', fixed: '4.17.21', severity: 'HIGH', cwe: 'CWE-1321', cve: 'CVE-2021-23337', title: 'Command injection via template / prototype pollution' }],
  minimist: [{ range: '<1.2.6', fixed: '1.2.6', severity: 'MEDIUM', cwe: 'CWE-1321', cve: 'CVE-2021-44906', title: 'Prototype pollution' }],
  axios: [{ range: '<1.6.0', fixed: '1.6.0', severity: 'HIGH', cwe: 'CWE-918', cve: 'CVE-2023-45857', title: 'SSRF / credential leak via redirects' }],
  'node-fetch': [{ range: '<2.6.7', fixed: '2.6.7', severity: 'MEDIUM', cwe: 'CWE-601', cve: 'CVE-2022-0235', title: 'Exposure of sensitive info via redirect' }],
  express: [{ range: '<4.19.2', fixed: '4.19.2', severity: 'MEDIUM', cwe: 'CWE-79', cve: 'CVE-2024-29041', title: 'Open redirect in res.location' }],
  jsonwebtoken: [{ range: '<9.0.0', fixed: '9.0.0', severity: 'HIGH', cwe: 'CWE-327', cve: 'CVE-2022-23529', title: 'Weak verification / RCE in jwt.verify' }],
  ws: [{ range: '<8.17.1', fixed: '8.17.1', severity: 'HIGH', cwe: 'CWE-400', cve: 'CVE-2024-37890', title: 'DoS via many HTTP headers' }],
  'follow-redirects': [{ range: '<1.15.6', fixed: '1.15.6', severity: 'MEDIUM', cwe: 'CWE-601', cve: 'CVE-2024-28849', title: 'Credential leak on cross-host redirect' }],
  next: [{ range: '<14.1.1', fixed: '14.1.1', severity: 'HIGH', cwe: 'CWE-918', cve: 'CVE-2024-34351', title: 'SSRF in server actions' }],
  'event-stream': [{ range: '<=3.3.6', fixed: '4.0.1', severity: 'CRITICAL', cwe: 'CWE-506', cve: 'CVE-2018-1000620', title: 'Malicious code (flatmap-stream backdoor)' }],
  // pip
  requests: [{ range: '<2.31.0', fixed: '2.31.0', severity: 'MEDIUM', cwe: 'CWE-200', cve: 'CVE-2023-32681', title: 'Leaks Proxy-Authorization header on redirect' }],
  urllib3: [{ range: '<1.26.18', fixed: '1.26.18', severity: 'MEDIUM', cwe: 'CWE-200', cve: 'CVE-2023-45803', title: 'Request body leak on redirect' }],
  pyyaml: [{ range: '<5.4', fixed: '5.4', severity: 'CRITICAL', cwe: 'CWE-20', cve: 'CVE-2020-14343', title: 'Arbitrary code execution via yaml.load' }],
  django: [{ range: '<4.2.11', fixed: '4.2.11', severity: 'HIGH', cwe: 'CWE-400', cve: 'CVE-2024-27351', title: 'Potential ReDoS in Truncator' }],
  flask: [{ range: '<2.3.2', fixed: '2.3.2', severity: 'MEDIUM', cwe: 'CWE-400', cve: 'CVE-2023-30861', title: 'Cookie leak to cache / cross-user' }],
  jinja2: [{ range: '<3.1.3', fixed: '3.1.3', severity: 'MEDIUM', cwe: 'CWE-79', cve: 'CVE-2024-22195', title: 'XSS via xmlattr filter' }],
};

// Parse "1.2.3" out of a version spec (^1.2.3, ~1.2, >=1.2.3, "1.2.3") -> [major,minor,patch].
function parseVer(spec: string): [number, number, number] | null {
  const m = String(spec).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3] || '0', 10)];
}
function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
// Does `version` fall in a "<x.y.z" / "<=x.y.z" vulnerable range?
function inRange(version: string, range: string): boolean {
  const v = parseVer(version); if (!v) return false;
  const le = range.startsWith('<=');
  const bound = parseVer(range.replace(/^<=?/, '')); if (!bound) return false;
  const c = cmp(v, bound);
  return le ? c <= 0 : c < 0;
}

function depFinding(file: string, line: number, name: string, version: string, v: Vuln): AuditFinding {
  return {
    type: 'DEPENDENCY_VULN', severity: v.severity, cwe: v.cwe, owasp: A06,
    description: `${name}@${version} is affected by ${v.cve}: ${v.title}.`,
    location: { file, line, column: 1 },
    fix: `Upgrade ${name} to ${v.fixed} or later.`,
    example: { vulnerable: `"${name}": "${version}"`, safe: `"${name}": "^${v.fixed}"` },
    source: 'pattern', confidence: 0.9,
  };
}

// Find the 1-based line a dependency name appears on (best-effort, for nicer locations).
function lineOf(content: string, name: string): number {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(name)) return i + 1;
  return 1;
}

// SCA: parse manifests and flag known-vulnerable dependency versions.
export function auditDependencies(files: AuditInput[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const f of files) {
    const base = f.path.split('/').pop()?.toLowerCase() || '';
    try {
      if (base === 'package.json') {
        const pkg = JSON.parse(f.content);
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        for (const [name, spec] of Object.entries(deps)) {
          const rules = VULN_DB[name.toLowerCase()]; if (!rules) continue;
          for (const v of rules) if (inRange(String(spec), v.range)) out.push(depFinding(f.path, lineOf(f.content, `"${name}"`), name, String(spec), v));
        }
      } else if (base === 'requirements.txt' || base.endsWith('.pip')) {
        for (const raw of f.content.split('\n')) {
          const m = raw.match(/^\s*([A-Za-z0-9_.-]+)\s*==\s*([0-9][^\s;]*)/);
          if (!m) continue;
          const rules = VULN_DB[m[1].toLowerCase()]; if (!rules) continue;
          for (const v of rules) if (inRange(m[2], v.range)) out.push(depFinding(f.path, lineOf(f.content, m[1]), m[1], m[2], v));
        }
      } else if (base === 'go.mod') {
        for (const raw of f.content.split('\n')) {
          const m = raw.match(/([\w./-]+)\s+v(\d+\.\d+\.\d+)/);
          if (!m) continue;
          const short = m[1].split('/').pop() || m[1];
          const rules = VULN_DB[short.toLowerCase()]; if (!rules) continue;
          for (const v of rules) if (inRange(m[2], v.range)) out.push(depFinding(f.path, lineOf(f.content, m[1]), short, m[2], v));
        }
      }
    } catch { /* malformed manifest — skip */ }
  }
  return out;
}

// ---- IaC / config misconfiguration rules ------------------------------------
interface ConfRule { test: (line: string) => boolean; severity: AuditFinding['severity']; type: string; cwe: string; description: string; fix: string; example: { vulnerable: string; safe: string } }

const DOCKERFILE_RULES: ConfRule[] = [
  { test: (l) => /^\s*FROM\s+\S+:latest/i.test(l) || /^\s*FROM\s+[^:\s]+\s*$/i.test(l), severity: 'LOW', type: 'IAC_UNPINNED_IMAGE', cwe: 'CWE-1104', description: 'Base image uses :latest (or no tag) — builds are non-reproducible and may pull in vulnerable layers.', fix: 'Pin the base image to a specific, digest-locked version (e.g. node:20.11-alpine).', example: { vulnerable: 'FROM node:latest', safe: 'FROM node:20.11-alpine@sha256:...' } },
  { test: (l) => /^\s*ADD\s+https?:\/\//i.test(l), severity: 'MEDIUM', type: 'IAC_REMOTE_ADD', cwe: 'CWE-494', description: 'ADD with a remote URL fetches code without integrity checks.', fix: 'Use COPY for local files, or curl + verify a checksum in a RUN step.', example: { vulnerable: 'ADD https://x/app.tar.gz /', safe: 'RUN curl -fsSL https://x/app.tar.gz | sha256sum -c -' } },
  { test: (l) => /^\s*ENV\s+\w*(?:PASSWORD|SECRET|TOKEN|KEY)\w*\s*=?\s*\S+/i.test(l), severity: 'HIGH', type: 'IAC_SECRET_IN_IMAGE', cwe: 'CWE-798', description: 'A secret is baked into the image via ENV — it persists in image layers.', fix: 'Pass secrets at runtime (env, secret mounts), never bake them into the image.', example: { vulnerable: 'ENV API_KEY=sk_live_123', safe: '# pass --env API_KEY at runtime' } },
];

const WORKFLOW_RULES: ConfRule[] = [
  { test: (l) => /\$\{\{\s*github\.event\.(?:issue|pull_request|comment|review)[^}]*\}\}/.test(l) && /run:|script:/.test(l) === false, severity: 'HIGH', type: 'IAC_ACTIONS_INJECTION', cwe: 'CWE-94', description: 'Untrusted github.event.* data is interpolated into a workflow — a classic GitHub Actions script-injection sink.', fix: 'Pass event data via an env var and reference "$VAR" in run; never inline ${{ github.event.* }} into a shell command.', example: { vulnerable: 'run: echo ${{ github.event.issue.title }}', safe: 'env:\n  TITLE: ${{ github.event.issue.title }}\nrun: echo "$TITLE"' } },
  { test: (l) => /pull_request_target/.test(l), severity: 'HIGH', type: 'IAC_PR_TARGET', cwe: 'CWE-269', description: 'pull_request_target runs with write permissions + secrets on untrusted PR code — high privilege-escalation risk.', fix: 'Avoid pull_request_target with checkout of the PR head; use pull_request, and gate any privileged step.', example: { vulnerable: 'on: pull_request_target', safe: 'on: pull_request' } },
  { test: (l) => /uses:\s*[\w./-]+@(?:main|master|v\d+)\s*$/.test(l), severity: 'LOW', type: 'IAC_UNPINNED_ACTION', cwe: 'CWE-829', description: 'A third-party action is pinned to a moving ref (branch/major tag) — a compromised tag could run malicious code.', fix: 'Pin actions to a full commit SHA.', example: { vulnerable: 'uses: foo/bar@main', safe: 'uses: foo/bar@<commit-sha>' } },
];

function confScan(file: string, content: string, rules: ConfRule[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const r of rules) {
      if (!r.test(lines[i])) continue;
      out.push({ type: r.type, severity: r.severity, cwe: r.cwe, owasp: A05, description: r.description, location: { file, line: i + 1, column: 1 }, fix: r.fix, example: r.example, source: 'pattern', confidence: 0.7 });
    }
  }
  return out;
}

// IaC: Dockerfiles, GitHub Actions workflows, docker-compose, and committed .env files.
export function auditConfig(files: AuditInput[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const f of files) {
    const p = f.path.toLowerCase();
    const base = p.split('/').pop() || '';
    if (base === 'dockerfile' || base.startsWith('dockerfile.')) out.push(...confScan(f.path, f.content, DOCKERFILE_RULES));
    if (/\.github\/workflows\/.+\.ya?ml$/.test(p)) out.push(...confScan(f.path, f.content, WORKFLOW_RULES));
    if (base === '.env' || /\.env(\.\w+)?$/.test(base)) {
      // A committed .env with a real-looking secret value is itself a finding.
      const lines = f.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*\w*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)\w*\s*=\s*\S{8,}/i.test(lines[i]) && !/=\s*(?:""|''|<|your|changeme|xxx)/i.test(lines[i])) {
          out.push({ type: 'IAC_COMMITTED_SECRET', severity: 'HIGH', cwe: 'CWE-798', owasp: A05, description: 'A .env file containing a real-looking secret appears to be committed to the repo.', location: { file: f.path, line: i + 1, column: 1 }, fix: 'Remove the .env from version control (add to .gitignore), rotate the secret, and use a secret manager.', example: { vulnerable: 'API_KEY=sk_live_123 (committed)', safe: '.env in .gitignore; secrets set in the host' }, source: 'pattern', confidence: 0.8 });
        }
      }
    }
  }
  return out;
}
