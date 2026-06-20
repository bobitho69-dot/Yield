// Yield builder — client logic.
const $ = (s) => document.querySelector(s);
const state = { user: null, authEnabled: true, providers: {}, models: [], model: 'auto', recommended: null, projectId: null, code: '', streaming: false, dirty: false,
  github: { connected: false, login: null }, githubRepo: null, githubUrl: null };

// ---------- Boot ----------
init();
async function init() {
  await Promise.all([loadStatus(), loadModels()]);
  if (state.user) await Promise.all([loadProjects(), loadGithub()]);
  wireEvents();
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
  const { project, messages } = await fetch(`/api/projects/${id}`).then((r) => r.json());
  state.projectId = project.id;
  state.code = project.code || '';
  state.githubRepo = project.github_repo || null;
  state.githubUrl = project.github_url || null;
  $('#projectTitle').value = project.title;
  $('#codeEditor').value = state.code;
  renderMessages(messages || []);
  updatePreview(state.code);
  loadProjects();
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
      return `<div class="msg ai"><div class="meta">${x.model || 'assistant'}</div>✓ app generated</div>`;
    })
    .join('');
  m.scrollTop = m.scrollHeight;
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

// ---------- Generation (SSE over fetch) ----------
async function send(prompt) {
  if (state.streaming) return;
  state.streaming = true;
  $('#sendBtn').disabled = true;
  addBubble('user', esc(prompt));
  const aiBubble = addBubble('ai streaming', '<div class="meta">thinking…</div><span class="dots">▌</span>');

  let acc = '';
  let lastPaint = 0;
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, model: state.model, projectId: state.projectId }),
    });

    if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) {
      const err = await res.json().catch(() => ({}));
      handleGenError(res.status, err, aiBubble);
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
        const payload = JSON.parse(data);

        if (ev === 'meta') {
          aiBubble.querySelector('.meta').textContent =
            `${payload.label}${payload.routeReason ? ` · ${payload.routeReason}` : ''}`;
          if (payload.projectId) { state.projectId = payload.projectId; }
        } else if (ev === 'delta') {
          acc += payload;
          const nowT = performance.now();
          if (nowT - lastPaint > 250) { livePreview(acc); lastPaint = nowT; }
        } else if (ev === 'done') {
          acc = payload.code || acc;
          if (payload.projectId) state.projectId = payload.projectId;
        } else if (ev === 'error') {
          aiBubble.innerHTML = `<div class="meta">error</div>${esc(payload.message || 'Generation failed')}`;
        }
      }
    }

    // Finalize.
    state.code = acc;
    $('#codeEditor').value = acc;
    updatePreview(acc);
    aiBubble.classList.remove('streaming');
    aiBubble.innerHTML = `<div class="meta">${aiBubble.querySelector('.meta')?.textContent || 'done'}</div>✓ app generated`;
    loadStatus();
    if (state.user) loadProjects();
  } catch (e) {
    aiBubble.innerHTML = `<div class="meta">error</div>${esc(String(e))}`;
  } finally {
    state.streaming = false;
    $('#sendBtn').disabled = false;
  }
}

function handleGenError(status, err, bubble) {
  let msg = err.error || 'Something went wrong.';
  bubble.classList.remove('streaming');
  if (err.code === 'jailbreak_blocked') {
    bubble.className = 'msg user flagged';
    bubble.innerHTML = `${esc(msg)}<div class="meta">⚠ ${esc(err.detail || 'blocked by NeMoGuard')}</div>`;
  } else if (err.code === 'high_usage') {
    bubble.innerHTML = `<div class="meta">High Usage Time</div>${esc(msg)} <a href="#" id="bu" style="text-decoration:underline">Upgrade</a>`;
    bubble.querySelector('#bu')?.addEventListener('click', (e) => { e.preventDefault(); upgrade(); });
  } else if (err.code === 'login_required') {
    bubble.innerHTML = `<div class="meta">Sign in</div>${esc(msg)} <a href="/login?redirect=/app" style="text-decoration:underline">Sign in</a>`;
  } else {
    bubble.innerHTML = `<div class="meta">error</div>${esc(msg)}`;
  }
}

// ---------- Preview ----------
function livePreview(html) { $('#preview').srcdoc = html; }
function updatePreview(html) { $('#preview').srcdoc = html || '<!doctype html><body style="font:15px system-ui;color:#888;padding:2rem">Your app preview will appear here.</body>'; }

// ---------- Manual code editing ----------
async function applyCode() {
  const code = $('#codeEditor').value;
  state.code = code;
  updatePreview(code);
  if (state.user && state.projectId) {
    $('#saveState').textContent = 'Saving…';
    await fetch(`/api/projects/${state.projectId}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
    });
    $('#saveState').textContent = 'Saved ✓';
    setTimeout(() => ($('#saveState').textContent = ''), 1500);
  }
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
    if (v) {
      send(v);
      $('#prompt').value = '';
      $('#autoPick').textContent = '';
    }
  });
  $('#prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  $('#prompt').addEventListener('input', maybeRecommend);

  // Mini AI selector open/close.
  $('#modelBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#modelPanel').classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.model-mini')) $('#modelPanel').classList.add('hidden');
  });
  $('#newBtn').addEventListener('click', () => {
    state.projectId = null; state.code = ''; $('#codeEditor').value = '';
    $('#projectTitle').value = 'Untitled app';
    $('#messages').innerHTML = '<div class="empty-chat"><h2>What do you want to build?</h2><p>Describe an app and Yield will generate it.</p></div>';
    updatePreview(''); loadProjects();
  });
  $('#applyCode').addEventListener('click', applyCode);
  $('#refreshBtn').addEventListener('click', () => updatePreview($('#codeEditor').value || state.code));
  $('#openBtn').addEventListener('click', () => {
    const w = window.open('', '_blank');
    if (w) { w.document.write(state.code || '<p>Nothing to preview yet.</p>'); w.document.close(); }
  });
  $('#upgradeBtn').addEventListener('click', upgrade);
  $('#ghBtn').addEventListener('click', openGithubDialog);
  $('#projectTitle').addEventListener('change', async () => {
    if (state.user && state.projectId)
      await fetch(`/api/projects/${state.projectId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: $('#projectTitle').value }) });
  });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    const tab = t.dataset.tab;
    $('#previewTab').classList.toggle('hidden', tab !== 'preview');
    $('#codeTab').classList.toggle('hidden', tab !== 'code');
  }));
}

function handleQueryFlags() {
  const p = new URLSearchParams(location.search);
  if (p.get('upgraded') === '1') { setTimeout(() => loadStatus(), 800); }
  if (p.get('upgrade') === '1' && state.user) upgrade();
}

// ---------- utils ----------
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
