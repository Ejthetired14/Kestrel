// Electron main process: window, IPC, engine hosting, permissions, self-check hook.
'use strict';

const { app, BrowserWindow, ipcMain, nativeTheme, protocol, net } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Renderer files are served from app://kestrel so ES modules load (file:// origins
// block module scripts) and the page has a stable origin for its CSP.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const keys = require('./engine/keys');
const sessions = require('./engine/sessions');
const providers = require('./engine/providers');
const { runTurn } = require('./engine/loop');
const { buildSystemPrompt } = require('./engine/prompt');
const commands = require('./engine/commands');
const { compact, estimateTokens } = require('./engine/compact');
const { runClaudeTurn, cliVersion } = require('./engine/claude');

const SELFCHECK = process.argv.includes('--selfcheck');
const WINDOW = { width: 1200, height: 800 };

// Software rendering only: this runs on machines without a GPU, and the app
// must open fast and never depend on hardware acceleration.
app.disableHardwareAcceleration();

let win = null;
let session = null;
let mode = 'default';
let running = null; // { controller, promise }
let pendingPermissions = new Map();
const modelCache = new Map();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function state() {
  return {
    app: { name: 'Kestrel', version: app.getVersion() },
    session,
    sessions: sessions.list(),
    keys: keys.list(),
    providers: providers.list(),
    mode,
    cwd: process.cwd(),
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: WINDOW.width,
    height: WINDOW.height,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Kestrel',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.removeMenu();
  win.loadURL('app://kestrel/index.html');
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`renderer load failed (${code} ${desc}) ${url}`);
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (/error|warn/i.test(String(level)) || SELFCHECK) console.log(`[renderer] ${message}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('renderer process gone:', JSON.stringify(details));
  });
  win.webContents.on('unresponsive', () => console.error('renderer unresponsive'));
  return win;
}

// ---------------- engine plumbing ----------------

async function compactNow() {
  return compact({
    providerId: session.provider,
    model: session.model,
    session,
    onEvent: (ev) => send('engine:event', ev),
  });
}

function commandContext() {
  return {
    cwd: session.cwd,
    session,
    compact: compactNow,
    getMode: () => mode,
    setMode: (next) => {
      if (!['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(next)) throw new Error('unknown mode: ' + next);
      mode = next;
      session.mode = next;
      send('engine:event', { type: 'mode', mode: next });
    },
    setModel: (model) => {
      session.model = model;
      send('engine:event', { type: 'model', provider: session.provider, model });
    },
    listSessions: () => sessions.list(),
    openSession: (id) => {
      const s = sessions.load(id);
      if (!s) return null;
      session = s;
      mode = s.mode || 'default';
      send('engine:event', { type: 'session', session });
      return s;
    },
  };
}

async function sendTurn(text) {
  if (running) throw new Error('a turn is already running');

  // Keep the window inside the model's budget without the user having to ask.
  const limit = session.contextLimit || 120000;
  if (estimateTokens(session.messages) > limit * 0.6) {
    send('engine:event', { type: 'notice', text: 'Context is getting large — compacting…' });
    send('engine:event', { type: 'notice', text: await compactNow() });
  }

  session.messages.push({ role: 'user', content: text });
  if (session.title === 'New session') {
    session.title = text.slice(0, 60).replace(/\s+/g, ' ').trim() || 'Session';
    send('engine:event', { type: 'title', title: session.title });
  }

  // Claude Code CLI mode: the subprocess is the whole harness, so Kestrel only
  // displays its events and never re-runs the tools itself.
  if (session.provider === 'claude-cli') {
    const controller = new AbortController();
    const promise = (async () => {
      const res = await runClaudeTurn({
        session,
        prompt: text,
        model: session.model,
        mode,
        onEvent: (ev) => send('engine:event', ev),
        signal: controller.signal,
        approve: askPermission,
      });
      session.messages.push({ role: 'assistant', content: res.text || '', toolCalls: [] });
      session.usage.turns += 1;
      if (res.cost) session.cost = (session.cost || 0) + res.cost;
      sessions.save(session);
      send('engine:event', { type: 'saved', session });
      return res;
    })().finally(() => {
      running = null;
    });
    running = { controller, promise };
    return promise;
  }

  const controller = new AbortController();
  const system = buildSystemPrompt({
    cwd: session.cwd,
    mode,
    providerId: session.provider,
    model: session.model,
    todos: session.todos,
  });

  const promise = runTurn({
    providerId: session.provider,
    model: session.model,
    system,
    messages: session.messages,
    mode,
    session,
    signal: controller.signal,
    onEvent: (ev) => send('engine:event', ev),
    approve: askPermission,
  }).finally(() => {
    sessions.save(session);
    running = null;
  });

  running = { controller, promise };
  const result = await promise;
  sessions.save(session);
  send('engine:event', { type: 'saved', session });
  return result;
}

function askPermission(call) {
  return new Promise((resolve) => {
    const id = 'perm_' + Math.random().toString(36).slice(2, 9);
    pendingPermissions.set(id, resolve);
    send('permission:request', { id, name: call.name, input: call.input });
  });
}

// ---------------- IPC ----------------

ipcMain.handle('app:state', () => state());

ipcMain.handle('claude:info', () => ({ version: cliVersion(), bin: process.env.KESTREL_CLAUDE_BIN || 'claude' }));

ipcMain.handle('session:create', (_e, opts = {}) => {
  session = sessions.create({ cwd: sessions.load(session?.id)?.cwd || process.cwd(), ...opts });
  mode = session.mode || 'default';
  send('engine:event', { type: 'session', session });
  return state();
});

ipcMain.handle('session:open', (_e, id) => {
  const s = sessions.load(id);
  if (!s) throw new Error('session not found');
  session = s;
  session.todos = session.todos || [];
  mode = session.mode || 'default';
  return state();
});

ipcMain.handle('session:rename', (_e, { id, title }) => {
  const s = sessions.rename(id, title);
  if (session && session.id === id) session.title = s.title;
  return state();
});

ipcMain.handle('session:delete', (_e, id) => {
  sessions.remove(id);
  if (session && session.id === id) session = null;
  return state();
});

ipcMain.handle('mode:set', (_e, next) => {
  if (!['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(next)) throw new Error('bad mode');
  mode = next;
  if (session) {
    session.mode = next;
    sessions.save(session);
  }
  send('engine:event', { type: 'mode', mode: next });
  return state();
});

ipcMain.handle('keys:set', async (_e, { provider, key }) => {
  const p = providers.get(provider);
  const check = await p.validateKey(key);
  if (!check.ok) return { ok: false, note: check.note };
  keys.set(provider, key);
  modelCache.delete(provider);
  return { ok: true, note: check.note, state: state() };
});

ipcMain.handle('keys:remove', (_e, provider) => {
  keys.remove(provider);
  modelCache.delete(provider);
  return state();
});

ipcMain.handle('models:list', async (_e, provider) => {
  if (provider === 'pretend') return providers.get('pretend').listModels();
  if (modelCache.has(provider)) return modelCache.get(provider);
  const list = await providers.get(provider).listModels();
  modelCache.set(provider, list);
  return list;
});

ipcMain.handle('session:model', (_e, { provider, model }) => {
  if (!session) throw new Error('no session');
  session.provider = provider;
  session.model = model;
  const known = (modelCache.get(provider) || []).find((m) => m.id === model);
  if (known && known.context) session.contextLimit = known.context;
  sessions.save(session);
  return state();
});

ipcMain.handle('turn:send', async (_e, text) => {
  if (!session) throw new Error('no session');
  const raw = String(text);
  try {
    if (raw.startsWith('/')) {
      const result = await commands.handle(raw, commandContext());
      if (result) {
        if (result.text) send('engine:event', { type: 'notice', text: result.text });
        if (result.quit) setTimeout(() => app.quit(), 200);
        if (result.prompt) return await sendTurn(result.prompt);
        sessions.save(session);
        send('engine:event', { type: 'command_done', text: result.text || '' });
        return { ok: true, command: true };
      }
    }
    return await sendTurn(raw);
  } catch (err) {
    send('engine:event', { type: 'error', message: String(err.message || err) });
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('turn:abort', () => {
  if (running) running.controller.abort();
  return { ok: true };
});

ipcMain.handle('permission:answer', (_e, { id, decision }) => {
  const resolve = pendingPermissions.get(id);
  if (resolve) {
    pendingPermissions.delete(id);
    resolve(decision);
  }
  return { ok: true };
});

// ---------------- lifecycle ----------------

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';

  const rendererRoot = path.join(__dirname, 'renderer');
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = path.normalize(path.join(rendererRoot, rel));
    if (!file.startsWith(rendererRoot)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  createWindow();

  if (SELFCHECK) {
    try {
      const driver = require('./selfcheck/driver');
      await driver.run({ win, state, sendTurn, getSession: () => session });
    } catch (err) {
      console.error('selfcheck driver crashed', err);
      app.exit(2);
    }
  }
});

app.on('window-all-closed', () => app.quit());
