// Encrypted key store. Keys live OUTSIDE this folder, in the user config dir,
// AES-256-GCM encrypted with a machine key file (0600). Plaintext never leaves
// this module except as a masked preview.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PROVIDERS = ['gemini', 'openrouter', 'nvidia'];

function configDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'kestrel');
}

function paths() {
  const dir = configDir();
  return { dir, machineKey: path.join(dir, 'machine.key'), store: path.join(dir, 'keys.bin') };
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
}

function machineKey() {
  const { dir, machineKey: file } = paths();
  ensureDir(dir);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

function readStore() {
  const { store } = paths();
  if (!fs.existsSync(store)) return {};
  try {
    const buf = fs.readFileSync(store);
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', machineKey(), iv);
    d.setAuthTag(tag);
    const json = Buffer.concat([d.update(data), d.final()]).toString('utf8');
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function writeStore(obj) {
  const { dir, store } = paths();
  ensureDir(dir);
  const key = machineKey();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  const out = Buffer.concat([iv, c.getAuthTag(), data]);
  const tmp = store + '.tmp';
  fs.writeFileSync(tmp, out, { mode: 0o600 });
  fs.renameSync(tmp, store);
}

function mask(key) {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return key.slice(0, 4) + '•'.repeat(Math.min(18, key.length - 8)) + key.slice(-4);
}

module.exports = {
  PROVIDERS,
  configDir,
  has: (provider) => Boolean(readStore()[provider]),
  get: (provider) => readStore()[provider] || null,
  list: () =>
    PROVIDERS.map((p) => {
      const k = readStore()[p];
      return { provider: p, present: Boolean(k), masked: k ? mask(k) : '' };
    }),
  set(provider, key) {
    if (!PROVIDERS.includes(provider)) throw new Error('unknown provider: ' + provider);
    if (typeof key !== 'string' || key.trim().length < 8) throw new Error('key looks too short');
    const all = readStore();
    all[provider] = key.trim();
    writeStore(all);
    return { provider, masked: mask(all[provider]) };
  },
  remove(provider) {
    const all = readStore();
    delete all[provider];
    writeStore(all);
  },
};
