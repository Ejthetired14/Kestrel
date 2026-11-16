// Renderer: paints state, streams events into the transcript, and drives IPC.
import { diffLines } from './diff.js';

const api = window.kestrel;
const $ = (id) => document.getElementById(id);

let S = null;
let streaming = false;
let assistant = null; // { body, root }
const toolCards = new Map();
const modelsByProvider = new Map();
let permissionResolver = null;

const esc = (s) => String(s ?? '');
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/* ---------------- boot ---------------- */

async function init() {
  S = await api.state();
  if (!S.session) S = await api.session.create({ title: 'New session' });
  $('app-version').textContent = 'v' + S.app.version;
  $('cwd').textContent = S.session.cwd;
  renderSessions();
  renderKeySummary();
  renderProviders();
  await loadModels();
  renderTranscript();
  renderChanges();
  renderTerminal();
  renderUsage();
  $('mode').value = S.mode || 'default';
  $('session-title').textContent = S.session.title;
  $('status-mode').textContent = 'mode ' + (S.mode || 'default');
  wire();
  window.__kestrel = {
    ready: true,
    transcript: () => $('transcript').innerText,
    streaming: () => streaming,
    sessionId: () => S.session.id,
    counts: () => ({ changes: S.session.edits.length, terminal: S.session.terminal.length }),
  };
  document.documentElement.dataset.ready = '1';
}

/* ---------------- sidebar ---------------- */

function renderSessions(filter = '') {
  const box = $('session-list');
  box.replaceChildren();
  const items = S.sessions.filter((s) => (s.title || '').toLowerCase().includes(filter.toLowerCase()));
  if (!items.length) box.append(el('div', 'empty', 'No sessions'));
  for (const s of items) {
    const row = el('div', 'session-item' + (S.session && s.id === S.session.id ? ' active' : ''));
    row.append(el('div', 't', s.title || 'Untitled'));
    row.append(el('div', 'm', `${s.provider}/${s.model} · ${s.messages} msg`));
    row.onclick = async () => {
      S = await api.session.open(s.id);
      assistant = null;
      toolCards.clear();
      renderAll();
    };
    box.append(row);
  }
}

function renderKeySummary() {
  const present = S.keys.filter((k) => k.present && k.provider !== 'pretend');
  $('key-summary').textContent = present.length ? present.map((k) => k.provider).join(', ') : 'no keys';
}

/* ---------------- header ---------------- */

function renderProviders() {
  const sel = $('provider');
  sel.replaceChildren();
  for (const p of S.providers) {
    const o = el('option', null, p.label);
    o.value = p.id;
    sel.append(o);
  }
  sel.value = S.session.provider || 'pretend';
  sel.onchange = async () => {
    const provider = sel.value;
    const models = await loadModelsFor(provider);
    const model = models[0] ? models[0].id : '';
    S = await api.session.setModel(provider, model);
    renderModels();
  };
}

async function loadModelsFor(provider) {
  if (modelsByProvider.has(provider)) return modelsByProvider.get(provider);
  try {
    const list = await api.models.list(provider);
    modelsByProvider.set(provider, list);
    return list;
  } catch {
    modelsByProvider.set(provider, []);
    return [];
  }
}

async function loadModels() {
  await loadModelsFor(S.session.provider || 'pretend');
  renderModels();
}

function renderModels() {
  const sel = $('model');
  sel.replaceChildren();
  const list = modelsByProvider.get(S.session.provider) || [];
  if (!list.length) {
    const o = el('option', null, S.session.provider === 'pretend' ? 'pretend-1' : 'add a key →');
    o.value = S.session.model || '';
    sel.append(o);
  }
  for (const m of list) {
    const o = el('option', null, m.label + (m.context ? ` · ${Math.round(m.context / 1000)}k` : ''));
    o.value = m.id;
    sel.append(o);
  }
  if (S.session.model) sel.value = S.session.model;
  sel.onchange = async () => {
    S = await api.session.setModel(S.session.provider, sel.value);
  };
}

function renderUsage() {
  const u = S.session.usage || { input: 0, output: 0 };
  $('usage').textContent = `${u.input} in / ${u.output} out`;
  $('status-tokens').textContent = `tokens ${u.input + u.output}`;
}

/* ---------------- transcript ---------------- */

function renderAll() {
  $('session-title').textContent = S.session.title;
  $('cwd').textContent = S.session.cwd;
  $('mode').value = S.mode || 'default';
  renderSessions($('session-search').value);
  renderProviders();
  renderModels();
  renderTranscript();
  renderChanges();
  renderTerminal();
  renderUsage();
  renderKeySummary();
}

function renderTranscript() {
  const box = $('transcript');
  box.replaceChildren();
  assistant = null;
  toolCards.clear();
  for (const m of S.session.messages) {
    if (m.role === 'user' && isCompacted(m.content)) appendNotice(compactedText(m.content));
    else if (m.role === 'user') addUser(m.content);
    else if (m.role === 'assistant') {
      const a = startAssistant(false);
      if (m.content) a.body.textContent = m.content;
      for (const c of m.toolCalls || []) addToolCard({ id: c.id, name: c.name }, c.input);
    } else if (m.role === 'tool') {
      for (const r of m.results || []) finishToolCard({ id: r.id, name: r.name, output: r.output, isError: r.isError });
    }
  }
  assistant = null;
  scrollDown();
}

function addUser(text) {
  const wrap = el('div', 'msg user');
  const bubble = el('div', 'bubble' + (text.startsWith('/') ? ' cmd' : ''), text);
  wrap.append(bubble);
  $('transcript').append(wrap);
  scrollDown();
}

const isCompacted = (text) => typeof text === 'string' && text.startsWith('<compacted-context>');
const compactedText = (text) =>
  'Context compacted\n' + text.replace(/^<compacted-context>/, '').replace(/<\/compacted-context>$/, '').trim();

function startAssistant(withCursor = true) {
  const root = el('div', 'msg assistant');
  root.append(el('div', 'name', 'Kestrel'));
  const body = el('div', 'body' + (withCursor ? ' cursor' : ''));
  root.append(body);
  $('transcript').append(root);
  assistant = { root, body };
  scrollDown();
  return assistant;
}

function addToolCard(call, input) {
  if (toolCards.has(call.id)) return toolCards.get(call.id);
  const card = el('div', 'tool');
  const head = el('div', 'tool-head');
  head.append(el('span', 'tool-name', call.name));
  head.append(el('span', 'tool-target', targetOf(input)));
  const status = el('span', 'tool-status running', 'running');
  head.append(status);
  const body = el('div', 'tool-body', JSON.stringify(input || {}, null, 2));
  card.append(head, body);
  head.onclick = () => body.classList.toggle('closed');
  (assistant ? assistant.root : $('transcript')).append(card);
  const rec = { card, status, body };
  toolCards.set(call.id, rec);
  scrollDown();
  return rec;
}

function targetOf(input) {
  if (!input) return '';
  return input.path || input.pattern || input.command || input.url || input.query || '';
}

function finishToolCard(res) {
  let rec = toolCards.get(res.id);
  if (!rec) rec = addToolCard({ id: res.id, name: res.name }, {});
  rec.status.className = 'tool-status ' + (res.isError ? 'err' : 'ok');
  rec.status.textContent = res.isError ? 'error' : 'done';
  rec.body.textContent = String(res.output || '').slice(0, 4000);
}

function appendNotice(text) {
  $('transcript').append(el('div', 'notice', text));
  scrollDown();
}

function appendError(message) {
  const wrap = el('div', 'msg error');
  wrap.append(el('div', 'name dim small', 'Error'));
  wrap.append(el('div', 'body', message));
  $('transcript').append(wrap);
  scrollDown();
}

function scrollDown() {
  const t = $('transcript');
  t.scrollTop = t.scrollHeight;
}

/* ---------------- panels ---------------- */

function renderChanges() {
  const box = $('tab-changes');
  box.replaceChildren();
  const edits = S.session.edits || [];
  $('change-count').textContent = String(edits.length);
  if (!edits.length) box.append(el('div', 'empty', 'No file changes yet.'));
  for (const e of [...edits].reverse()) {
    const card = el('div', 'change');
    const head = el('div', 'change-head');
    head.append(el('span', null, e.path));
    head.append(el('span', 'k', e.kind));
    const diff = el('div', 'diff');
    for (const line of diffLines(e.before, e.after)) {
      const row = el('div', line.type === 'add' ? 'add' : line.type === 'del' ? 'del' : 'ctx', line.text);
      diff.append(row);
    }
    card.append(head, diff);
    box.append(card);
  }
}

function renderTerminal() {
  const box = $('tab-terminal');
  box.replaceChildren();
  const terms = S.session.terminal || [];
  $('term-count').textContent = String(terms.length);
  if (!terms.length) box.append(el('div', 'empty', 'No commands run yet.'));
  for (const t of [...terms].reverse()) {
    const wrap = el('div', 'term');
    wrap.append(el('div', 'cmd', '$ ' + t.command));
    wrap.append(el('div', 'out', String(t.output || '').slice(0, 3000)));
    if (t.code != null) wrap.append(el('div', 'code', 'exit ' + t.code));
    box.append(wrap);
  }
}

/* ---------------- events ---------------- */

function setStreaming(on) {
  streaming = on;
  $('status-state').textContent = on ? 'working' : 'idle';
  $('send').disabled = on;
  $('stop').classList.toggle('hidden', !on);
  if (!on && assistant) assistant.body.classList.remove('cursor');
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'turn_start':
      setStreaming(true);
      break;
    case 'text': {
      if (!assistant) startAssistant();
      assistant.body.textContent += ev.text;
      scrollDown();
      break;
    }
    case 'tool_start':
      addToolCard(ev, ev.input);
      break;
    case 'tool_result':
      finishToolCard(ev);
      break;
    case 'edit':
      S.session.edits.push(ev.edit);
      renderChanges();
      break;
    case 'terminal':
      S.session.terminal.push(ev.entry);
      renderTerminal();
      break;
    case 'usage':
      S.session.usage = ev.usage;
      renderUsage();
      break;
    case 'assistant_message':
      if (assistant) assistant.body.classList.remove('cursor');
      assistant = null;
      break;
    case 'error':
      appendError(ev.message);
      break;
    case 'turn_end':
      setStreaming(false);
      assistant = null;
      break;
    case 'notice':
      appendNotice(ev.text);
      break;
    case 'mode':
      S.mode = ev.mode;
      S.session.mode = ev.mode;
      $('mode').value = ev.mode;
      $('status-mode').textContent = 'mode ' + ev.mode;
      break;
    case 'model':
      S.session.model = ev.model;
      $('model').value = ev.model;
      break;
    case 'session':
      S.session = ev.session;
      renderAll();
      break;
    case 'title':
      S.session.title = ev.title;
      $('session-title').textContent = ev.title;
      refreshSessionList();
      break;
    case 'saved':
      S.session = { ...ev.session };
      refreshSessionList();
      break;
  }
}

async function refreshSessionList() {
  const st = await api.state();
  S.sessions = st.sessions;
  renderSessions($('session-search').value);
}

/* ---------------- permission dialog ---------------- */

function showPermission(req) {
  $('perm-text').textContent = `Kestrel wants to use "${req.name}".`;
  $('perm-input').textContent = JSON.stringify(req.input, null, 2);
  $('permission').classList.remove('hidden');
  permissionResolver = async (decision) => {
    $('permission').classList.add('hidden');
    permissionResolver = null;
    await api.permission.answer(req.id, decision);
  };
}

/* ---------------- keys screen ---------------- */

function openKeys() {
  const box = $('keys-rows');
  box.replaceChildren();
  for (const p of S.providers.filter((x) => x.needsKey)) {
    const known = S.keys.find((k) => k.provider === p.id);
    const row = el('div', 'key-row');
    row.append(el('div', 'p', p.id));
    const input = el('input');
    input.type = 'password';
    input.placeholder = known && known.present ? `saved: ${known.masked}` : 'paste key';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const state = el('span', 'key-state', known && known.present ? 'saved' : 'missing');
    if (known && known.present) state.classList.add('ok');
    const btn = el('button', 'ghost-btn', 'Save');
    btn.onclick = async () => {
      const key = input.value.trim();
      if (!key) return;
      state.textContent = 'checking…';
      state.className = 'key-state';
      const res = await api.keys.set(p.id, key);
      input.value = '';
      if (res.ok) {
        state.textContent = 'verified';
        state.className = 'key-state ok';
        S = await api.state();
        modelsByProvider.delete(p.id);
        renderKeySummary();
        renderProviders();
        await loadModels();
        toast(p.id + ' key saved (encrypted)');
      } else {
        state.textContent = 'rejected: ' + res.note;
        state.className = 'key-state bad';
      }
    };
    const right = el('div');
    right.style.display = 'flex';
    right.style.gap = '6px';
    right.style.alignItems = 'center';
    right.append(state, btn);
    row.append(input, right);
    box.append(row);
  }
  $('keys-screen').classList.remove('hidden');
}

/* ---------------- wiring ---------------- */

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

async function send() {
  const box = $('composer');
  const text = box.value.trim();
  if (!text || streaming) return;
  box.value = '';
  box.style.height = 'auto';
  addUser(text);
  setStreaming(true);
  const res = await api.turn.send(text);
  if (res && (res.ok === false || res.command)) setStreaming(false);
}

function wire() {
  $('send').onclick = send;
  $('stop').onclick = () => api.turn.abort();
  $('composer').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $('composer').addEventListener('input', (e) => {
    const t = e.target;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 180) + 'px';
  });
  $('new-session').onclick = async () => {
    S = await api.session.create({ title: 'New session' });
    renderAll();
  };
  $('keys-open').onclick = openKeys;
  $('keys-close').onclick = () => $('keys-screen').classList.add('hidden');
  $('session-search').oninput = (e) => renderSessions(e.target.value);
  $('mode').onchange = async (e) => {
    S = await api.mode.set(e.target.value);
    $('status-mode').textContent = 'mode ' + e.target.value;
  };
  $('perm-allow').onclick = () => permissionResolver && permissionResolver('allow');
  $('perm-session').onclick = () => permissionResolver && permissionResolver('allow_session');
  $('perm-deny').onclick = () => permissionResolver && permissionResolver('deny');
  $('session-title').ondblclick = () => {
    const title = promptRename(S.session.title);
    title.then(async (value) => {
      if (!value) return;
      S = await api.session.rename(S.session.id, value);
      S.session.title = value;
      $('session-title').textContent = value;
      refreshSessionList();
    });
  };
  for (const tab of document.querySelectorAll('.tab')) {
    tab.onclick = () => {
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
      const name = tab.dataset.tab;
      $('tab-changes').classList.toggle('hidden', name !== 'changes');
      $('tab-terminal').classList.toggle('hidden', name !== 'terminal');
    };
  }
  api.on('engine:event', handleEvent);
  api.on('permission:request', showPermission);
}

function promptRename(current) {
  return new Promise((resolve) => {
    const overlay = el('div', 'overlay');
    overlay.id = 'rename-overlay';
    const dialog = el('div', 'dialog');
    dialog.append(el('h2', null, 'Rename session'));
    const input = el('input');
    input.id = 'rename-input';
    input.value = current;
    input.style.cssText =
      'width:100%;background:var(--bg);border:1px solid var(--line-2);border-radius:6px;color:var(--text);padding:8px;font:13px var(--sans);outline:none';
    const actions = el('div', 'dialog-actions');
    const cancel = el('button', 'ghost-btn', 'Cancel');
    const save = el('button', 'primary-btn', 'Save');
    save.id = 'rename-save';
    const done = (v) => {
      overlay.remove();
      resolve(v);
    };
    cancel.onclick = () => done(null);
    save.onclick = () => done(input.value.trim());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value.trim());
      if (e.key === 'Escape') done(null);
    });
    actions.append(cancel, save);
    dialog.append(input, actions);
    overlay.append(dialog);
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}

init().catch((err) => {
  document.body.innerHTML = '<pre style="padding:20px;color:#f85149">' + err.stack + '</pre>';
});
