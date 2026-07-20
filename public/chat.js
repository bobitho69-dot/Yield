/* Yield Chat — a plain conversational assistant over /api/chat (SSE).
   No build step; vanilla JS. Conversations persist in localStorage. */
(() => {
  'use strict';

  // ---- Safe markdown → HTML (escape first, then format) ----------------------
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function inline(s) {
    // s is already HTML-escaped. Apply inline formatting.
    return s
      .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\b(https?:\/\/[^\s<)]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }
  function mdToHtml(src) {
    const lines = (src || '').replace(/\r\n/g, '\n').split('\n');
    let html = '', i = 0;
    let listType = null;
    const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
    while (i < lines.length) {
      let line = lines[i];
      // Fenced code block
      const fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        closeList();
        const code = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
        i++; // skip closing fence
        html += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
        continue;
      }
      const raw = esc(line);
      // Headings
      let m;
      if ((m = raw.match(/^(#{1,3})\s+(.*)$/))) { closeList(); html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; i++; continue; }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { closeList(); html += '<hr>'; i++; continue; }
      if ((m = raw.match(/^&gt;\s?(.*)$/))) { closeList(); html += `<blockquote>${inline(m[1])}</blockquote>`; i++; continue; }
      // Lists
      if ((m = raw.match(/^\s*[-*+]\s+(.*)$/))) { if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; } html += `<li>${inline(m[1])}</li>`; i++; continue; }
      if ((m = raw.match(/^\s*\d+[.)]\s+(.*)$/))) { if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; } html += `<li>${inline(m[1])}</li>`; i++; continue; }
      // Blank line
      if (!line.trim()) { closeList(); i++; continue; }
      // Paragraph (gather consecutive non-empty, non-special lines)
      closeList();
      const para = [raw];
      i++;
      while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^(#{1,3})\s/.test(lines[i]) && !/^\s*[-*+]\s/.test(lines[i]) && !/^\s*\d+[.)]\s/.test(lines[i]) && !/^\s*&gt;/.test(esc(lines[i]))) {
        para.push(esc(lines[i])); i++;
      }
      html += `<p>${inline(para.join('<br>'))}</p>`;
    }
    closeList();
    return html;
  }

  // ---- State + persistence ---------------------------------------------------
  const LS = 'yield.chat.v1';
  const store = {
    read() { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } },
    write(v) { try { localStorage.setItem(LS, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  let db = store.read();
  if (!db.convos) db = { convos: [], activeId: null };
  let model = 'auto';
  let models = [{ id: 'auto', label: 'Auto', blurb: 'Reads your message and picks the best model.', tier: 'flash' }];
  let streaming = false;
  let abort = null;

  const $ = (id) => document.getElementById(id);
  const inner = $('ccInner'), empty = $('ccEmpty'), thread = $('ccThread');
  const input = $('ccInput'), sendBtn = $('ccSend'), stopBtn = $('ccStop');

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())).slice(0, 12);
  function activeConvo() { return db.convos.find((c) => c.id === db.activeId) || null; }
  function save() { store.write(db); }

  // ---- Rendering -------------------------------------------------------------
  function renderConvoList() {
    const el = $('ccConvos');
    el.innerHTML = '';
    if (!db.convos.length) { el.innerHTML = '<div style="color:var(--faint);font-size:.8rem;padding:.6rem">No conversations yet.</div>'; return; }
    for (const c of db.convos) {
      const row = document.createElement('div');
      row.className = 'cc-convo' + (c.id === db.activeId ? ' active' : '');
      const t = document.createElement('span'); t.className = 't'; t.textContent = c.title || 'New chat';
      const x = document.createElement('span'); x.className = 'x'; x.textContent = '×'; x.title = 'Delete';
      row.appendChild(t); row.appendChild(x);
      row.addEventListener('click', (e) => { if (e.target === x) return; openConvo(c.id); });
      x.addEventListener('click', (e) => { e.stopPropagation(); deleteConvo(c.id); });
      el.appendChild(row);
    }
  }
  function bubble(role, htmlBody, model) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (role === 'user' ? 'user' : 'ai');
    const av = document.createElement('div'); av.className = 'av'; av.textContent = role === 'user' ? 'You' : '◆';
    const body = document.createElement('div'); body.className = 'body';
    const who = document.createElement('div'); who.className = 'who';
    who.innerHTML = role === 'user' ? 'You' : `Yield${model ? ` · <span class="mdl">${esc(model)}</span>` : ''}`;
    const prose = document.createElement('div'); prose.className = 'prose'; prose.innerHTML = htmlBody;
    body.appendChild(who); body.appendChild(prose);
    wrap.appendChild(av); wrap.appendChild(body);
    return { wrap, prose, who };
  }
  function renderThread() {
    const c = activeConvo();
    inner.innerHTML = '';
    if (!c || !c.messages.length) { empty.classList.remove('hidden'); inner.classList.add('hidden'); return; }
    empty.classList.add('hidden'); inner.classList.remove('hidden');
    for (const m of c.messages) {
      const b = bubble(m.role, m.role === 'user' ? `<p>${inline(esc(m.content)).replace(/\n/g, '<br>')}</p>` : mdToHtml(m.content), m.model);
      inner.appendChild(b.wrap);
    }
    scrollDown();
  }
  function scrollDown() { thread.scrollTop = thread.scrollHeight; }

  // ---- Conversation ops ------------------------------------------------------
  function newConvo() {
    const c = { id: uid(), title: 'New chat', messages: [], created: Date.now() };
    db.convos.unshift(c); db.activeId = c.id; save();
    renderConvoList(); renderThread(); input.focus();
  }
  function openConvo(id) { db.activeId = id; save(); renderConvoList(); renderThread(); closeSide(); }
  function deleteConvo(id) {
    db.convos = db.convos.filter((c) => c.id !== id);
    if (db.activeId === id) db.activeId = db.convos[0] ? db.convos[0].id : null;
    save(); renderConvoList(); renderThread();
  }

  // ---- Model picker ----------------------------------------------------------
  async function loadModels() {
    try {
      const r = await fetch('/api/models'); const j = await r.json();
      if (j && Array.isArray(j.models)) models = [models[0], ...j.models];
    } catch { /* keep default */ }
    renderModelPanel();
  }
  function renderModelPanel() {
    const panel = $('ccModelPanel'); panel.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('div');
      opt.className = 'model-opt' + (m.id === model ? ' on' : '');
      opt.innerHTML = `<div class="mo-top"><span class="mo-name">${esc(m.label)}</span><span class="mo-tier">${esc(m.tier || '')}</span></div><div class="mo-blurb">${esc(m.blurb || '')}</div>`;
      opt.addEventListener('click', () => {
        model = m.id; $('ccModelLabel').textContent = m.label;
        $('ccModelNote').textContent = m.id === 'auto' ? 'Auto · picks the best model per message' : m.label;
        panel.classList.add('hidden'); renderModelPanel();
      });
      panel.appendChild(opt);
    }
  }

  // ---- Streaming send --------------------------------------------------------
  async function send(text) {
    const c = activeConvo(); if (!c || streaming) return;
    c.messages.push({ role: 'user', content: text });
    if (c.title === 'New chat') c.title = text.slice(0, 40);
    save(); renderConvoList();
    empty.classList.add('hidden'); inner.classList.remove('hidden');
    inner.appendChild(bubble('user', `<p>${inline(esc(text)).replace(/\n/g, '<br>')}</p>`).wrap);

    // AI bubble (streamed into)
    const ai = bubble('ai', '<span class="cursor-blink"></span>', null);
    inner.appendChild(ai.wrap); scrollDown();
    let think = null, thinkText = '', answer = '', chosenModel = null;

    setStreaming(true);
    abort = new AbortController();
    try {
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: abort.signal,
        body: JSON.stringify({ messages: c.messages.map((m) => ({ role: m.role, content: m.content })), model, thinking: $('ccThink').value }),
      });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      await readSSE(res.body, (event, data) => {
        if (event === 'meta') {
          chosenModel = data.label || data.model;
          ai.who.innerHTML = `Yield · <span class="mdl">${esc(chosenModel)}</span>`;
        } else if (event === 'thinking') {
          thinkText += data;
          if (!think) {
            think = document.createElement('details'); think.className = 'think';
            think.innerHTML = '<summary><span class="dot"></span> Thinking…</summary><div class="tc"></div>';
            ai.prose.parentNode.insertBefore(think, ai.prose);
          }
          think.querySelector('.tc').textContent = thinkText; scrollDown();
        } else if (event === 'chat') {
          answer += data;
          ai.prose.innerHTML = mdToHtml(answer) + '<span class="cursor-blink"></span>';
          scrollDown();
        } else if (event === 'blocked') {
          answer = data.message || 'This message was blocked by the safety guard.';
          ai.prose.innerHTML = mdToHtml(answer);
        } else if (event === 'error') {
          answer = answer || (data.message || 'Something went wrong. Please try again.');
          ai.prose.innerHTML = mdToHtml(answer);
        } else if (event === 'done') {
          chosenModel = data.label || chosenModel;
        }
      });
    } catch (e) {
      if (!answer) { answer = abort && abort.signal.aborted ? '■ Stopped.' : 'Connection error — please try again.'; }
    }
    ai.prose.innerHTML = mdToHtml(answer) || '<p style="color:var(--faint)">(no response)</p>';
    if (think) think.querySelector('summary').innerHTML = '<span class="dot"></span> Thought process';
    c.messages.push({ role: 'assistant', content: answer, model: chosenModel });
    save();
    setStreaming(false); abort = null;
  }

  // Parse an SSE stream (event:/data: lines) from a fetch body.
  async function readSSE(body, onEvent) {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let ev = 'message', dataLines = [];
        for (const l of chunk.split('\n')) {
          if (l.startsWith('event:')) ev = l.slice(6).trim();
          else if (l.startsWith('data:')) dataLines.push(l.slice(5).replace(/^ /, ''));
        }
        if (!dataLines.length) continue;
        const raw = dataLines.join('\n');
        let data; try { data = JSON.parse(raw); } catch { data = raw; }
        onEvent(ev, data);
      }
    }
  }

  function setStreaming(on) {
    streaming = on;
    stopBtn.classList.toggle('hidden', !on);
    sendBtn.classList.toggle('hidden', on);
    input.disabled = false;
  }

  // ---- Wire up ---------------------------------------------------------------
  function autoGrow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; sendBtn.disabled = !input.value.trim(); }
  function submit(e) {
    if (e) e.preventDefault();
    const text = input.value.trim(); if (!text || streaming) return;
    if (!activeConvo()) newConvo();
    input.value = ''; autoGrow();
    send(text);
  }
  function closeSide() { $('ccSide').classList.remove('open'); $('ccScrim').classList.add('hidden'); }

  const SUGGEST = [
    { t: 'Explain a concept', p: 'Explain how JWT authentication works, with a simple example.' },
    { t: 'Debug my code', p: 'Why might a React useEffect run twice, and how do I fix it?' },
    { t: 'Brainstorm', p: 'Give me 5 app ideas a solo developer could build in a weekend.' },
    { t: 'Write something', p: 'Write a friendly launch tweet for a free AI coding tool called Yield.' },
  ];
  function renderSuggest() {
    const el = $('ccSuggest'); el.innerHTML = '';
    for (const s of SUGGEST) {
      const b = document.createElement('button'); b.className = 'cc-chip';
      b.innerHTML = `<b>${esc(s.t)}</b><span>${esc(s.p)}</span>`;
      b.addEventListener('click', () => { if (!activeConvo()) newConvo(); input.value = s.p; autoGrow(); submit(); });
      el.appendChild(b);
    }
  }

  $('ccForm').addEventListener('submit', submit);
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
  $('ccNew').addEventListener('click', newConvo);
  stopBtn.addEventListener('click', () => { if (abort) abort.abort(); });
  $('ccModelBtn').addEventListener('click', () => $('ccModelPanel').classList.toggle('hidden'));
  document.addEventListener('click', (e) => { if (!e.target.closest('.cc-model')) $('ccModelPanel').classList.add('hidden'); });
  $('ccMenu').addEventListener('click', () => { $('ccSide').classList.add('open'); $('ccScrim').classList.remove('hidden'); });
  $('ccScrim').addEventListener('click', closeSide);

  // Init
  if (!db.convos.length) newConvo(); else if (!db.activeId) db.activeId = db.convos[0].id;
  renderConvoList(); renderThread(); renderSuggest(); loadModels(); autoGrow();
})();
