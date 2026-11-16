// Session persistence. One JSON file per session under the user config dir.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { configDir } = require('./keys');

function dir() {
  const d = path.join(configDir(), 'sessions');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

const file = (id) => path.join(dir(), id + '.json');

function newId() {
  return 'ks_' + crypto.randomBytes(6).toString('hex');
}

function create({ cwd, provider = 'pretend', model = 'pretend-1', mode = 'default', title = 'New session' } = {}) {
  const now = Date.now();
  const s = {
    id: newId(),
    title,
    cwd: cwd || process.cwd(),
    provider,
    model,
    mode,
    messages: [],
    edits: [],
    terminal: [],
    usage: { input: 0, output: 0, turns: 0 },
    createdAt: now,
    updatedAt: now,
  };
  save(s);
  return s;
}

function save(session) {
  session.updatedAt = Date.now();
  fs.writeFileSync(file(session.id), JSON.stringify(session, null, 2));
  return session;
}

function load(id) {
  const f = file(id);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function list() {
  return fs
    .readdirSync(dir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8'));
        return {
          id: s.id,
          title: s.title,
          cwd: s.cwd,
          provider: s.provider,
          model: s.model,
          updatedAt: s.updatedAt,
          messages: (s.messages || []).length,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function rename(id, title) {
  const s = load(id);
  if (!s) throw new Error('session not found');
  s.title = String(title || '').slice(0, 120) || 'Untitled';
  return save(s);
}

function remove(id) {
  const f = file(id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

module.exports = { create, save, load, list, rename, remove, newId };
