/* Yield Code — agentic coder over /api/code (SSE). Connects a GitHub repo, a Yield
   project, or a local scratch workspace; streams multi-file edits and commits them. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Minimal safe markdown (headings/lists/code/inline) — same approach as Yield Chat.
  function mdToHtml(src) {
    const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
    let html = '', i = 0, list = null;
    const closeL = () => { if (list) { html += `</${list}>`; list = null; } };
    const inl = (s) => s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\b(https?:\/\/[^\s<)]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) { closeL(); const code = []; i++; while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; } i++; html += `<pre><code>${esc(code.join('\n'))}</code></pre>`; continue; }
      const raw = esc(line); let m;
      if ((m = raw.match(/^(#{1,3})\s+(.*)$/))) { closeL(); html += `<h${m[1].length}>${inl(m[2])}</h${m[1].length}>`; i++; continue; }
      if ((m = raw.match(/^\s*[-*+]\s+(.*)$/))) { if (list !== 'ul') { closeL(); html += '<ul>'; list = 'ul'; } html += `<li>${inl(m[1])}</li>`; i++; continue; }
      if ((m = raw.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== 'ol') { closeL(); html += '<ol>'; list = 'ol'; } html += `<li>${inl(m[1])}</li>`; i++; continue; }
      if (!line.trim()) { closeL(); i++; continue; }
      closeL(); const para = [raw]; i++;
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,3}\s|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i])) { para.push(esc(lines[i])); i++; }
      html += `<p>${inl(para.join('<br>'))}</p>`;
    }
    closeL(); return html;
  }

  async function readSSE(bodyStream, onEvent) {
    const reader = bodyStream.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += value; let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let ev = 'message', data = [];
        for (const l of chunk.split('\n')) { if (l.startsWith('event:')) ev = l.slice(6).trim(); else if (l.startsWith('data:')) data.push(l.slice(5).replace(/^ /, '')); }
        if (!data.length) continue;
        let d; try { d = JSON.parse(data.join('\n')); } catch { d = data.join('\n'); }
        onEvent(ev, d);
      }
    }
  }

  // ---- State -----------------------------------------------------------------
  const state = {
    mode: 'repo', repo: '', branch: 'main', projectId: '',
    model: 'auto', models: [{ id: 'auto', label: 'Auto', blurb: 'Reads your request and picks the best model.', tier: 'flash' }],
    github: { connected: false, login: null }, projects: [],
    files: new Map(), changed: new Set(), activePath: null,
    mcp: [], history: [], streaming: false, abort: null, hadHello: true,
  };
  try { state.mcp = JSON.parse(localStorage.getItem('yield.code.mcp') || '[]') || []; } catch {}
  const saveMcp = () => { try { localStorage.setItem('yield.code.mcp', JSON.stringify(state.mcp)); } catch {} };

  // ---- Init: status ----------------------------------------------------------
  async function init() {
    try {
      const r = await fetch('/api/code/status'); const j = await r.json();
      state.github = j.github || state.github;
      if (Array.isArray(j.models)) state.models = [state.models[0], ...j.models];
      state.projects = j.projects || [];
    } catch {}
    renderConn(); renderModelPanel(); renderProjects(); renderMcp();
    if (state.github.connected) loadRepos();
    else { $('repoSel').innerHTML = '<option value="">Connect GitHub in Settings to pick a repo…</option>'; $('repoNote').innerHTML = 'Sign in and <a href="/settings">connect GitHub</a> to edit a repo — or switch to <b>Local</b> to start a scratch workspace.'; }
    gateRun();
  }
  function renderConn() {
    const el = $('ycConn');
    if (state.github.connected) { el.classList.add('ok'); $('ycConnText').textContent = '@' + state.github.login; }
    else { el.classList.remove('ok'); $('ycConnText').innerHTML = '<a href="/settings" style="color:var(--muted)">Connect GitHub</a>'; }
  }
  async function loadRepos() {
    try {
      const r = await fetch('/api/code/repos'); const j = await r.json();
      if (Array.isArray(j.repos)) {
        const sel = $('repoSel'); sel.innerHTML = '<option value="">Pick a repo…</option>';
        for (const repo of j.repos) { const o = document.createElement('option'); o.value = repo.full_name; o.textContent = repo.full_name + (repo.private ? ' (private)' : ''); o.dataset.branch = repo.default_branch || 'main'; sel.appendChild(o); }
      }
    } catch {}
  }
  function renderProjects() {
    const sel = $('projectSel'); sel.innerHTML = '<option value="">Pick a Yield project…</option>';
    for (const p of state.projects) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.title + (p.github_repo ? ' · ' + p.github_repo : ''); sel.appendChild(o); }
  }

  // ---- Source mode -----------------------------------------------------------
  function setMode(mode) {
    state.mode = mode;
    for (const b of $('ycSeg').children) b.classList.toggle('on', b.dataset.mode === mode);
    $('srcRepo').classList.toggle('hidden', mode !== 'repo');
    $('srcProject').classList.toggle('hidden', mode !== 'project');
    $('srcLocal').classList.toggle('hidden', mode !== 'local');
    if (mode === 'local' && !state.files.size) { renderTree(); }
    gateRun();
  }
  async function loadRepoTree() {
    if (!state.repo) return;
    setTree('Loading ' + state.repo + '…');
    try {
      const r = await fetch('/api/code/tree?repo=' + encodeURIComponent(state.repo) + '&branch=' + encodeURIComponent(state.branch));
      const j = await r.json();
      state.files.clear(); state.changed.clear(); state.activePath = null;
      if (Array.isArray(j.tree)) { for (const t of j.tree) if (t.type === 'blob') state.files.set(t.path, null); }
      $('repoLoaded').classList.remove('hidden');
      $('repoLoaded').textContent = state.files.size + ' files · ' + state.repo + '@' + state.branch;
      $('ycRepoLink').classList.remove('hidden'); $('ycRepoLink').href = 'https://github.com/' + state.repo;
      renderTree();
    } catch { setTree('Could not load repo tree.'); }
  }
  async function openFile(path) {
    state.activePath = path; renderTree();
    const cached = state.files.get(path);
    $('filePath').textContent = path;
    $('fileHead').querySelector('.chg')?.remove();
    if (state.changed.has(path)) { const c = document.createElement('span'); c.className = 'chg'; c.textContent = 'changed'; $('fileHead').appendChild(c); }
    if (cached != null) { $('fileBody').textContent = cached; return; }
    if (state.mode !== 'repo') { $('fileBody').textContent = ''; return; }
    $('fileBody').textContent = 'Loading…';
    try {
      const r = await fetch('/api/code/file?repo=' + encodeURIComponent(state.repo) + '&branch=' + encodeURIComponent(state.branch) + '&path=' + encodeURIComponent(path));
      const j = await r.json();
      const content = j.content != null ? j.content : '(could not read file)';
      if (state.files.get(path) == null) state.files.set(path, content);
      if (state.activePath === path) $('fileBody').textContent = state.files.get(path);
    } catch { $('fileBody').textContent = '(could not read file)'; }
  }

  // ---- File tree + viewer ----------------------------------------------------
  function setTree(msg) { $('fileTree').innerHTML = `<div class="empty">${esc(msg)}</div>`; }
  function renderTree() {
    const tree = $('fileTree');
    const paths = [...state.files.keys()].sort();
    if (!paths.length) { setTree(state.mode === 'local' ? 'Files the agent writes appear here.' : 'No files loaded yet.'); updateBadge(); return; }
    tree.innerHTML = '';
    for (const p of paths) {
      const row = document.createElement('div');
      row.className = 'ft' + (p === state.activePath ? ' active' : '') + (state.changed.has(p) ? ' changed' : '');
      const name = document.createElement('span'); name.textContent = p;
      row.appendChild(name);
      if (state.changed.has(p)) { const t = document.createElement('span'); t.className = 'tick'; t.textContent = '●'; row.appendChild(t); }
      row.addEventListener('click', () => openFile(p));
      tree.appendChild(row);
    }
    updateBadge();
  }
  function updateBadge() {
    const b = $('filesBadge');
    if (state.changed.size) { b.classList.remove('hidden'); b.textContent = state.changed.size; }
    else b.classList.add('hidden');
  }

  // ---- MCP --------------------------------------------------------------------
  function renderMcp() {
    const list = $('mcpList'); list.innerHTML = '';
    $('mcpCount').textContent = state.mcp.length ? '· ' + state.mcp.length : '';
    if (!state.mcp.length) { list.innerHTML = '<div class="yc-note" style="color:var(--faint)">None connected.</div>'; return; }
    state.mcp.forEach((s, idx) => {
      const row = document.createElement('div'); row.className = 'mcp-item';
      row.innerHTML = `<span class="mn">${esc(s.name)}</span><span class="mw">${esc(s.url || s.command || '')}</span><span class="rm" title="Remove">×</span>`;
      row.querySelector('.rm').addEventListener('click', () => { state.mcp.splice(idx, 1); saveMcp(); renderMcp(); });
      list.appendChild(row);
    });
  }
  function addMcp() {
    const name = $('mcpName').value.trim(); const where = $('mcpWhere').value.trim();
    if (!name || !where) return;
    const isUrl = /^https?:\/\//i.test(where);
    state.mcp.push({ name, transport: isUrl ? 'http' : 'stdio', [isUrl ? 'url' : 'command']: where });
    $('mcpName').value = ''; $('mcpWhere').value = ''; saveMcp(); renderMcp();
  }

  // ---- Model picker ----------------------------------------------------------
  function renderModelPanel() {
    const panel = $('ycModelPanel'); panel.innerHTML = '';
    for (const m of state.models) {
      const opt = document.createElement('div'); opt.className = 'model-opt' + (m.id === state.model ? ' on' : '');
      opt.innerHTML = `<div class="mo-top"><span class="mo-name">${esc(m.label)}</span><span class="mo-tier">${esc(m.tier || '')}</span></div><div class="mo-blurb">${esc(m.blurb || '')}</div>`;
      opt.addEventListener('click', () => { state.model = m.id; $('ycModelLabel').textContent = m.label; panel.classList.add('hidden'); renderModelPanel(); });
      panel.appendChild(opt);
    }
  }

  // ---- Messages --------------------------------------------------------------
  function clearHello() { if (state.hadHello) { $('ycHello')?.remove(); state.hadHello = false; } }
  function addMsg(role, html) {
    clearHello();
    const wrap = document.createElement('div'); wrap.className = 'ymsg ' + (role === 'user' ? 'user' : 'ai');
    const av = document.createElement('div'); av.className = 'av'; av.textContent = role === 'user' ? 'You' : '◆';
    const body = document.createElement('div'); body.className = 'body';
    const prose = document.createElement('div'); prose.className = 'prose'; prose.innerHTML = html;
    body.appendChild(prose); wrap.appendChild(av); wrap.appendChild(body);
    $('ycMsgs').appendChild(wrap); $('ycMsgs').scrollTop = $('ycMsgs').scrollHeight;
    return { wrap, body, prose };
  }
  function setStatus(msgEl, stage) {
    let s = msgEl.body.querySelector('.status-line');
    if (!s) { s = document.createElement('div'); s.className = 'status-line'; s.innerHTML = '<span class="spin"></span><span class="st"></span>'; msgEl.body.appendChild(s); }
    s.querySelector('.st').textContent = stage;
    $('ycMsgs').scrollTop = $('ycMsgs').scrollHeight;
  }

  // ---- Activity --------------------------------------------------------------
  const workers = new Map();
  function logLine(text) {
    const log = $('actLog'); if (log.querySelector('.act-empty')) log.innerHTML = '';
    const d = document.createElement('div'); d.textContent = '› ' + text; log.appendChild(d); log.scrollTop = log.scrollHeight;
  }
  function upsertWorker(w) {
    const box = $('workers'); if (box.querySelector('.act-empty')) box.innerHTML = '';
    let row = workers.get(w.name);
    if (!row) { row = document.createElement('div'); box.appendChild(row); workers.set(w.name, row); }
    row.className = 'worker-row ' + (w.status || 'start');
    row.innerHTML = `<span class="wdot"></span><span class="wname">${esc(w.name)}</span>${w.detail ? `<span class="wdetail">${esc(w.detail)}</span>` : ''}<span class="wmodel">${esc(w.model || '')}</span>`;
  }
  function addCommit(path) {
    const box = $('commits'); if (box.querySelector('.act-empty')) box.innerHTML = '';
    const d = document.createElement('div'); d.className = 'commit-row';
    d.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg> ${esc(path)}`;
    box.appendChild(d);
  }

  // ---- Run -------------------------------------------------------------------
  function gateRun() {
    const hasInput = $('ycInput').value.trim().length > 0;
    let hasSource = state.mode === 'local' || (state.mode === 'repo' && state.repo) || (state.mode === 'project' && state.projectId);
    $('ycRun').disabled = !hasInput || !hasSource || state.streaming;
  }
  function setStreaming(on) {
    state.streaming = on;
    $('ycStop').classList.toggle('hidden', !on);
    $('ycRun').classList.toggle('hidden', on);
    gateRun();
  }

  async function run() {
    const text = $('ycInput').value.trim(); if (!text || state.streaming) return;
    let hasSource = state.mode === 'local' || (state.mode === 'repo' && state.repo) || (state.mode === 'project' && state.projectId);
    if (!hasSource) return;
    $('ycInput').value = ''; autoGrow();
    addMsg('user', `<p>${esc(text)}</p>`);
    const ai = addMsg('ai', '');
    setStatus(ai, 'Starting…');
    let think = null, thinkText = '', answer = '';

    const body = { prompt: text, mode: state.mode, model: state.model, thinking: $('ycThink').value, agentMode: $('ycAgent').checked, history: state.history.slice(-8), mcpServers: state.mcp };
    if (state.mode === 'repo') { body.repo = state.repo; body.branch = state.branch; }
    else if (state.mode === 'project') { body.projectId = state.projectId; }
    else if (state.mode === 'local') { body.files = [...state.files].filter(([, v]) => v != null).map(([path, content]) => ({ path, content })); }

    setStreaming(true); state.abort = new AbortController();
    try {
      const res = await fetch('/api/code/run', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: state.abort.signal, body: JSON.stringify(body) });
      if (!res.ok || !res.body) { const j = await res.json().catch(() => ({})); throw new Error(j.error || ('HTTP ' + res.status)); }
      await readSSE(res.body, (ev, d) => handleEvent(ev, d, ai, {
        setThink: (t) => { thinkText += t; if (!think) { think = document.createElement('details'); think.className = 'think'; think.innerHTML = '<summary>Thinking…</summary><div class="tc"></div>'; ai.body.insertBefore(think, ai.body.firstChild); } think.querySelector('.tc').textContent = thinkText; },
        addChat: (t) => { answer += t; ai.prose.innerHTML = mdToHtml(answer); $('ycMsgs').scrollTop = $('ycMsgs').scrollHeight; },
        getAnswer: () => answer, setAnswer: (v) => { answer = v; ai.prose.innerHTML = mdToHtml(answer); },
      }));
    } catch (e) {
      if (state.abort && state.abort.signal.aborted) setStatus(ai, '■ Stopped.');
      else setStatus(ai, 'Error: ' + (e.message || 'failed'));
    }
    // finalize
    ai.body.querySelector('.status-line')?.remove();
    if (think) think.querySelector('summary').textContent = 'Thought process';
    if (!answer && !ai.prose.innerHTML) ai.prose.innerHTML = '<p style="color:var(--faint)">Done.</p>';
    state.history.push({ role: 'user', content: text });
    if (answer) state.history.push({ role: 'assistant', content: answer });
    setStreaming(false); state.abort = null;
  }

  function handleEvent(ev, d, ai, io) {
    if (ev === 'meta') {
      const label = d.label || d.model; $('ycModelLabel').textContent = label && state.model !== 'auto' ? $('ycModelLabel').textContent : $('ycModelLabel').textContent;
      logLine('Model: ' + label + (d.mode ? ' · ' + d.mode : ''));
      setStatus(ai, 'Working with ' + label + '…');
    } else if (ev === 'status') {
      setStatus(ai, d.stage || ''); logLine(d.stage || '');
    } else if (ev === 'thinking') {
      io.setThink(typeof d === 'string' ? d : JSON.stringify(d));
    } else if (ev === 'chat') {
      io.addChat(typeof d === 'string' ? d : '');
    } else if (ev === 'context') {
      if (Array.isArray(d.files)) { for (const p of d.files) if (!state.files.has(p)) state.files.set(p, null); renderTree(); }
      logLine('Loaded ' + (d.files ? d.files.length : 0) + ' files' + (d.repo ? ' from ' + d.repo : ''));
    } else if (ev === 'code') {
      onCode(d);
    } else if (ev === 'worker') {
      upsertWorker(d); logLine('Agent ' + d.name + ': ' + (d.status || ''));
    } else if (ev === 'research') {
      if (d.findings) logLine('Helper ' + d.name + ' returned findings'); else logLine('Helper ' + d.name + ' researching…');
    } else if (ev === 'committed') {
      addCommit(d.path); logLine('Committed ' + d.path);
    } else if (ev === 'blocked') {
      io.setAnswer('🛡️ ' + (d.message || 'Blocked by the safety guard.'));
    } else if (ev === 'error') {
      io.setAnswer(io.getAnswer() || ('⚠️ ' + (d.message || 'Something went wrong.')));
    } else if (ev === 'done') {
      onDone(d, ai, io);
    }
  }

  function onCode(d) {
    if (!d || !d.path) return;
    if (d.start && !state.files.has(d.path)) state.files.set(d.path, '');
    if (d.start && state.files.get(d.path) == null) state.files.set(d.path, '');
    if (d.delta) {
      const cur = state.files.get(d.path); state.files.set(d.path, (cur == null ? '' : cur) + d.delta);
    }
    state.changed.add(d.path);
    // Live-follow the file being written.
    if (!state.activePath || state.streaming) { state.activePath = d.path; $('filePath').textContent = d.path; $('fileBody').textContent = state.files.get(d.path) || ''; $('fileBody').scrollTop = $('fileBody').scrollHeight; }
    renderTree();
  }

  function onDone(d, ai, io) {
    ai.body.querySelector('.status-line')?.remove();
    if (Array.isArray(d.files)) for (const f of d.files) { state.files.set(f.path, f.content); state.changed.add(f.path); }
    if (Array.isArray(d.committed) && d.committed.length) for (const p of d.committed) if (!$('commits').textContent.includes(p)) addCommit(p);
    renderTree();
    let msg = d.chat || 'Done.';
    if (d.committed && d.committed.length) msg += `\n\n✅ Committed ${d.committed.length} file(s) to ${d.repo}.`;
    else if (d.hasCode && state.mode === 'local') msg += `\n\n📄 Wrote ${d.files ? d.files.length : 0} file(s) to the workspace — open the Files tab.`;
    io.setAnswer(msg);
    if (d.githubUrl) { $('ycRepoLink').classList.remove('hidden'); $('ycRepoLink').href = d.githubUrl; }
    logLine('Done.');
  }

  // ---- Wire ------------------------------------------------------------------
  function autoGrow() { const t = $('ycInput'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 180) + 'px'; gateRun(); }
  for (const b of $('ycSeg').children) b.addEventListener('click', () => setMode(b.dataset.mode));
  $('repoSel').addEventListener('change', (e) => {
    state.repo = e.target.value;
    const opt = e.target.selectedOptions[0]; if (opt && opt.dataset.branch) { state.branch = opt.dataset.branch; $('branchInput').value = state.branch; }
    if (state.repo) loadRepoTree(); gateRun();
  });
  $('branchInput').addEventListener('change', (e) => { state.branch = e.target.value.trim() || 'main'; if (state.repo) loadRepoTree(); });
  $('projectSel').addEventListener('change', (e) => { state.projectId = e.target.value; gateRun(); });
  $('mcpAdd').addEventListener('click', addMcp);
  $('ycModelBtn').addEventListener('click', () => $('ycModelPanel').classList.toggle('hidden'));
  document.addEventListener('click', (e) => { if (!e.target.closest('.yc-model')) $('ycModelPanel').classList.add('hidden'); });
  $('ycInput').addEventListener('input', autoGrow);
  $('ycInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); } });
  $('ycForm').addEventListener('submit', (e) => { e.preventDefault(); run(); });
  $('ycStop').addEventListener('click', () => { if (state.abort) state.abort.abort(); });
  for (const t of document.querySelectorAll('.yc-tab')) t.addEventListener('click', () => {
    for (const x of document.querySelectorAll('.yc-tab')) x.classList.remove('active');
    t.classList.add('active');
    $('filesPanel').classList.toggle('hidden', t.dataset.tab !== 'files');
    $('activityPanel').classList.toggle('hidden', t.dataset.tab !== 'activity');
  });

  init();
})();
