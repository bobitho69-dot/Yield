// Yield builder — client logic.
const $ = (s) => document.querySelector(s);
const state = { user: null, authEnabled: true, providers: {}, models: [], model: 'auto', recommended: null, projectId: null,
  files: [], activeFile: 'index.html', streaming: false,
  working: false, queue: [], autofixCount: 0, previewErrors: [], pendingSecrets: [],
  github: { connected: false, login: null }, githubRepo: null, githubUrl: null };
const MAX_AUTOFIX = 2;

// ---------- Boot ----------
init();
async function init() {
  await Promise.all([loadStatus(), loadModels()]);
  if (state.user) await Promise.all([loadProjects(), loadGithub()]);
  wireEvents();
  refreshPreview();
  renderFileTree();
  // Open a specific project if requested (?project=ID from the dashboard).
  const wanted = new URLSearchParams(location.search).get('project');
  if (wanted && state.user) await openProject(wanted).catch(() => {});
  handleQueryFlags();
}

async function loadStatus() {
  try {
    const s = await fetch('/api/status').then((r) => r.json());
    state.user = s.user;
    state.authEnabled = s.authEnabled !== false;
    state.providers = s.providers || {};
    renderAuth();
    renderBanner(s);
    renderQuota(s);
  } catch { /* offline */ }
}

async function loadModels() {
  const { models } = await fetch('/api/models').then((r) => r.json());
  state.models = models || [];
  renderModelPanel();
  updateModelButton();
}

// ---------- Mini AI selector ----------
function modelById(id) { return state.models.find((m) => m.id === id); }

function speedBars(n) {
  return `<span class="speed" title="Speed">${[1,2,3,4,5].map((i) => `<i class="${i <= (n||3) ? 'on' : ''}"></i>`).join('')}</span>`;
}

function renderModelPanel() {
  const panel = $('#modelPanel');
  panel.innerHTML = `<div class="panel-head">Choose an AI · or let Auto pick</div>` + state.models.map((m) => {
    const isAuto = m.id === 'auto';
    const active = state.model === m.id ? 'active' : '';
    const rec = state.model === 'auto' && state.recommended === m.id ? 'recommended' : '';
    const recTag = rec ? `<span class="rec-tag">Auto pick</span>` : '';
    const pros = (m.pros || []).map((p) => `<div class="pc pro">✓ ${esc(p)}</div>`).join('');
    const cons = (m.cons || []).map((c) => `<div class="pc con">– ${esc(c)}</div>`).join('');
    return `<div class="model-row ${active} ${rec}" data-id="${m.id}">
      <div class="mr-top">
        <span class="mr-name">${esc(m.label)}</span>
        ${isAuto ? '' : `<span class="tier-badge ${m.tier}">${m.tier}</span>`}
        ${recTag || (isAuto ? '' : speedBars(m.speed))}
      </div>
      <div class="mr-blurb">${esc(m.blurb)}</div>
      ${(pros || cons) ? `<div class="proscons">${pros}${cons}</div>` : ''}
    </div>`;
  }).join('');
  panel.querySelectorAll('.model-row').forEach((row) => row.addEventListener('click', () => selectModel(row.dataset.id)));
}

function updateModelButton() {
  const m = modelById(state.model);
  $('#modelBtnLabel').textContent = m ? m.label : 'Auto';
}

function selectModel(id) {
  state.model = id;
  updateModelButton();
  renderModelPanel();
  $('#modelPanel').classList.add('hidden');
  if (id === 'auto') maybeRecommend();
  else $('#autoPick').textContent = '';
}

// Live: when Auto is selected, ask gpt-oss-20b which model fits the current prompt.
let recTimer = null;
function maybeRecommend() {
  clearTimeout(recTimer);
  if (state.model !== 'auto') { $('#autoPick').textContent = ''; return; }
  const prompt = $('#prompt').value.trim();
  if (prompt.length < 12) { $('#autoPick').textContent = ''; state.recommended = null; renderModelPanel(); return; }
  $('#autoPick').innerHTML = '<span class="muted">analyzing…</span>';
  recTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/route', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }),
      }).then((x) => x.json());
      if (state.model !== 'auto') return;
      state.recommended = r.model;
      $('#autoPick').innerHTML = `Auto → <b>${esc(r.label || r.model)}</b> · ${esc(r.reason || '')}`;
      renderModelPanel();
    } catch { $('#autoPick').textContent = ''; }
  }, 600);
}

async function loadProjects() {
  try {
    const { projects } = await fetch('/api/projects').then((r) => r.json());
    const el = $('#projectList');
    if (!projects || !projects.length) { el.innerHTML = ''; return; }
    el.innerHTML = projects
      .map((p) => `<div class="pj ${p.id === state.projectId ? 'active' : ''}" data-id="${p.id}">${esc(p.title)}</div>`)
      .join('');
    el.querySelectorAll('.pj').forEach((n) => n.addEventListener('click', () => openProject(n.dataset.id)));
  } catch { /* ignore */ }
}

async function openProject(id) {
  const { project, messages, building } = await fetch(`/api/projects/${id}`).then((r) => r.json());
  state.projectId = project.id;
  setProjectUrl();
  state.githubRepo = project.github_repo || null;
  state.githubUrl = project.github_url || null;
  $('#projectTitle').value = project.title;
  renderMessages(messages || []);
  await loadFiles();
  refreshPreview();
  loadProjects();
  if (building) startBuildWatch();
}

// If a build is still running server-side (e.g. you closed the tab mid-build),
// watch for it to finish and pull in the saved result.
let buildWatchTimer = null;
function startBuildWatch() {
  if (buildWatchTimer || !state.projectId) return;
  addBubble('ai', '<div class="meta">background build</div>⏳ This app is still building in the background — it’ll update here when done.');
  buildWatchTimer = setInterval(async () => {
    try {
      const { building } = await fetch(`/api/projects/${state.projectId}`).then((r) => r.json());
      if (!building) {
        clearInterval(buildWatchTimer); buildWatchTimer = null;
        await loadFiles(); refreshPreview();
        addBubble('ai', '<div class="meta">background build</div>✓ Background build finished and saved.');
      }
    } catch { /* keep watching */ }
  }, 4000);
}

// ---------- Files / editor ----------
async function loadFiles() {
  if (!state.projectId) { state.files = []; renderFileTree(); return; }
  try {
    const { files } = await fetch(`/api/projects/${state.projectId}/files`).then((r) => r.json());
    state.files = files || [];
  } catch { state.files = []; }
  if (!state.files.find((f) => f.path === state.activeFile)) state.activeFile = state.files[0]?.path || 'index.html';
  renderFileTree();
  showActiveFile();
}

function renderFileTree() {
  const el = $('#fileList');
  if (!el) return;
  el.innerHTML = (state.files || [])
    .map((f) => `<li class="${f.path === state.activeFile ? 'active' : ''}" data-path="${esc(f.path)}">${esc(f.path)}</li>`)
    .join('') || '<li style="cursor:default;color:#667">No files yet</li>';
  el.querySelectorAll('li[data-path]').forEach((li) => li.addEventListener('click', () => { state.activeFile = li.dataset.path; renderFileTree(); showActiveFile(); }));
}

function showActiveFile() {
  const f = (state.files || []).find((x) => x.path === state.activeFile);
  $('#codeEditor').value = f ? f.content : '';
  $('#activePath').textContent = f ? f.path : '';
}

// Keep the current app in the URL so reopening the tab resumes it.
function setProjectUrl() {
  if (state.projectId && location.search.indexOf('project=' + state.projectId) === -1) {
    try { history.replaceState(null, '', '/app?project=' + state.projectId); } catch { /* ignore */ }
  }
}

function refreshPreview() {
  const fr = $('#preview');
  if (state.projectId) fr.removeAttribute('srcdoc'), fr.src = `/p/${state.projectId}/index.html?t=${Date.now()}`;
  else {
    const idx = (state.files || []).find((f) => f.path === 'index.html');
    fr.src = 'about:blank';
    fr.srcdoc = idx ? idx.content : '<!doctype html><body style="font:15px system-ui;color:#888;padding:2rem">Your app preview will appear here.</body>';
  }
}

async function loadGithub() {
  try { state.github = await fetch('/api/github/status').then((r) => r.json()); } catch { /* ignore */ }
}

// ---------- Rendering ----------
function renderAuth() {
  const el = $('#authArea');
  // Open testing mode: no auth UI.
  if (!state.authEnabled) {
    el.innerHTML = `<span class="testing-chip" title="AUTH_ENABLED=false">Testing mode</span>`;
    $('#upgradeBtn').classList.add('hidden');
    return;
  }
  if (state.user) {
    el.innerHTML = `<div class="user-chip">
      ${state.user.avatar_url ? `<img class="avatar" src="${state.user.avatar_url}" alt="">` : ''}
      <button id="logoutBtn" class="btn ghost sm">Sign out</button></div>`;
    $('#logoutBtn').addEventListener('click', logout);
    $('#upgradeBtn').classList.toggle('hidden', state.user.plan === 'priority');
  } else {
    el.innerHTML = `<a class="btn primary sm" href="/login?redirect=/app">Sign in</a>`;
    $('#upgradeBtn').classList.remove('hidden');
  }
}

function renderBanner(s) {
  const b = $('#banner');
  if (!state.authEnabled) { b.classList.add('hidden'); return; } // no gating in testing mode
  if (s.highUsage && (!state.user || state.user.plan !== 'priority')) {
    b.className = 'banner warn';
    b.innerHTML = '⚡ <b>High Usage Time</b> — free generation is paused to keep Yield free to host. Priority members ($20/mo) keep full access. <a href="#" id="bannerUpgrade" style="text-decoration:underline">Upgrade →</a>';
    b.classList.remove('hidden');
    $('#bannerUpgrade')?.addEventListener('click', (e) => { e.preventDefault(); upgrade(); });
  } else if (s.highUsage && state.user?.plan === 'priority') {
    b.className = 'banner info';
    b.textContent = '⚡ High Usage Time — thanks for being a Priority member. You have full access.';
    b.classList.remove('hidden');
  } else {
    b.classList.add('hidden');
  }
}

function renderQuota(s) {
  const q = $('#quota');
  if (!state.authEnabled) { q.textContent = 'unlimited'; return; }
  if (state.user?.plan === 'priority') q.textContent = 'Priority · unlimited';
  else if (s.remainingToday != null) q.textContent = `${s.remainingToday} free builds left today`;
  else q.textContent = '';
}

function renderMessages(msgs) {
  const m = $('#messages');
  if (!msgs.length) return;
  m.innerHTML = msgs
    .map((x) => {
      if (x.flagged) return `<div class="msg user flagged">${esc(x.content)}<div class="meta">⚠ blocked by safety guard</div></div>`;
      if (x.role === 'user') return `<div class="msg user">${esc(x.content)}</div>`;
      return `<div class="msg ai"><div class="meta">${esc(x.model || 'assistant')}</div><div class="body">${fmt(x.content || '')}</div></div>`;
    })
    .join('');
  m.scrollTop = m.scrollHeight;
}

// Minimal safe text formatting for chat: escape, then bold + line breaks.
function fmt(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
}

function addBubble(cls, html) {
  const m = $('#messages');
  const empty = m.querySelector('.empty-chat');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.innerHTML = html;
  m.appendChild(div);
  m.scrollTop = m.scrollHeight;
  return div;
}

// ---------- Generation (SSE over fetch): chat + multi-file ----------
// Low-level: streams one prompt, returns whether files were produced.
async function streamPrompt(prompt, opts = {}) {
  state.streaming = true;
  addBubble('user', opts.label ? `<span class="muted">${esc(opts.label)}</span>` : esc(prompt));
  const aiBubble = addBubble('ai streaming', '<div class="meta">thinking…</div><div class="body"><span class="dots">▌</span></div>');
  const setMeta = (t) => { const el = aiBubble.querySelector('.meta'); if (el) el.textContent = t; };
  const setBody = (html) => { const el = aiBubble.querySelector('.body'); if (el) el.innerHTML = html; };
  let thinkAcc = '';
  const ensureThink = () => {
    let t = aiBubble.querySelector('.think');
    if (!t) {
      t = document.createElement('details');
      t.className = 'think';
      t.innerHTML = '<summary>💭 Thinking…</summary><div class="think-body"></div>';
      aiBubble.insertBefore(t, aiBubble.querySelector('.body'));
    }
    return t;
  };

  let chatAcc = '';
  let finished = false; // got a terminal event (done/error/blocked/gate)
  let hasFiles = false;

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, model: state.model, projectId: state.projectId }),
    });

    if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) {
      const err = await res.json().catch(() => ({}));
      setMeta('error'); setBody(esc(err.error || `Request failed (${res.status})`));
      return;
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /event: (.*)/.exec(frame)?.[1];
        const data = /data: ([\s\S]*)/.exec(frame)?.[1];
        if (!ev || data == null) continue;
        let payload; try { payload = JSON.parse(data); } catch { continue; }

        if (ev === 'thinking') {
          thinkAcc += payload;
          const tb = ensureThink().querySelector('.think-body');
          tb.textContent = thinkAcc;
          tb.scrollTop = tb.scrollHeight;
        } else if (ev === 'status') {
          setMeta(`${payload.stage}…`);
        } else if (ev === 'meta') {
          setMeta(`${payload.label}${payload.routeReason ? ` · ${payload.routeReason}` : ''}`);
          if (payload.projectId) { state.projectId = payload.projectId; setProjectUrl(); }
        } else if (ev === 'chat') {
          chatAcc += payload;
          setBody(fmt(chatAcc));
          $('#messages').scrollTop = $('#messages').scrollHeight;
        } else if (ev === 'done') {
          finished = true;
          if (payload.projectId) { state.projectId = payload.projectId; setProjectUrl(); }
          if (payload.chat) chatAcc = payload.chat;
          if (payload.hasCode && Array.isArray(payload.files) && payload.files.length) {
            hasFiles = true;
            state.files = payload.files;
            if (!state.files.find((f) => f.path === state.activeFile)) {
              state.activeFile = state.files.find((f) => f.path === 'index.html') ? 'index.html' : state.files[0].path;
            }
            renderFileTree(); showActiveFile();
          }
          state.pendingSecrets = Array.isArray(payload.secretsNeeded) ? payload.secretsNeeded : [];
          const agentNames = payload.agents ? Object.keys(payload.agents) : [];
          let extra = '';
          if (agentNames.length) extra += `<div class="meta">⚡ created agent(s): ${agentNames.map(esc).join(', ')}</div>`;
          setBody(fmt(chatAcc || (payload.hasCode ? 'Updated your app.' : 'Done.')) + extra);
          const ts = aiBubble.querySelector('.think summary'); if (ts) ts.textContent = '💭 Thinking';
        } else if (ev === 'blocked') {
          finished = true;
          aiBubble.classList.add('flagged');
          setMeta('⚠ blocked by NeMoGuard');
          setBody(esc(payload.message || 'Blocked.') + (payload.detail ? `<div class="meta">${esc(payload.detail)}</div>` : ''));
        } else if (ev === 'gate') {
          finished = true;
          let extra = '';
          if (payload.code === 'high_usage') extra = ' <a href="#" id="bu" style="text-decoration:underline">Upgrade</a>';
          else if (payload.code === 'login_required') extra = ' <a href="/login?redirect=/app" style="text-decoration:underline">Sign in</a>';
          setMeta('paused'); setBody(esc(payload.message || '') + extra);
          aiBubble.querySelector('#bu')?.addEventListener('click', (e) => { e.preventDefault(); upgrade(); });
        } else if (ev === 'error') {
          finished = true;
          setMeta('error'); setBody(esc(payload.message || 'Generation failed'));
        }
      }
    }

    if (!finished && !chatAcc) setBody(esc('No response — try again.'));
    aiBubble.classList.remove('streaming');
    loadStatus();
    if (state.user) loadProjects();
  } catch (e) {
    setMeta('error'); setBody(esc(String(e)));
  } finally {
    state.streaming = false;
  }
  return hasFiles;
}

// ---------- Orchestration: lock while working + queue + auto bug-fix ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function updateComposer() {
  const btn = $('#sendBtn');
  const prompt = $('#prompt');
  const composer = $('#composer');
  if (!btn) return;
  composer && composer.classList.toggle('busy', state.working);
  if (state.working) {
    const hasText = prompt && prompt.value.trim().length > 0;
    btn.innerHTML = hasText ? '＋ Schedule' : '<span class="spin"></span> Working…';
    btn.classList.toggle('working-btn', !hasText);
    btn.title = 'Yield is working — your message will be scheduled to run after this.';
    if (prompt) prompt.placeholder = 'Yield is working… your message will be scheduled.';
  } else {
    btn.innerHTML = 'Build ▸';
    btn.classList.remove('working-btn');
    btn.title = '';
    if (prompt) prompt.placeholder = 'Describe your app, or ask for a change…';
  }
}

function renderQueue() {
  const el = $('#queue');
  if (!el) return;
  if (!state.queue.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = `<div class="qhead">Scheduled (${state.queue.length}) — runs after the current build &amp; bug-check</div>` +
    state.queue.map((q, i) => `<div class="qitem"><span>${esc(q)}</span><button data-i="${i}" title="Remove">✕</button></div>`).join('');
  el.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => { state.queue.splice(+b.dataset.i, 1); renderQueue(); }));
}

async function startUserPrompt(text) {
  state.autofixCount = 0;
  await runCycle(text, {});
}

async function runCycle(text, opts) {
  state.working = true; updateComposer();
  const hasFiles = await streamPrompt(text, opts);
  if (state.pendingSecrets.length) await promptForSecrets();
  if (hasFiles) {
    const errors = await bugCheck();
    if (errors.length && state.autofixCount < MAX_AUTOFIX) {
      state.autofixCount++;
      const fixPrompt = 'The running app reported these runtime errors. Find the bug and return the full updated file(s) that fix it:\n' + errors.join('\n');
      await runCycle(fixPrompt, { label: `↻ Auto-fix ${state.autofixCount}/${MAX_AUTOFIX} — ${errors.length} runtime error(s)` });
      return;
    }
  }
  state.working = false; updateComposer();
  // Run the next scheduled prompt, if any.
  if (state.queue.length) {
    const next = state.queue.shift();
    renderQueue();
    startUserPrompt(next);
  }
}

// The AI asked for secrets — prompt the user, save them (encrypted), refresh.
async function promptForSecrets() {
  const needed = state.pendingSecrets; state.pendingSecrets = [];
  if (!state.projectId) return;
  for (const s of needed) {
    const val = window.prompt(`This app needs a secret:\n\n${s.name}${s.description ? '\n(' + s.description + ')' : ''}\n\nEnter the value (stored encrypted for this app):`);
    if (val) {
      await fetch(`/api/secrets?project=${state.projectId}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: s.name, value: val }),
      });
      addBubble('ai', `<div class="meta">secret saved</div>🔒 <b>${esc(s.name)}</b> saved &amp; available to this app.`);
    }
  }
  refreshPreview();
}

// Reload the preview and watch for runtime errors for a short window.
async function bugCheck() {
  if (!state.projectId) return [];
  state.previewErrors = [];
  $('#guardNote').innerHTML = '<span class="checking">Checking the app for runtime errors…</span>';
  refreshPreview();
  await sleep(3200);
  $('#guardNote').textContent = 'Prompts are screened by NVIDIA NeMoGuard.';
  // De-dupe; only hard errors (error/rejection) trigger an auto-fix.
  const seen = new Set();
  const hard = [];
  for (const e of state.previewErrors) {
    if (seen.has(e.message)) continue; seen.add(e.message);
    if (e.kind === 'error' || e.kind === 'rejection') hard.push(e.message);
  }
  return hard;
}

// ---------- Manual file editing ----------
async function saveFile() {
  if (!state.activeFile) return;
  const content = $('#codeEditor').value;
  const f = state.files.find((x) => x.path === state.activeFile);
  if (f) f.content = content; else state.files.push({ path: state.activeFile, content });
  if (state.projectId) {
    $('#saveState').textContent = 'Saving…';
    await fetch(`/api/projects/${state.projectId}/files`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: state.activeFile, content }),
    });
    $('#saveState').textContent = 'Saved ✓';
    setTimeout(() => ($('#saveState').textContent = ''), 1500);
  }
  refreshPreview();
}
async function newFile() {
  const path = prompt('New file path (e.g. styles.css, src/app.js):');
  const clean = (path || '').replace(/^\/+/, '').trim();
  if (!clean) return;
  if (!state.files.find((f) => f.path === clean)) state.files.push({ path: clean, content: '' });
  state.activeFile = clean; renderFileTree(); showActiveFile();
  if (state.projectId) await fetch(`/api/projects/${state.projectId}/files`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: clean, content: '' }),
  });
}
async function deleteActiveFile() {
  if (!state.activeFile || state.activeFile === 'index.html') { alert('index.html is the entry point and can\'t be deleted.'); return; }
  if (!confirm('Delete ' + state.activeFile + '?')) return;
  const path = state.activeFile;
  state.files = state.files.filter((f) => f.path !== path);
  state.activeFile = state.files[0]?.path || 'index.html';
  renderFileTree(); showActiveFile(); refreshPreview();
  if (state.projectId) await fetch(`/api/projects/${state.projectId}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
}

// ---------- Per-app Agents panel ----------
async function renderAgentsPane() {
  const el = $('#agentsPane');
  if (!state.projectId) { el.innerHTML = '<h3>Agents</h3><p class="sub">Build something first, then add AI agents tailored to this app.</p>'; return; }
  const models = state.models.filter((m) => m.id !== 'auto');
  const { agents } = await fetch(`/api/agents?project=${state.projectId}`).then((r) => r.json()).catch(() => ({ agents: [] }));
  el.innerHTML = `<h3>Agents for this app</h3>
    <p class="sub">AI helpers powered by your models. This app can call them at <span class="endpoint">/api/agents/&lt;id&gt;/run</span>.</p>
    <div>${(agents || []).map(agentCard).join('') || '<p class="sub">No agents yet.</p>'}</div>
    <div class="pane-card"><b>New agent</b>
      <div class="pane-form">
        <input id="agName" placeholder="Name (e.g. Recommender)" />
        <input id="agDesc" placeholder="Description (optional)" />
        <select id="agModel">${models.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join('')}</select>
        <textarea id="agPrompt" rows="4" placeholder="System prompt — how should it behave?"></textarea>
        <button class="btn primary sm" id="agCreate" style="justify-self:start">Create agent</button>
        <div id="agMsg" class="sub"></div>
      </div></div>`;
  $('#agCreate').onclick = createProjectAgent;
  el.querySelectorAll('[data-del-agent]').forEach((b) => (b.onclick = () => delProjectAgent(b.dataset.delAgent)));
  el.querySelectorAll('.copy').forEach((b) => (b.onclick = () => navigator.clipboard && navigator.clipboard.writeText(b.dataset.copy)));
}
function agentCard(a) {
  return `<div class="pane-card"><div class="row"><b>${esc(a.name)}</b>
    <span class="tier-badge">${esc(a.model)}</span>
    <button class="btn ghost sm" data-del-agent="${a.id}">Delete</button></div>
    <div class="sub" style="margin:.3rem 0 0">${esc(a.description || '')}</div>
    <div class="endpoint">/api/agents/${a.id}/run <span class="copy" data-copy="/api/agents/${a.id}/run">copy</span></div></div>`;
}
async function createProjectAgent() {
  const body = { name: $('#agName').value.trim(), description: $('#agDesc').value.trim(), model: $('#agModel').value, system_prompt: $('#agPrompt').value.trim() };
  if (!body.name || !body.system_prompt) { $('#agMsg').textContent = 'Name and system prompt required.'; return; }
  const r = await fetch(`/api/agents?project=${state.projectId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) { $('#agMsg').textContent = d.error || 'Failed'; return; }
  renderAgentsPane();
}
async function delProjectAgent(id) { if (!confirm('Delete agent?')) return; await fetch('/api/agents/' + id, { method: 'DELETE' }); renderAgentsPane(); }

// ---------- Per-app Settings panel ----------
async function renderSettingsPane() {
  const el = $('#settingsPane');
  if (!state.projectId) { el.innerHTML = '<h3>App settings</h3><p class="sub">Build something first to configure this app.</p>'; return; }
  const { secrets } = await fetch(`/api/secrets?project=${state.projectId}`).then((r) => r.json()).catch(() => ({ secrets: [] }));
  const proj = await fetch(`/api/projects/${state.projectId}`).then((r) => r.json()).then((d) => d.project).catch(() => ({ slug: state.projectId }));
  const share = location.origin + '/p/' + (proj.slug || state.projectId);
  el.innerHTML = `<h3>App settings</h3><p class="sub">Settings &amp; secrets tailored to this app.</p>
    <div class="pane-card"><b>Project</b>
      <div class="pane-form"><input id="setTitle" value="${esc($('#projectTitle').value)}" placeholder="App name" />
        <button class="btn ghost sm" id="setRename" style="justify-self:start">Rename</button></div></div>
    <div class="pane-card"><b>Share &amp; export</b>
      <div class="endpoint" style="margin:.4rem 0">${esc(share)} <span class="copy" data-copy="${esc(share)}">copy</span></div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <a class="btn ghost sm" href="/p/${esc(proj.slug || state.projectId)}/" target="_blank">Open app ↗</a>
        <a class="btn ghost sm" href="/api/projects/${state.projectId}/export">Download .zip</a>
      </div>
      <details style="margin-top:.6rem"><summary class="sub" style="cursor:pointer">Deploy to your own Cloudflare (free)</summary>
        <ol class="sub" style="margin:.5rem 0 0 1.1rem;line-height:1.7">
          <li>Connect this app to GitHub (below) so its code lives in a repo.</li>
          <li>Cloudflare → Workers &amp; Pages → Create → <b>Connect to Git</b> → pick the repo.</li>
          <li>If the build fails, copy the log and paste it to Yield in chat — it'll fix the code.</li>
          <li>Add a custom domain later from the Worker → Settings → Domains.</li>
        </ol>
      </details></div>
    <div class="pane-card"><b>GitHub</b><div class="sub" id="setGh" style="margin-top:.4rem">…</div></div>
    <div class="pane-card"><b>Secrets (this app)</b>
      <div class="sub">Encrypted at rest; for this app's agents / server use.</div>
      <div id="setSecrets" style="margin:.4rem 0">${(secrets || []).map((s) => `<div class="row" style="margin-top:.3rem">🔒 <b>${esc(s.name)}</b><button class="btn ghost sm" data-del-secret="${s.id}">Delete</button></div>`).join('') || '<div class="sub">None yet.</div>'}</div>
      <div class="pane-form" style="grid-template-columns:1fr 1fr auto"><input id="secName" placeholder="NAME" /><input id="secVal" type="password" placeholder="value" /><button class="btn primary sm" id="secAdd">Save</button></div>
      <div id="secMsg" class="sub"></div></div>
    <div class="pane-card"><b>Version history</b>
      <div class="sub">Each build is a commit in your repo — restore any version.</div>
      <div id="setVersions" style="margin-top:.4rem"><span class="sub">Loading…</span></div></div>`;
  $('#setRename').onclick = async () => { const t = $('#setTitle').value.trim(); if (t) { await fetch(`/api/projects/${state.projectId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: t }) }); $('#projectTitle').value = t; loadProjects(); } };
  $('#secAdd').onclick = async () => { const name = $('#secName').value.trim(), value = $('#secVal').value; const r = await fetch(`/api/secrets?project=${state.projectId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, value }) }); const d = await r.json(); if (!r.ok) { $('#secMsg').textContent = d.error || 'Failed'; return; } renderSettingsPane(); };
  el.querySelectorAll('[data-del-secret]').forEach((b) => (b.onclick = async () => { await fetch('/api/secrets/' + b.dataset.delSecret, { method: 'DELETE' }); renderSettingsPane(); }));
  el.querySelectorAll('.copy').forEach((b) => (b.onclick = () => navigator.clipboard && navigator.clipboard.writeText(b.dataset.copy)));
  const gh = await fetch('/api/github/status').then((r) => r.json()).catch(() => ({ connected: false }));
  $('#setGh').innerHTML = gh.connected
    ? `Connected as @${esc(gh.login)}. ${state.githubRepo ? `Repo: <a href="${state.githubUrl}" target="_blank" style="color:var(--brand-2)">${esc(state.githubRepo)}</a>` : '<button class="btn ghost sm" id="setGhPush">Save this app to a repo</button>'}`
    : `<a class="btn primary sm" href="${ghRedirect()}">Connect GitHub</a>`;
  const gp = $('#setGhPush'); if (gp) gp.onclick = openGithubDialog;
  populateVersions();
}

async function populateVersions() {
  const box = $('#setVersions'); if (!box) return;
  const res = await fetch(`/api/projects/${state.projectId}/versions`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { box.innerHTML = `<span class="sub">${esc(data.error || 'Connect GitHub to enable version history.')}</span>`; return; }
  const commits = data.commits || [];
  if (!commits.length) { box.innerHTML = '<span class="sub">No versions yet.</span>'; return; }
  box.innerHTML = commits.map((cm) => `<div class="row" style="margin-top:.35rem">
    <span style="flex:1;overflow:hidden;text-overflow:ellipsis"><span class="endpoint">${cm.sha.slice(0, 7)}</span> ${esc((cm.message || '').split('\n')[0]).slice(0, 64)}</span>
    <button class="btn ghost sm" data-restore="${cm.sha}">Restore</button></div>`).join('');
  box.querySelectorAll('[data-restore]').forEach((b) => (b.onclick = () => restoreVersion(b.dataset.restore)));
}
async function restoreVersion(sha) {
  if (!confirm('Restore the app to this version? Current files are overwritten, but a new commit is created so nothing is lost.')) return;
  const r = await fetch(`/api/projects/${state.projectId}/versions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha }) });
  const d = await r.json();
  if (!r.ok) { alert(d.error || 'Restore failed'); return; }
  await loadFiles(); refreshPreview();
  addBubble('ai', `<div class="meta">restored</div>↩ Restored to ${esc(sha.slice(0, 7))} (${d.restored} files).`);
}

// ---------- GitHub code storage ----------
function ghRedirect() {
  const back = state.projectId ? `/app?project=${state.projectId}` : '/app';
  return '/api/auth/github/login?store_token=1&scope=repo&redirect=' + encodeURIComponent(back);
}

async function openGithubDialog() {
  const dialog = $('#ghDialog');
  const body = $('#ghBody');

  if (!state.user) {
    body.innerHTML = `<h3>⎇ Store code on GitHub</h3>
      <p class="gh-sub">Sign in to connect GitHub and save your generated code to your own repos.</p>
      <a class="btn primary" href="/login?redirect=/app">Sign in</a>`;
    dialog.showModal(); return;
  }
  if (!state.github.connected) {
    body.innerHTML = `<h3>⎇ Connect GitHub</h3>
      <p class="gh-sub">Authorize Yield to create and push to repositories in your account. Your token is encrypted at rest and only used to sync your code.</p>
      <a class="btn primary" href="${ghRedirect()}">Connect GitHub →</a>`;
    dialog.showModal(); return;
  }
  if (!state.projectId) {
    body.innerHTML = `<h3>⎇ GitHub</h3><p class="gh-sub">Connected as <b>@${esc(state.github.login)}</b>. Generate or open a project first, then you can push it to a repo.</p>`;
    dialog.showModal(); return;
  }

  if (state.githubRepo) {
    body.innerHTML = `<h3>⎇ Synced to GitHub</h3>
      <p class="gh-sub">This project pushes to <b>${esc(state.githubRepo)}</b> automatically on every build and save.</p>
      <a class="btn ghost" href="${state.githubUrl}" target="_blank">Open repository ↗</a>
      <button class="btn primary" id="ghPush">Push current code now</button>
      <div class="gh-section"><button class="btn ghost" id="ghUnlink">Unlink this repo</button></div>
      <div id="ghMsg"></div>`;
    dialog.showModal();
    $('#ghPush').onclick = () => ghAction({ action: 'push' }, 'Pushed ✓');
    $('#ghUnlink').onclick = async () => { await ghAction({ action: 'unlink' }, 'Unlinked'); state.githubRepo = null; state.githubUrl = null; setTimeout(openGithubDialog, 400); };
    return;
  }

  // Connected, project exists, not yet linked: create or link.
  body.innerHTML = `<h3>⎇ Save this project to GitHub</h3>
    <p class="gh-sub">Connected as <b>@${esc(state.github.login)}</b>. Create a new repo or link an existing one — Yield keeps it in sync.</p>
    <div><b>Create a new repo</b>
      <input type="text" id="ghName" value="${esc(($('#projectTitle').value||'yield-app'))}" />
      <label class="row"><input type="checkbox" id="ghPrivate" /> Private repository</label>
      <button class="btn primary" id="ghCreate">Create &amp; push</button>
    </div>
    <div class="gh-section"><b>…or link an existing repo</b>
      <select id="ghRepoSel"><option value="">Loading your repos…</option></select>
      <button class="btn ghost" id="ghLink">Link &amp; push</button>
    </div>
    <div id="ghMsg"></div>`;
  dialog.showModal();

  // Populate existing repos.
  fetch('/api/github/repos').then((r) => r.json()).then(({ repos }) => {
    const sel = $('#ghRepoSel');
    sel.innerHTML = '<option value="">Select a repo…</option>' +
      (repos || []).map((r) => `<option value="${r.full_name}" data-branch="${r.default_branch}">${esc(r.full_name)}${r.private ? ' (private)' : ''}</option>`).join('');
  }).catch(() => {});

  $('#ghCreate').onclick = () => ghAction({ action: 'create', name: $('#ghName').value, private: $('#ghPrivate').checked }, 'Created & pushed ✓');
  $('#ghLink').onclick = () => {
    const opt = $('#ghRepoSel').selectedOptions[0];
    if (!opt || !opt.value) { $('#ghMsg').innerHTML = '<div class="gh-err">Pick a repo first.</div>'; return; }
    ghAction({ action: 'link', repo: opt.value, branch: opt.dataset.branch }, 'Linked & pushed ✓');
  };
}

async function ghAction(payload, okMsg) {
  const msg = $('#ghMsg');
  if (msg) msg.innerHTML = '<div class="gh-sub">Working…</div>';
  try {
    const res = await fetch(`/api/projects/${state.projectId}/github`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) { if (msg) msg.innerHTML = `<div class="gh-err">${esc(data.error || 'Failed')}</div>`; return; }
    if (data.github_repo) state.githubRepo = data.github_repo;
    if (data.github_url) state.githubUrl = data.github_url;
    if (msg) msg.innerHTML = `<div class="gh-ok">${okMsg}</div>`;
    loadProjects();
  } catch (e) {
    if (msg) msg.innerHTML = `<div class="gh-err">${esc(String(e))}</div>`;
  }
}

// ---------- Billing ----------
async function upgrade() {
  if (!state.user) { location.href = '/api/auth/github/login?redirect=/app?upgrade=1'; return; }
  const res = await fetch('/api/billing/checkout', { method: 'POST' });
  const data = await res.json();
  if (data.url) location.href = data.url;
  else alert(data.error || 'Could not start checkout.');
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
}

// ---------- Events ----------
function wireEvents() {
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#prompt').value.trim();
    if (!v) return;
    $('#prompt').value = '';
    $('#autoPick').textContent = '';
    if (state.working) { state.queue.push(v); renderQueue(); updateComposer(); }  // busy -> schedule it
    else startUserPrompt(v);
  });
  // Enter sends; Shift+Enter makes a new line.
  $('#prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  $('#prompt').addEventListener('input', () => { maybeRecommend(); if (state.working) updateComposer(); });
  // Collect runtime errors reported by the preview iframe (for the bug-checker).
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || !d.__yield || d.kind === 'ready') return;
    const fr = $('#preview');
    if (fr && e.source !== fr.contentWindow) return;
    state.previewErrors.push({ kind: d.kind, message: String(d.message || '').slice(0, 400) });
  });

  // Mini AI selector open/close.
  $('#modelBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#modelPanel').classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.model-mini')) $('#modelPanel').classList.add('hidden');
  });
  $('#newBtn').addEventListener('click', () => {
    state.projectId = null; state.files = []; state.activeFile = 'index.html'; $('#codeEditor').value = '';
    $('#projectTitle').value = 'Untitled app';
    $('#messages').innerHTML = '<div class="empty-chat"><h2>What do you want to build?</h2><p>Describe an app and Yield will generate it.</p></div>';
    renderFileTree(); refreshPreview(); loadProjects();
  });
  $('#applyCode').addEventListener('click', saveFile);
  $('#newFileBtn').addEventListener('click', newFile);
  $('#deleteFileBtn').addEventListener('click', deleteActiveFile);
  $('#refreshBtn').addEventListener('click', refreshPreview);
  $('#openBtn').addEventListener('click', () => {
    if (state.projectId) window.open(`/p/${state.projectId}/index.html`, '_blank');
  });
  $('#upgradeBtn').addEventListener('click', upgrade);
  $('#ghBtn').addEventListener('click', openGithubDialog);
  $('#projectTitle').addEventListener('change', async () => {
    if (state.user && state.projectId)
      await fetch(`/api/projects/${state.projectId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: $('#projectTitle').value }) });
  });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    const tab = t.dataset.tab;
    ['preview', 'code', 'agents', 'settings'].forEach((n) => $('#' + n + 'Tab').classList.toggle('hidden', tab !== n));
    if (tab === 'agents') renderAgentsPane();
    if (tab === 'settings') renderSettingsPane();
  }));
}

function handleQueryFlags() {
  const p = new URLSearchParams(location.search);
  if (p.get('upgraded') === '1') { setTimeout(() => loadStatus(), 800); }
  if (p.get('upgrade') === '1' && state.user) upgrade();
}

// ---------- utils ----------
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
