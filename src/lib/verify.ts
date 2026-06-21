// Static verification of a built app — catches the breakages that make multi-page
// apps "not work": links/scripts pointing at files that were never created, leftover
// placeholder/stub text, dead links, and raw browser dialogs.
//
// It is deterministic and dependency-free so it can run server-side after every build
// (and be unit-tested). Hard issues trigger an automatic repair pass; soft issues are
// passed along as extra context for that pass but don't trigger one on their own.

export interface VerifyResult {
  /** Definitively broken — the app won't work as built. Triggers an auto-repair pass. */
  hardIssues: string[];
  /** Quality problems (dialogs, dead links) — fixed if a repair pass already runs. */
  softIssues: string[];
}

// Refs we never check: absolute URLs, protocol-relative, anchors, data/blob, JS, mail/tel.
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?)/i;
// Local file types we actually serve and can therefore verify exist.
const CHECKABLE = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'svg']);

// Resolve a relative ref (from a given file) to a normalized project-root path.
function resolveRef(fromPath: string, ref: string): string {
  const clean = ref.split('#')[0].split('?')[0].trim();
  if (!clean) return '';
  const dir = fromPath.includes('/') ? fromPath.replace(/\/[^/]*$/, '/') : '';
  const raw = clean.startsWith('/') ? clean.slice(1) : dir + clean;
  const out: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

export function verifyFiles(files: { path: string; content: string }[]): VerifyResult {
  const hard: string[] = [];
  const soft: string[] = [];
  if (!files.length) return { hardIssues: hard, softIssues: soft };

  const paths = new Set(files.map((f) => f.path.replace(/^\/+/, '')));
  const has = (p: string) => paths.has(p) || paths.has(p.replace(/^\.\//, ''));
  const contentOf = new Map(files.map((f) => [f.path.replace(/^\/+/, ''), f.content] as const));

  // Entry point must exist.
  if (!has('index.html')) hard.push('Missing entry point: there is no index.html (the page that loads first).');

  // Broken local references: every src=/href= to a local checkable file must exist —
  // and any local script/style it loads must not be an empty stub.
  const missing = new Set<string>();
  const emptyRefs = new Set<string>();
  for (const f of files) {
    if (!/\.html?$/i.test(f.path)) continue;
    const attrRe = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(f.content))) {
      const ref = m[1].trim();
      if (!ref || EXTERNAL.test(ref)) continue;
      const target = resolveRef(f.path, ref);
      if (!target) continue;
      const ext = (target.split('.').pop() || '').toLowerCase();
      if (!CHECKABLE.has(ext)) continue; // images/fonts may be generated or external
      const alt = ext === 'htm' ? target.replace(/\.htm$/, '.html') : target;
      if (!has(target) && !has(alt)) { missing.add(`${f.path} references "${ref}" but no such file was created`); continue; }
      // Loaded but empty = a stub that was never filled in (a half-built app).
      if (ext === 'js' || ext === 'mjs' || ext === 'css') {
        const body = contentOf.get(target) ?? contentOf.get(alt) ?? 'x';
        if (!body.trim()) emptyRefs.add(`${f.path} loads "${ref}" but ${target} is empty`);
      }
    }
  }
  for (const msg of missing) hard.push(`Broken link: ${msg}.`);
  for (const msg of emptyRefs) hard.push(`Empty file: ${msg} — fill it in (write the real code) or remove the reference.`);

  // Truncated documents — a page that opens <html>/<body> but never closes it is the
  // classic sign the model ran out of tokens mid-file, leaving a half-built app.
  for (const f of files) {
    if (!/\.html?$/i.test(f.path)) continue;
    const c = f.content;
    if (/<body[\s>]/i.test(c) && !/<\/body>/i.test(c)) {
      hard.push(`Truncated page: ${f.path} opens <body> but is missing </body> — it was cut off. Re-output the whole file, complete.`);
    } else if (/<html[\s>]/i.test(c) && !/<\/html>/i.test(c)) {
      hard.push(`Truncated page: ${f.path} is missing its closing </html> — it looks cut off. Re-output the whole file, complete.`);
    }
  }

  // Placeholder / unfinished markers in the actual content.
  const blob = files.map((f) => f.content).join('\n');
  if (/lorem ipsum|coming soon|\bTODO\b|\bFIXME\b|placeholder text|your (?:text|content|name) here|insert [\w ]+ here|\[\s*(?:todo|placeholder)\s*\]/i.test(blob)) {
    hard.push('Placeholder/unfinished content present (e.g. "lorem ipsum", "coming soon", "TODO", "your text here"). Replace it with real content.');
  }

  // Omission markers — the model described code instead of writing it ("rest of the
  // code here", "// ...", "omitted for brevity"). That ships a non-working app.
  if (/rest of (?:the|your|this) (?:code|file|html|app|page|implementation|markup|content)|(?:remaining|other) (?:code|files?|pages?|sections?|markup|content|lines)(?: are| is)? (?:unchanged|omitted|the same|here)|implementation (?:goes here|omitted|not shown)|omitted for brevity|truncated for (?:brevity|space)|<!--\s*\.\.\.[^>]*-->|\/\/\s*\.\.\.\s*(?:rest|more|continue|existing|etc|and so on)|\/\/\s*(?:rest of|add the rest|the rest|your code here|fill (?:in|this)|continue here)|\/\*\s*\.\.\.\s*(?:rest|more|existing)[^*]*\*\//i.test(blob)) {
    hard.push('Unfinished output: parts were left out (e.g. "rest of the code here", "// ...", "omitted for brevity"). Every file must be written IN FULL, with no elisions.');
  }

  // Dead links — actionable elements that go nowhere.
  const dead = (blob.match(/href\s*=\s*["'](?:#|javascript:\s*void\s*\(\s*0\s*\)\s*;?)["']/gi) || []).length;
  if (dead > 0) soft.push(`${dead} link(s) point nowhere (href="#") — wire each to a real page or action.`);

  // Raw browser dialogs.
  if (/(?<![\w.])(?:alert|confirm|prompt)\s*\(/.test(blob)) {
    soft.push('Uses raw browser dialogs (alert/confirm/prompt) — replace with in-app toasts/modals.');
  }

  return { hardIssues: hard, softIssues: soft };
}
