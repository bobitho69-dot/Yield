// Security audit engine — deterministic, language-aware vulnerability detection.
//
// This is the zero-cost, privacy-safe backbone of Yield's security audit: it scans
// generated code with carefully scoped patterns (and SAFE-pattern allowlists to cut
// false positives) for the OWASP/CWE categories below. It NEVER stores the code — it
// returns structured findings + a 0-100 health score. The AI ensemble (see auditAI.ts)
// layers on top of this for the "detailed" / "compliance" levels.
//
// Design goals (in priority order): correctness, LOW false positives, language
// awareness, readability. A rule fires only when a dangerous pattern matches AND no
// known-safe equivalent is present on the line (parameterized queries, env lookups,
// sanitizers, array-form exec, etc.).

import { auditDependencies, auditConfig } from './sca';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type AuditLevel = 'basic' | 'detailed' | 'compliance';
export type Language = 'javascript' | 'typescript' | 'python' | 'go' | 'java' | 'html' | 'unknown';

export interface AuditFinding {
  type: string; // e.g. "SQL_INJECTION"
  severity: Severity;
  cwe: string; // e.g. "CWE-89"
  owasp: string; // e.g. "A03:2021 – Injection"
  description: string;
  location: { file: string; line: number; column: number };
  fix: string;
  example: { vulnerable: string; safe: string };
  source: 'pattern' | 'ai';
  confidence: number; // 0..1
  model?: string; // which AI model flagged it (source === 'ai')
}

export interface AuditInput {
  path: string;
  content: string;
}

export interface AuditResult {
  findings: AuditFinding[];
  codeHealthScore: number; // 0..100
  level: AuditLevel;
  languages: Language[];
  summary: { critical: number; high: number; medium: number; low: number; total: number };
  scannedFiles: number;
  privacyNotice: string;
}

export const PRIVACY_NOTICE = 'Code is analyzed and discarded immediately. Only vulnerability metadata (type, severity, line, CWE, timestamp) is retained — never your source code.';

const SEVERITY_WEIGHT: Record<Severity, number> = { CRITICAL: 25, HIGH: 12, MEDIUM: 5, LOW: 2 };
const SEVERITY_RANK: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

// ---- language detection ------------------------------------------------------
export function detectLanguage(path: string): Language {
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || ext === 'jsx') return 'javascript';
  if (ext === 'ts' || ext === 'tsx') return 'typescript';
  if (ext === 'py') return 'python';
  if (ext === 'go') return 'go';
  if (ext === 'java') return 'java';
  if (ext === 'html' || ext === 'htm' || ext === 'vue' || ext === 'svelte') return 'html';
  return 'unknown';
}

// A line that is purely a comment (best-effort, cross-language). Most rules skip these
// to reduce false positives; high-confidence secret rules deliberately do NOT skip them.
function isCommentLine(line: string, lang: Language): boolean {
  const t = line.trim();
  if (!t) return true;
  if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/')) return true;
  if ((lang === 'python') && t.startsWith('#')) return true;
  if (lang === 'go' && t.startsWith('//')) return true;
  return false;
}

// ---- rule model --------------------------------------------------------------
interface Rule {
  type: string;
  severity: Severity;
  cwe: string;
  owasp: string;
  description: string;
  fix: string;
  example: { vulnerable: string; safe: string };
  languages: Language[] | '*'; // which languages this applies to
  pattern: RegExp; // the dangerous pattern (non-global; we add a column from match.index)
  safe?: RegExp; // if this also matches the line, treat as a SAFE equivalent (allowlist)
  confidence: number;
  scanComments?: boolean; // also scan comment-only lines (default: false)
}

const A03 = 'A03:2021 – Injection';
const A01 = 'A01:2021 – Broken Access Control';
const A02 = 'A02:2021 – Cryptographic Failures';
const A05 = 'A05:2021 – Security Misconfiguration';
const A06 = 'A06:2021 – Vulnerable and Outdated Components';
const A07 = 'A07:2021 – Identification and Authentication Failures';
const A09 = 'A09:2021 – Security Logging and Monitoring Failures';

// Common SAFE markers reused across rules.
const ENV_LOOKUP = /process\.env\.|import\.meta\.env|Deno\.env\.get|os\.getenv|os\.environ|System\.getenv|System\.getProperty|config\.|settings\.|\bsecrets?\.|\bgetenv\b/i;
const PLACEHOLDER_SECRET = /["'`](?:|x{3,}|\.{3,}|<[^>]+>|your[_-]?\w*|changeme|placeholder|example|todo|test|dummy|xxxx+|\*{3,}|\{\{[^}]+\}\})["'`]/i;

const RULES: Rule[] = [
  // ---------------- SQL injection (CWE-89) ----------------
  {
    type: 'SQL_INJECTION', severity: 'CRITICAL', cwe: 'CWE-89', owasp: A03,
    description: 'SQL query built by concatenating or interpolating a variable directly into the query string, allowing an attacker to alter the query.',
    fix: 'Use parameterized queries / prepared statements (bind values as parameters) instead of string concatenation.',
    example: {
      vulnerable: 'db.query("SELECT * FROM users WHERE id = " + userId)',
      safe: 'db.query("SELECT * FROM users WHERE id = ?", [userId])',
    },
    languages: '*', confidence: 0.8,
    // a query call OR a SQL string, that then concatenates / interpolates a variable.
    pattern: /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^"'`;]*["'`]\s*(?:\+|\.\s*concat|%\s|\.format\(|\$\{|\bf["'`])/i,
    // parameterized forms are safe: ? / $1 / :name placeholders, or .bind()/.prepare with params
    safe: /\?|\$\d+|:\w+\b|\.bind\(|\.prepare\(|execute\([^,]+,/i,
  },
  {
    type: 'SQL_INJECTION', severity: 'CRITICAL', cwe: 'CWE-89', owasp: A03,
    description: 'Database call uses an f-string / template literal with SQL keywords and an interpolated variable — a classic SQL injection sink.',
    fix: 'Pass values as bound parameters: cursor.execute("... WHERE x = %s", (value,)) or use the ORM\'s parameter binding.',
    example: {
      vulnerable: 'cursor.execute(f"SELECT * FROM t WHERE name = \'{name}\'")',
      safe: 'cursor.execute("SELECT * FROM t WHERE name = %s", (name,))',
    },
    languages: ['python'], confidence: 0.85,
    pattern: /(?:execute|executemany|raw|cursor\.\w+)\s*\(\s*f["'][^"']*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^"']*\{/i,
  },
  {
    type: 'SQL_INJECTION', severity: 'CRITICAL', cwe: 'CWE-89', owasp: A03,
    description: 'A template literal interpolates a variable (${...}) directly into a SQL string — the value is not bound as a parameter, so it can alter the query.',
    fix: 'Use the driver\'s parameter binding (placeholders + a values array), e.g. db.query("... WHERE id = $1", [id]); never interpolate into the SQL string.',
    example: {
      vulnerable: 'db.query(`SELECT * FROM users WHERE id = ${id}`)',
      safe: 'db.query("SELECT * FROM users WHERE id = $1", [id])',
    },
    languages: ['javascript', 'typescript'], confidence: 0.85,
    // a backtick string containing a SQL verb AND a ${...} interpolation
    pattern: /`[^`]*\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^`]*\$\{/i,
  },

  // ---------------- XSS (CWE-79) ----------------
  {
    type: 'XSS', severity: 'HIGH', cwe: 'CWE-79', owasp: A03,
    description: 'Assigning unsanitized/dynamic content to innerHTML lets attacker-controlled HTML/JS execute in the page.',
    fix: 'Use textContent for text, or sanitize HTML with DOMPurify.sanitize() before assigning to innerHTML.',
    example: {
      vulnerable: 'el.innerHTML = userInput;',
      safe: 'el.textContent = userInput; // or el.innerHTML = DOMPurify.sanitize(userInput)',
    },
    languages: ['javascript', 'typescript', 'html'], confidence: 0.7,
    // innerHTML/outerHTML assignment (not a comparison "==").
    pattern: /\.(?:inner|outer)HTML\s*=\s*(?!=)\S/,
    // SAFE when the right-hand side is a pure string/number literal or an
    // interpolation-free template, or it's sanitized / uses textContent.
    safe: /DOMPurify|sanitize\(|escapeHtml|DOMParser|textContent|=\s*(?:["'][^"'`]*["']|`[^`$]*`|\d+)\s*;?\s*$/i,
  },
  {
    type: 'XSS', severity: 'HIGH', cwe: 'CWE-79', owasp: A03,
    description: 'Use of a known XSS sink (document.write, insertAdjacentHTML, jQuery .html(), or React dangerouslySetInnerHTML) with dynamic content.',
    fix: 'Avoid these sinks with untrusted data; render text safely or sanitize with DOMPurify first.',
    example: {
      vulnerable: 'element.insertAdjacentHTML("beforeend", userInput)',
      safe: 'element.append(document.createTextNode(userInput))',
    },
    languages: ['javascript', 'typescript', 'html'], confidence: 0.65,
    pattern: /(?:document\.write\s*\(|\.insertAdjacentHTML\s*\(|\.html\s*\(\s*[^)'"`]|dangerouslySetInnerHTML)/,
    safe: /DOMPurify|sanitize\(|createTextNode/i,
  },
  {
    type: 'XSS', severity: 'CRITICAL', cwe: 'CWE-79', owasp: A03,
    description: 'Use of eval() / new Function() / setTimeout with a string — executes arbitrary code and is a code-injection/XSS sink.',
    fix: 'Never eval untrusted input. Use JSON.parse for data, and pass functions (not strings) to setTimeout/setInterval.',
    example: { vulnerable: 'eval(userInput)', safe: 'JSON.parse(userInput) // for data' },
    languages: ['javascript', 'typescript', 'html'], confidence: 0.8,
    pattern: /\beval\s*\(|new\s+Function\s*\(|set(?:Timeout|Interval)\s*\(\s*["'`]/,
  },

  // ---------------- Command injection (CWE-78) ----------------
  {
    type: 'COMMAND_INJECTION', severity: 'CRITICAL', cwe: 'CWE-78', owasp: A03,
    description: 'A shell command is built from concatenated/interpolated input or run with shell=true, allowing arbitrary command execution.',
    fix: 'Avoid the shell: pass arguments as an array (e.g. execFile("cmd", [arg])) and never interpolate untrusted input into a command string.',
    example: {
      vulnerable: 'exec("ping " + host)',
      safe: 'execFile("ping", [host])',
    },
    languages: ['javascript', 'typescript'], confidence: 0.8,
    pattern: /\b(?:child_process\.)?(?:exec|execSync)\s*\(\s*(?:["'`][^"'`]*["'`]\s*\+|`[^`]*\$\{)/,
    safe: /execFile|\[\s*["'`]/,
  },
  {
    type: 'COMMAND_INJECTION', severity: 'CRITICAL', cwe: 'CWE-78', owasp: A03,
    description: 'Subprocess/system call with shell=True or string interpolation runs an attacker-influenced command through the shell.',
    fix: 'Use a list of arguments with shell=False (the default), e.g. subprocess.run(["ping", host]); never build the command with f-strings.',
    example: {
      vulnerable: 'subprocess.run(f"ping {host}", shell=True)',
      safe: 'subprocess.run(["ping", host])',
    },
    languages: ['python'], confidence: 0.85,
    pattern: /\b(?:os\.system\s*\(|subprocess\.(?:run|call|Popen|check_output)\s*\([^)]*(?:shell\s*=\s*True|f["']))/,
  },
  {
    type: 'COMMAND_INJECTION', severity: 'CRITICAL', cwe: 'CWE-78', owasp: A03,
    description: 'Runtime.exec / ProcessBuilder built from concatenated input allows OS command injection.',
    fix: 'Pass the command and each argument as separate array elements and validate/allowlist inputs.',
    example: {
      vulnerable: 'Runtime.getRuntime().exec("sh -c " + cmd)',
      safe: 'new ProcessBuilder("sh", "-c", cmd)',
    },
    languages: ['java'], confidence: 0.75,
    pattern: /(?:Runtime\.getRuntime\(\)\.exec|ProcessBuilder)\s*\([^)]*\+/,
  },

  // ---------------- Hardcoded secrets (CWE-798) ----------------
  {
    type: 'HARDCODED_SECRET', severity: 'CRITICAL', cwe: 'CWE-798', owasp: A07,
    description: 'A recognizable provider credential (AWS/GitHub/Google/Slack/Stripe/OpenAI key or a private key block) is hardcoded in source.',
    fix: 'Move the secret to an environment variable / secret manager and rotate the exposed key immediately.',
    example: { vulnerable: 'const key = "AKIAIOSFODNN7EXAMPLE"', safe: 'const key = process.env.AWS_ACCESS_KEY_ID' },
    languages: '*', confidence: 0.95, scanComments: true,
    pattern: /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z\-_]{35}|xox[baprs]-[0-9A-Za-z-]{10,})\b|-----BEGIN(?:\s+\w+)?\s+PRIVATE KEY-----/,
  },
  {
    type: 'HARDCODED_SECRET', severity: 'HIGH', cwe: 'CWE-798', owasp: A07,
    description: 'A secret-like variable (password, api key, token, secret) is assigned a hardcoded string literal rather than read from configuration.',
    fix: 'Read the value from an environment variable or secret store; never commit credentials to source.',
    example: { vulnerable: 'password = "Sup3rS3cret!"', safe: 'password = os.environ["DB_PASSWORD"]' },
    languages: '*', confidence: 0.6,
    pattern: /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["'`][^"'`\s]{6,}["'`]/i,
    safe: ENV_LOOKUP, // env/config lookups and placeholders are fine
  },

  // ---------------- Cryptographic failures (CWE-327) ----------------
  {
    type: 'CRYPTO_FAILURE', severity: 'HIGH', cwe: 'CWE-327', owasp: A02,
    description: 'Use of a broken/weak cryptographic primitive (MD5, SHA-1, DES, RC4, or ECB mode) for security-sensitive work.',
    fix: 'Use modern algorithms: SHA-256/512 for hashing, bcrypt/scrypt/argon2 for passwords, and AES-GCM (not ECB) for encryption.',
    example: { vulnerable: 'crypto.createHash("md5")', safe: 'crypto.createHash("sha256") // bcrypt for passwords' },
    languages: '*', confidence: 0.8,
    pattern: /\b(?:md5|sha1)\b|createHash\(\s*["'`](?:md5|sha1)|["'`](?:DES|RC4|AES-\d+-ECB|.*ECB.*)["'`]|MessageDigest\.getInstance\(\s*["'](?:MD5|SHA-?1)/i,
    safe: /sha-?256|sha-?512|bcrypt|scrypt|argon2/i,
  },
  {
    type: 'CRYPTO_FAILURE', severity: 'MEDIUM', cwe: 'CWE-338', owasp: A02,
    description: 'Math.random() / weak PRNG used to generate a token, id, password, or other security-sensitive value — it is predictable.',
    fix: 'Use a cryptographically secure RNG: crypto.getRandomValues() / crypto.randomBytes() / secrets module (Python).',
    example: { vulnerable: 'const token = Math.random().toString(36)', safe: 'const token = crypto.randomUUID()' },
    languages: ['javascript', 'typescript'], confidence: 0.6,
    pattern: /\b(?:token|secret|password|otp|nonce|session|api[_-]?key|salt)\b[^;\n]*Math\.random\s*\(/i,
    safe: /crypto\.(?:getRandomValues|randomBytes|randomUUID)/,
  },
  {
    type: 'CRYPTO_FAILURE', severity: 'HIGH', cwe: 'CWE-295', owasp: A02,
    description: 'TLS certificate verification is disabled, exposing connections to man-in-the-middle attacks.',
    fix: 'Never disable certificate verification in production. Trust the system CA store; pin certificates if needed.',
    example: { vulnerable: 'requests.get(url, verify=False)', safe: 'requests.get(url) # verify defaults to True' },
    languages: '*', confidence: 0.85,
    pattern: /verify\s*=\s*False|rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/i,
  },

  // ---------------- Authentication / authorization (CWE-287) ----------------
  {
    type: 'AUTH_BYPASS', severity: 'CRITICAL', cwe: 'CWE-287', owasp: A07,
    description: 'A JSON Web Token is decoded WITHOUT verifying its signature (jwt.decode without verify), or the "none" algorithm is accepted — anyone can forge a token.',
    fix: 'Always verify the signature with an explicit allowlist of algorithms: jwt.verify(token, secret, { algorithms: ["HS256"] }).',
    example: { vulnerable: 'jwt.decode(token) // no verification', safe: 'jwt.verify(token, secret, { algorithms: ["HS256"] })' },
    languages: '*', confidence: 0.7,
    pattern: /jwt\.decode\s*\(|algorithm[s]?\s*[:=]\s*\[?\s*["']none["']|verify_signature\s*[:=]\s*False/i,
    safe: /jwt\.verify\(/,
  },
  {
    type: 'AUTH_BYPASS', severity: 'HIGH', cwe: 'CWE-287', owasp: A07,
    description: 'A password/secret/token is compared with == / === (or string equality), which is vulnerable to timing attacks.',
    fix: 'Compare secrets in constant time: crypto.timingSafeEqual() (Node), hmac.compare_digest() (Python).',
    example: { vulnerable: 'if (password === storedPassword)', safe: 'if (crypto.timingSafeEqual(a, b))' },
    languages: '*', confidence: 0.5,
    pattern: /\b(?:password|secret|token|hash|hmac|signature|api[_-]?key)\b\s*===?\s*\w|\w\s*===?\s*\b(?:password|secret|token|signature)\b/i,
    safe: /timingSafeEqual|compare_digest|hash\.equals|MessageDigest\.isEqual/i,
  },

  // ---------------- Path traversal (CWE-22) ----------------
  {
    type: 'PATH_TRAVERSAL', severity: 'HIGH', cwe: 'CWE-22', owasp: A01,
    description: 'A file path is built from request/user input without normalization, allowing "../" sequences to escape the intended directory.',
    fix: 'Resolve against a fixed base directory and verify the result stays inside it (path.resolve + startsWith check); strip "..".',
    example: {
      vulnerable: 'fs.readFile("./uploads/" + req.query.name)',
      safe: 'const p = path.resolve(base, name); if (!p.startsWith(base)) throw;',
    },
    languages: ['javascript', 'typescript', 'python', 'go', 'java'], confidence: 0.65,
    pattern: /(?:readFile|readFileSync|createReadStream|sendFile|open|os\.path\.join|ioutil\.ReadFile|os\.ReadFile|Files\.readAllBytes|new\s+File)\s*\([^)]*(?:req\.|request\.|params|query|body|input|userInput|filename)/i,
    safe: /path\.(?:normalize|resolve)\([^)]*\)\s*\.startsWith|basename\(|sanitize|allowlist|whitelist/i,
  },

  // ---------------- CORS / CSRF (CWE-352) ----------------
  {
    type: 'CORS_MISCONFIG', severity: 'HIGH', cwe: 'CWE-942', owasp: A05,
    description: 'CORS reflects any origin (Access-Control-Allow-Origin: *) — especially dangerous if combined with credentials, exposing user data cross-origin.',
    fix: 'Allowlist specific trusted origins; never combine a wildcard origin with Access-Control-Allow-Credentials: true.',
    example: {
      vulnerable: 'res.setHeader("Access-Control-Allow-Origin", "*")',
      safe: 'res.setHeader("Access-Control-Allow-Origin", trustedOrigin)',
    },
    languages: '*', confidence: 0.6,
    pattern: /access-control-allow-origin["'\s]*[:,]\s*["']\*["']|cors\(\s*\{[^}]*origin\s*:\s*["']\*["']|Access-Control-Allow-Origin["']\s*,\s*["']\*/i,
    safe: /trustedOrigin|allowlist|allowedOrigins/i,
  },
  {
    type: 'CSRF_MISCONFIG', severity: 'MEDIUM', cwe: 'CWE-352', owasp: A01,
    description: 'CSRF protection appears disabled, or a session cookie is set with SameSite=None without the Secure flag — enabling cross-site request forgery.',
    fix: 'Keep CSRF protection enabled, use SameSite=Lax/Strict cookies, and require a CSRF token (or double-submit cookie) on state-changing requests.',
    example: { vulnerable: 'csrf: false  // or SameSite=None without Secure', safe: 'csrf: true; cookie SameSite=Lax; Secure' },
    languages: '*', confidence: 0.5,
    pattern: /csrf\s*[:=]\s*(?:false|False|0|None)|samesite\s*[:=]\s*["']?none["']?(?![^;\n]*secure)/i,
  },

  // ---------------- PII / sensitive data exposure (CWE-359) ----------------
  {
    type: 'PII_EXPOSURE', severity: 'MEDIUM', cwe: 'CWE-359', owasp: A09,
    description: 'Sensitive/PII data (password, SSN, credit card, token, etc.) is written to logs, where it can leak.',
    fix: 'Never log secrets or PII. Redact sensitive fields before logging and avoid logging full request/user objects.',
    example: { vulnerable: 'console.log("pwd:", password)', safe: 'console.log("login attempt for", userId)' },
    languages: '*', confidence: 0.6,
    pattern: /(?:console\.(?:log|info|debug|warn)|print|println|System\.out\.print|logger?\.\w+|logging\.\w+)\s*\([^)]*\b(?:password|passwd|ssn|social.?security|credit.?card|card.?number|cvv|secret|api[_-]?key|access[_-]?token|private[_-]?key)\b/i,
  },
  {
    type: 'PII_EXPOSURE', severity: 'HIGH', cwe: 'CWE-359', owasp: A02,
    description: 'A literal that looks like real PII (US SSN or a credit-card number) appears in source code.',
    fix: 'Remove real PII from source/test data; use clearly-fake values and store real data encrypted at rest.',
    example: { vulnerable: 'const ssn = "123-45-6789"', safe: 'const ssn = faker.fakeSSN() // synthetic test data' },
    languages: '*', confidence: 0.55,
    pattern: /\b\d{3}-\d{2}-\d{4}\b|\b(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|6(?:011|5\d{2})\d{12})\b/,
    safe: /faker|fake|example|test|dummy|0000|1234567/i,
  },

  // ---------------- Insecure / outdated dependencies (CWE-1104) ----------------
  {
    type: 'INSECURE_DEPENDENCY', severity: 'MEDIUM', cwe: 'CWE-1104', owasp: A06,
    description: 'A dependency is pinned to a wildcard / "latest" version (non-reproducible, may pull vulnerable code), or to a release with a well-known critical CVE. (Versioned CVEs are reported separately by the dependency scanner.)',
    fix: 'Pin exact, patched versions and run an SCA/audit (npm audit, pip-audit, govulncheck) in CI.',
    example: { vulnerable: '"lodash": "*"  // or log4j-core 2.14.1 (Log4Shell)', safe: '"lodash": "4.17.21"' },
    languages: '*', confidence: 0.55,
    pattern: /["'][\w@/.-]+["']\s*:\s*["'](?:\*|latest)["']|\blog4j-core\b["'\s:]+2\.(?:[0-9]|1[0-6])\b/i,
  },
];

// ---- scanner -----------------------------------------------------------------
function ruleApplies(rule: Rule, lang: Language): boolean {
  if (rule.languages === '*') return true;
  // Apply '*'/unknown-language files to the JS/TS/generic rules so a misnamed file
  // still gets the high-value checks (secrets, weak crypto) — but skip language-specific ones.
  if (lang === 'unknown') return rule.languages.includes('javascript') || rule.cwe === 'CWE-798';
  return rule.languages.includes(lang);
}

// Scan a single file with the deterministic rules. Returns findings (no code retained).
function scanFile(path: string, content: string): AuditFinding[] {
  const lang = detectLanguage(path);
  const lines = content.split('\n');
  const out: AuditFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 2000) continue; // skip minified/giant lines (noise)
    const comment = isCommentLine(line, lang);
    for (const rule of RULES) {
      if (!ruleApplies(rule, lang)) continue;
      if (comment && !rule.scanComments) continue;
      const m = rule.pattern.exec(line);
      if (!m) continue;
      if (rule.safe && rule.safe.test(line)) continue; // known-safe equivalent present
      out.push({
        type: rule.type, severity: rule.severity, cwe: rule.cwe, owasp: rule.owasp,
        description: rule.description, fix: rule.fix, example: rule.example,
        location: { file: path, line: i + 1, column: (m.index ?? 0) + 1 },
        source: 'pattern', confidence: rule.confidence,
      });
    }
  }
  return out;
}

// Dedupe identical findings (same type + file + line); keep the highest confidence.
export function dedupeFindings(findings: AuditFinding[]): AuditFinding[] {
  const byKey = new Map<string, AuditFinding>();
  for (const f of findings) {
    const key = `${f.type}|${f.location.file}|${f.location.line}`;
    const prev = byKey.get(key);
    if (!prev || f.confidence > prev.confidence) {
      // If both a pattern and an AI engine agree, bump confidence and note corroboration.
      const entry = (prev && prev.source !== f.source)
        ? { ...f, confidence: Math.min(1, Math.max(f.confidence, prev.confidence) + 0.1) }
        : f;
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.location.file.localeCompare(b.location.file) || a.location.line - b.location.line,
  );
}

export function summarize(findings: AuditFinding[]) {
  const s = { critical: 0, high: 0, medium: 0, low: 0, total: findings.length };
  for (const f of findings) {
    if (f.severity === 'CRITICAL') s.critical++;
    else if (f.severity === 'HIGH') s.high++;
    else if (f.severity === 'MEDIUM') s.medium++;
    else s.low++;
  }
  return s;
}

// 0..100: starts at 100 and subtracts a weighted penalty per finding (scaled by
// confidence), then clamps. A clean file scores 100.
export function healthScore(findings: AuditFinding[]): number {
  let penalty = 0;
  for (const f of findings) penalty += SEVERITY_WEIGHT[f.severity] * (0.5 + 0.5 * f.confidence);
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

// Run the deterministic engine across files. Synchronous, zero model calls, no code stored.
export function auditPatterns(files: AuditInput[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const f of files) {
    if (!f.content || f.content.length > 600_000) continue; // skip empty / huge blobs
    out.push(...scanFile(f.path, f.content));
  }
  return out;
}

// Offline static scan: line patterns (SAST) + IaC/config + container misconfigs. Dependency
// CVEs come from the live OSV feed in the product path (see scaOnline.onlineScan), so they
// are NOT included here to avoid duplicates.
export function scanStatic(files: AuditInput[]): AuditFinding[] {
  return [...auditPatterns(files), ...auditConfig(files)];
}

// Fully offline scan INCLUDING the curated dependency DB — used where there is no async
// network pass (the builder's instant teaser).
export function scanOffline(files: AuditInput[]): AuditFinding[] {
  return [...scanStatic(files), ...auditDependencies(files)];
}

// Assemble a full AuditResult from a set of findings (pattern + optional AI).
export function buildResult(files: AuditInput[], findings: AuditFinding[], level: AuditLevel): AuditResult {
  const deduped = dedupeFindings(findings);
  const languages = [...new Set(files.map((f) => detectLanguage(f.path)))];
  return {
    findings: deduped,
    codeHealthScore: healthScore(deduped),
    level,
    languages,
    summary: summarize(deduped),
    scannedFiles: files.length,
    privacyNotice: PRIVACY_NOTICE,
  };
}
