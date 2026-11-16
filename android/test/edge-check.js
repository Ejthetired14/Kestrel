#!/usr/bin/env node
/* Second end-to-end pass over the shipped UI: the awkward paths rather than the
 * happy path. Switching chats mid-stream, an empty project, deleting the last
 * chat, repeatedly opening every sheet, and sending while a reply is running.
 *
 *   NODE_PATH=/tmp/domtest/node_modules node android/test/edge-check.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (err) {
  console.error('SKIP: jsdom is not installed (npm i --prefix /tmp/domtest jsdom)');
  process.exit(2);
}

const www = path.join(__dirname, '..', 'app', 'assets', 'www');
const read = (name) => fs.readFileSync(path.join(www, name), 'utf8');

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => errors.push('jsdomError: ' + err.message));
virtualConsole.on('error', (...args) => errors.push('console.error: ' + args.join(' ')));
virtualConsole.on('warn', (...args) => errors.push('console.warn: ' + args.join(' ')));

const dom = new JSDOM(read('index.html').replace(/<script[\s\S]*?<\/script>/g, ''), {
  url: 'https://kestrel.test/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;
const doc = window.document;
window.addEventListener('error', (event) => errors.push('window.onerror: ' + event.message));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
async function check(name, fn) {
  try {
    checks.push({ name, ok: true, detail: String((await fn()) || 'ok') });
  } catch (err) {
    checks.push({ name, ok: false, detail: String((err && err.message) || err) });
  }
}
async function until(label, test, timeout) {
  const started = Date.now();
  while (Date.now() - started < (timeout || 8000)) {
    const value = test();
    if (value) return value;
    await wait(40);
  }
  throw new Error('timed out waiting for ' + label);
}

window.eval(read('kestrel-skills.js'));
window.eval(read('kestrel-engine.js'));
window.eval(read('kestrel-selftest.js'));
window.eval(read('app.js'));

const buttonWith = (text, root) => [...(root || doc).querySelectorAll('button')].find((b) => text.test(b.textContent));
const type = (text) => {
  const box = doc.getElementById('composer');
  box.value = text;
  box.dispatchEvent(new window.Event('input'));
};
async function openMenuItem(label) {
  doc.getElementById('btn-more').click();
  await wait(20);
  const row = [...doc.querySelectorAll('#sheet-body .row.tap')].find((r) => label.test(r.textContent));
  if (!row) throw new Error('no menu item ' + label);
  row.click();
  await wait(40);
}
const allowDialog = async () => {
  if (doc.getElementById('dialog').classList.contains('hidden')) return false;
  const allow = buttonWith(/Allow once/);
  if (!allow) return false;
  allow.click();
  await until('turn end', () => window.__kestrel.streaming() === false, 12000);
  return true;
};

(async () => {
  await until('ready', () => window.__kestrel && window.__kestrel.ready);

  await check('a demo turn runs and finishes cleanly', async () => {
    type('note this please');
    doc.getElementById('send').click();
    await until('dialog', () => !doc.getElementById('dialog').classList.contains('hidden'));
    if (!(await allowDialog())) throw new Error('the permission dialog had no Allow once');
    return window.__kestrel.messageCount() + ' messages, streaming=' + window.__kestrel.streaming();
  });

  await check('switching chat mid-reply does not leak into the new chat', async () => {
    type('write something long');
    doc.getElementById('send').click();
    // Switch immediately, while the turn is still running.
    doc.getElementById('btn-new').click();
    await wait(900);
    const left = doc.getElementById('dialog');
    if (!left.classList.contains('hidden')) {
      doc.querySelectorAll('#dlg-actions button')[0].click();
      await wait(100);
    }
    const now = window.__kestrel.session();
    if (now.id !== null && window.__kestrel.messageCount() !== 0) {
      throw new Error(
        'the fresh chat received the old turn: ' + window.__kestrel.messageCount() + ' messages'
      );
    }
    return 'new chat stayed empty, stream=' + window.__kestrel.streaming();
  });

  await check('switching chat while a permission prompt waits cancels it', async () => {
    doc.getElementById('btn-new').click();
    await wait(40);
    const before = window.__kestrel.files().length;
    type('write a note now');
    doc.getElementById('send').click();
    await until('dialog', () => !doc.getElementById('dialog').classList.contains('hidden'));
    // Leave while the agent is waiting for permission.
    doc.getElementById('btn-new').click();
    await wait(800);
    if (!doc.getElementById('dialog').classList.contains('hidden')) {
      throw new Error('the old permission prompt stayed open over the new chat');
    }
    if (window.__kestrel.messageCount() !== 0) throw new Error('the new chat received messages');
    if (window.__kestrel.files().length !== before) {
      throw new Error('the abandoned turn still wrote a file (' + before + '→' + window.__kestrel.files().length + ')');
    }
    return 'prompt closed, nothing written, new chat empty';
  });

  await check('a second send while streaming is ignored', async () => {
    type('first');
    doc.getElementById('send').click();
    const before = window.__kestrel.messageCount();
    type('second');
    doc.getElementById('send').click();
    await wait(300);
    const after = window.__kestrel.messageCount();
    if (after - before > 1) throw new Error('a duplicate message was accepted: ' + before + '→' + after);
    await allowDialog();
    doc.getElementById('composer').value = '';
    return 'one message accepted (' + before + '→' + after + ')';
  });

  await check('an empty project opens its Files sheet', async () => {
    doc.querySelector('.title-block').click();
    await wait(30);
    buttonWith(/New project/).click();
    await wait(30);
    doc.querySelector('#sheet-body input').value = 'empty one';
    doc.querySelector('#sheet-body select').value = 'blank';
    buttonWith(/Create project/).click();
    await wait(80);
    await openMenuItem(/^Files/);
    const body = doc.getElementById('sheet-body').textContent;
    if (!/empty/i.test(body)) throw new Error('no empty-state text: ' + body.slice(0, 120));
    doc.getElementById('sheet-close').click();
    return 'blank project shows an empty state';
  });

  await check('deleting the last chat leaves a usable new chat', async () => {
    doc.getElementById('btn-sessions').click();
    await wait(30);
    // Keep deleting whatever is left until one chat remains, then delete that too.
    for (let guard = 0; guard < 6; guard += 1) {
      doc.getElementById('btn-sessions').click();
      await wait(30);
      const rows = [...doc.querySelectorAll('#drawer-body button')].filter((b) => b.textContent === '⋯');
      if (!rows.length) break;
      rows[0].click();
      await wait(30);
      const del = buttonWith(/^Delete$/);
      if (!del) throw new Error('no Delete in the chat actions');
      del.click();
      await wait(30);
      const confirm = [...doc.querySelectorAll('#dlg-actions button')].find((b) => /Delete/.test(b.textContent));
      if (!confirm) throw new Error('no confirm for deleting a chat');
      confirm.click();
      await wait(60);
    }
    if (window.__kestrel.messageCount() !== 0) throw new Error('the replacement chat is not empty');
    if (!doc.querySelector('#transcript .welcome')) throw new Error('no empty state after deleting everything');
    return 'chat replaced, empty state shown';
  });

  await check('every menu entry opens and closes', async () => {
    const labels = [/^Files/, /^Changes/, /^Projects/, /^Skills/, /^Settings/, /^Share chat/];
    for (const label of labels) {
      await openMenuItem(label);
      if (!doc.getElementById('sheet').classList.contains('hidden')) doc.getElementById('sheet-close').click();
      await wait(20);
    }
    await openMenuItem(/^Run self-check/);
    await until('self-check report', () => doc.querySelector('.check'), 20000);
    doc.getElementById('sheet-close').click();
    return labels.length + ' sheets + self-check';
  });

  await check('the model picker survives every provider', async () => {
    doc.getElementById('model-chip').click();
    await wait(40);
    const rows = [...doc.querySelectorAll('#sheet-body .row.tap')];
    if (rows.length < 8) throw new Error('too few models offered: ' + rows.length);
    for (const row of rows.slice(0, 4)) {
      doc.getElementById('model-chip').click();
      await wait(30);
      const again = [...doc.querySelectorall('#sheet-body .row.tap')];
      if (!again.length) throw new Error('the picker was empty on reopen');
      again[0].click();
      await wait(40);
    }
    const demoRow = [...doc.querySelectorAll('#sheet-body .row.tap')].find((r) => r.textContent.includes('demo-1'));
    if (doc.getElementById('sheet').classList.contains('hidden')) {
      doc.getElementById('model-chip').click();
      await wait(30);
    }
    const back = [...doc.querySelectorAll('#sheet-body .row.tap')].find((r) => r.textContent.includes('demo-1'));
    if (back) back.click();
    await wait(40);
    if (!demoRow) throw new Error('the demo model was not offered');
    return rows.length + ' model rows, switched back to demo';
  });

  await check('a long message does not break the composer', async () => {
    const long = 'word '.repeat(600).trim();
    type(long);
    doc.getElementById('send').click();
    await wait(200);
    if (window.__kestrel.streaming() === false && doc.getElementById('transcript').textContent.includes('failed')) {
      throw new Error('the long message failed');
    }
    await allowDialog();
    doc.getElementById('composer').value = '';
    return long.length + ' characters sent';
  });

  await check('choosing a keyed model without a key explains itself', async () => {
    await openMenuItem(/^Settings/);
    const select = doc.querySelector('#sheet-body select');
    select.value = 'openai';
    select.dispatchEvent(new window.Event('change'));
    await wait(40);
    doc.getElementById('sheet-close').click();
    type('hello without a key');
    doc.getElementById('send').click();
    await wait(400);
    const errorText = doc.querySelector('#transcript .msg.error') ? doc.querySelector('#transcript .msg.error').textContent : '';
    if (!/key/i.test(errorText)) throw new Error('no key error shown: ' + errorText.slice(0, 120));
    if (!buttonWith(/Retry/)) throw new Error('the error has no Retry action');
    const hint = doc.querySelector('#transcript .msg.error .hint');
    if (!hint || !/Settings|Demo/i.test(hint.textContent)) throw new Error('the error has no recovery hint');
    const errorActs = [...doc.querySelectorAll('#transcript .msg.error .actions button')].map((b) => b.textContent);
    if (!errorActs.includes('Copy')) throw new Error('the error cannot be copied: ' + errorActs.join(','));
    const count = window.__kestrel.messageCount();

    await openMenuItem(/^Settings/);
    const back = doc.querySelector('#sheet-body select');
    back.value = 'demo';
    back.dispatchEvent(new window.Event('change'));
    await wait(40);
    doc.getElementById('sheet-close').click();
    if (!doc.getElementById('meta').textContent.includes('Demo')) throw new Error('could not return to Demo');
    return 'error bubble + Retry shown, back on Demo (' + count + ' messages)';
  });

  await check('attaching without a device explains itself', async () => {
    doc.getElementById('btn-attach').click();
    await wait(60);
    if (!/phone build only/i.test(doc.getElementById('toast').textContent)) {
      throw new Error('no explanation: ' + doc.getElementById('toast').textContent);
    }
    return 'attach falls back with a message';
  });

  await check('a file sent without text still becomes a message', async () => {
    const before = window.__kestrel.messageCount();
    window.__kestrel.setAttachments(['uploads/check.png']);
    if (doc.getElementById('send').disabled) throw new Error('send stayed disabled with an attachment');
    doc.getElementById('send').click();
    // The demo model writes a note on its first tool turn and just replies on later
    // ones, so accept either a permission dialog or a finished reply.
    await until(
      'dialog or reply',
      () => !doc.getElementById('dialog').classList.contains('hidden') || window.__kestrel.streaming() === false,
      12000
    );
    if (!doc.getElementById('dialog').classList.contains('hidden')) await allowDialog();
    await until('turn end', () => window.__kestrel.streaming() === false, 12000);
    if (window.__kestrel.messageCount() <= before) throw new Error('the message was dropped');
    if (!doc.getElementById('transcript').textContent.includes('Attached: uploads/check.png')) {
      throw new Error('the attachment name is not in the transcript');
    }
    if (window.__kestrel.attachmentCount() !== 0) throw new Error('the chip survived the send');
    return 'sent with attachment only (' + before + '→' + window.__kestrel.messageCount() + ')';
  });

  await check('attachment chips do not follow you into a new chat', async () => {
    window.__kestrel.setAttachments(['uploads/old.txt']);
    doc.getElementById('btn-new').click();
    await wait(80);
    if (window.__kestrel.attachmentCount() !== 0) throw new Error('the chip stayed on the new chat');
    if (!doc.getElementById('send').disabled) throw new Error('an empty new chat should not be sendable');
    return 'chips cleared, send disabled';
  });

  await check('compact styles win at narrow widths', async () => {
    const css = fs.readFileSync(path.join(www, 'styles.css'), 'utf8');
    const media = sss.indexOf('@media (max-width: 420px)');
    const composer = css.indexOf('\n#composer {');
    const jump = css.indexOf('\n.jump {');
    if (media < 0) throw new Error('no narrow-screen block');
    if (media < composer || media < jump) throw new Error('base rules override the compact sizes');
    const block = css.slice(media);
    for (const rule of ['#composer {', '.round, .send {', '.jump {']) {
      if (block.indexOf(rule) < 0) throw new Error('the narrow block lost ' + rule);
    }
    return 'media block follows the base rules';
  });

  await check('no console errors, unhandled rejections or crashes', async () => {
    if (errors.length) throw new Error(errors.slice(0, 3).join(' | '));
    return 'clean';
  });

  let width = 0;
  for (const c of checks) width = Math.max(width, c.name.length);
  for (const c of checks) console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name.padEnd(width) + '  ' + c.detail);
  const failed = checks.filter((c) => !c.ok).length;
  console.log('');
  console.log((failed ? 'EDGE CHECK FAIL' : 'EDGE CHECK PASS') + ` — ${checks.length - failed}/${checks.length} steps`);
  fs.mkdirSync(path.join(__dirname, '..', '..', 'checks', 'android'), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, '..', '..', 'checks', 'android', 'edge-check.json'),
    JSON.stringify({ when: new Date().toISOString(), ok: failed === 0, steps: checks, errors }, null, 2) + '\n'
  );
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('EDGE CHECK CRASHED');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
