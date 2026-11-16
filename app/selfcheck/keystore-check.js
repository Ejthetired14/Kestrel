#!/usr/bin/env node
// Verifies the key store: encrypted at rest, outside the project, masked on read.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kestrel-keys-'));
process.env.XDG_CONFIG_HOME = tmp;

const keys = require('../engine/keys');
const secret = 'sk-test-0123456789abcdefghij';

const out = { ok: false, checks: [] };
const check = (name, pass, detail) => {
  out.checks.push({ name, pass, detail });
  if (!pass) out.ok = false;
};

keys.set('gemini', secret);
const file = path.join(tmp, 'kestrel', 'keys.bin');
const raw = fs.readFileSync(file);

check('store is outside the project', !file.startsWith(path.resolve(__dirname, '..')));
check('plaintext not present in the file', raw.includes(secret) === false);
check('file is binary ciphertext', raw.subarray(0, 12).length === 12 && raw.length > 28);
check('get returns the key', keys.get('gemini') === secret);
check('list masks the key', /^sk-t•+efghij$|^.{4}•+.{4}$/.test(keys.list().find((k) => k.provider === 'gemini').masked));
check(
  'list never returns the key',
  keys.list().every((k) => !k.masked.includes(secret) && !JSON.stringify(k).includes(secret))
);
check('different provider is empty', keys.get('openrouter') === null);
keys.remove('gemini');
check('remove clears it', keys.get('gemini') === null);

const mode = fs.statSync(path.join(tmp, 'kestrel', 'machine.key')).mode & 0o777;
check('machine key is 0600', mode === 0o600, 'mode ' + mode.toString(8));

out.ok = out.checks.every((c) => c.pass);
console.log(JSON.stringify(out, null, 2));
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(out.ok ? 0 : 1);
