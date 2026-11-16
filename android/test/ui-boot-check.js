#!/usr/bin/env node
/* Boots the exact HTML/JS that ships inside the APK in a real DOM (jsdom) and
 * drives the app the way a person would: a demo turn with a permission prompt,
 * the menu, the chat drawer, the model picker, the skill library, themes and the
 * files sheet. It is the closest thing to opening the app without a device.
 *
 *   NODE_PATH=/tmp/domtest/node_modules node android/test/ui-boot-check.js
 *
 * jsdom is not a project dependency: install it anywhere and point NODE_PATH at
 * it. Without jsdom the script exits 2 and says so.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (err) {
  console.error('SKIP: jsdom is not installed. Install it outside the project, e.g.');
  console.error('  npm i --prefix /tmp/domtest jsdom');
  console.error('  NODE_PATH=/tmp/domtest/node_modules node android/test/ui-boot-check.js');
  process.exit(2);
}

const www = path.join(__dirname, '..', 'app', 'assets', 'www');
const read = (name) => fs.readFileSync(path.join(www, name), 'utf8');

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => errors.push('jsdomError: ' + err.message));
virtualConsole.on('error', (...args) => errors.push('console.error: ' + args.join(' ')));
virtualConsole.on('warn', (...args) => errors.push('console.warn: ' + args.join(' ')));

const html = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, {
  url: 'https://kestrel.test/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;
window.addEventListener('error', (event) => errors.push('window.onerror: ' + event.message));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, test, timeout) {
  const started = Date.now();
  while (Date.now() - started < (timeout || 6000)) {
    const value = test();
    if (value) return value;
    await wait(40);
  }
  throw new Error('timed out waiting for ' + label);
}

const checks = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => checks.push({ name, ok: true, detail: String(detail || 'ok') }))
    .catch((err) => checks.push({ name, ok: false, detail: String((err && err.message) || err) }));
}

(async () => {
  // Run the shipped scripts exactly as the WebView does, in order.
  window.eval(read('kestrel-skills.js'));
  window.eval(read('kestrel-engine.js'));
  window.eval(read('kestrel-selftest.js'));
  window.eval(read('app.js'));
  const doc = window.document;

  const buttonWith = (text, root) => [...(root || doc).querySelectorAll('button')].find((b) => text.test(b.textContent));
  // Typing must fire input: the send button is disabled until the composer has text.
  const type = (text) => {
    const box = doc.getElementById('composer');
    box.value = text;
    box.dispatchEvent(new window.Event('input'));
  };

  async function openMenuItem(label) {
    doc.getElementById('btn-more').click();
    await wait(20);
    const row = [...doc.querySelectorAll('#sheet-body .row.tap')].find((r) => label.test(r.textContent));
    if (!row) throw new Error('no menu item matching ' + label);
    row.click();
    await wait(40);
  }

  async function closeEverything() {
    if (!doc.getElementById('dialog').classList.contains('hidden')) {
      doc.querySelectorAll('#dlg-actions button')[0].click();
      await wait(20);
    }
    if (!doc.getElementById('sheet').classList.contains('hidden')) doc.getElementById('sheet-close').click();
    if (!doc.getElementById('drawer').classList.contains('hidden')) doc.getElementById('drawer-close').click();
    await wait(20);
  }

  await check('scripts load and the app reports ready', async () => {
    await until('documentElement[data-ready]', () => doc.documentElement.dataset.ready === '1');
    await until('__kestrel', () => window.__kestrel && window.__kestrel.ready);
    const meta = doc.getElementById('meta').textContent;
    if (!/Demo/.test(meta)) throw new Error('status bar did not render the provider: ' + meta);
    if (!doc.getElementById('model-name').textContent.includes('demo-1')) {
      throw new Error('model chip is empty: ' + doc.getElementById('model-name').textContent);
    }
    if (!doc.querySelector('#transcript .welcome')) throw new Error('empty state is missing');
    if (doc.documentElement.dataset.theme !== 'dark') throw new Error('expected the dark theme by default');
    return 'ready · ' + doc.getElementById('model-name').textContent + ' · ' + meta;
  });

  await check('first run shows a dismissible getting-started card', async () => {
    const card = doc.querySelector('#transcript .getting-started');
    if (!card) throw new Error('no getting-started card on the empty state');
    if (card.querySelectorAll('.gs-step').length < 3) throw new Error('the card has fewer than 3 steps');
    card.querySelector('.gs-close').click();
    await wait(30);
    if (doc.querySelector('#transcript .getting-started')) throw new Error('the card did not close');
    if (doc.defaultView.localStorage.getItem('kestrel.quickstart.v1') !== '1') {
      throw new Error('the dismissal was not remembered');
    }
    return '3 steps, dismissed, flag saved';
  });

  await check('composer + send runs a real demo turn', async () => {
    const composer = doc.getElementById('composer');
    type('Note that the phone build works');
    doc.getElementById('send').click();
    if (!doc.querySelector('#transcript .thinking')) throw new Error('no thinking indicator when the turn starts');
    await until('permission dialog', () => !doc.getElementById('dialog').classList.contains('hidden'));
    const code = doc.getElementById('dlg-code').textContent;
    if (!code.includes('"path"')) throw new Error('permission dialog showed no tool input');
    return 'dialog asked for: ' + doc.getElementById('dlg-title').textContent;
  });

  await check('allow once writes the file and formats the reply', async () => {
    const buttons = [...doc.querySelectorAll('#dlg-actions button')];
    const target = buttons.find((b) => /Allow once/.test(b.textContent));
    if (!target) throw new Error('no Allow once button');
    target.click();
    await until('stream to finish', () => window.__kestrel.streaming() === false, 12000);
    const files = window.__kestrel.files();
    if (!files.length) throw new Error('no file was written');
    if (!doc.querySelector('#transcript .msg.assistant .body.formatted')) {
      throw new Error('the reply was never rendered as markdown');
    }
    if (!buttonWith(/^Copy$/)) throw new Error('the reply has no Copy action');
    if (!buttonWith(/Regenerate/)) throw new Error('the last reply has no Regenerate action');
    if (doc.querySelector('#transcript .thinking')) throw new Error('the thinking indicator stayed behind');
    const userActs = [...doc.querySelectorAll('.msg.user .act')].map((b) => b.textContent);
    if (!userActs.includes('Edit') || !userActs.includes('Copy')) {
      throw new Error('user messages have no Copy/Edit actions: ' + userActs.join(','));
    }
    return files.join(', ') + ' written, reply formatted, user message has Copy/Edit';
  });

  await check('changes sheet shows the diff', async () => {
    const store = window.localStorage.getItem('kestrel.sessions.v1');
    if (!store || !store.includes('"edits"')) throw new Error('session was not saved with its edits');
    const session = JSON.parse(store)[0];
    if (!session.edits.length) throw new Error('no edits recorded');
    const edit = session.edits[0];
    if (!edit.after || edit.kind !== 'create') throw new Error('edit record is wrong: ' + JSON.stringify(Object.keys(edit)));
    await openMenuItem(/^Changes/);
    if (!doc.querySelector('#sheet-body .change')) throw new Error('changes sheet is empty');
    if (!doc.getElementById('sheet-title').textContent.includes('Changes')) throw new Error('wrong sheet title');
    doc.getElementById('sheet-close').click();
    return session.edits.length + ' edit(s) saved, kind=' + edit.kind;
  });

  await check('in-app self-check passes from Settings', async () => {
    await openMenuItem(/^Settings/);
    const run = buttonWith(/Run self-check/);
    if (!run) throw new Error('self-check button missing');
    run.click();
    await until('self-check report', () => doc.querySelector('.check'), 20000);
    const bad = doc.querySelectorAll('.check.bad').length;
    const total = doc.querySelectorAll('.check').length;
    if (bad) throw new Error(bad + ' of ' + total + ' checks failed in the app');
    return total + ' checks passed inside the app UI';
  });

  await check('model picker switches provider and model', async () => {
    doc.getElementById('sheet-close').click();
    doc.getElementById('model-chip').click();
    await wait(30);
    const row = [...doc.querySelectorAll('#sheet-body .row.tap')].find((r) => r.textContent.includes('gpt-4o-mini'));
    if (!row) throw new Error('the OpenAI models are not in the picker');
    row.click();
    await wait(40);
    const meta = doc.getElementById('meta').textContent;
    if (!meta.includes('OpenAI') || !meta.includes('gpt-4o-mini')) {
      throw new Error('the status bar did not follow the pick: ' + meta);
    }
    if (!doc.getElementById('model-name').textContent.includes('gpt-4o-mini')) {
      throw new Error('the chip did not follow the pick');
    }
    doc.getElementById('model-chip').click();
    await wait(30);
    const demo = [...doc.querySelectorAll('#sheet-body .row.tap')].find((r) => r.textContent.includes('demo-1'));
    if (!demo) throw new Error('no way back to the demo model');
    demo.click();
    await wait(40);
    if (!doc.getElementById('meta').textContent.includes('Demo')) throw new Error('did not return to Demo');
    return 'OpenAI · gpt-4o-mini, then back to demo';
  });

  await check('Settings can load free models and install a skill', async () => {
    await openMenuItem(/^Settings/);
    const labels = [...doc.querySelectorAll('#sheet-body button')].map((b) => b.textContent);
    if (!labels.some((t) => /free models/i.test(t))) throw new Error('no free-model loader in Settings');
    if (!labels.some((t) => /Add skill from URL/.test(t))) throw new Error('no skill installer in Settings');
    const providers = [...doc.querySelectorAll('#sheet-body select option')].map((o) => o.textContent);
    if (!providers.some((t) => /no key/i.test(t))) throw new Error('no keyless provider offered: ' + providers.join(' | '));
    doc.getElementById('sheet-close').click();
    return 'free-model loader, skill installer, keyless provider present';
  });

  await check('GitHub panel saves a token without echoing it', async () => {
    await openMenuItem(/^Settings/);
    const token = [...doc.querySelectorAll('#sheet-body input')].find((i) => /ghp_|github_pat_/.test(i.placeholder));
    if (!token) throw new Error('no GitHub token field in Settings');
    if (token.type !== 'password') throw new Error('the GitHub token field is not masked');
    if (![...doc.querySelectorAll('#sheet-body input')].some((i) => i.placeholder === 'owner/repo')) {
      throw new Error('no repository field');
    }
    for (const label of [/Save token/, /Check connection/, /Commit this project/, /Create repository/]) {
      if (!buttonWith(label)) throw new Error('missing GitHub action ' + label);
    }
    token.value = 'ghp_uitest1234567890';
    buttonWith(/Save token/).click();
    await wait(40);
    if (token.value) throw new Error('the token stayed in the field');
    const state = doc.getElementById('sheet-body').textContent;
    if (state.includes('ghp_uitest1234567890')) throw new Error('the token is printed in the sheet');
    if (!/token saved/i.test(state)) throw new Error('no saved state shown: ' + state.slice(0, 120));
    const storage = doc.defaultView.localStorage;
    for (let i = 0; i < storage.length; i += 1) {
      if (String(storage.getItem(storage.key(i)) || '').includes('ghp_uitest1234567890')) {
        throw new Error('the token leaked into localStorage');
      }
    }
    doc.getElementById('sheet-close').click();
    return 'masked field, 4 actions, token kept out of page storage';
  });

  await check('appearance switches to light and back to dark', async () => {
    await openMenuItem(/^Settings/);
    const toLight = buttonWith(/Switch to light/);
    if (!toLight) throw new Error('no theme toggle in Settings');
    toLight.click();
    await wait(40);
    if (doc.documentElement.dataset.theme !== 'light') throw new Error('the light theme was not applied');
    const toDark = buttonWith(/Switch to dark/);
    if (!toDark) throw new Error('the toggle did not flip');
    toDark.click();
    await wait(40);
    if (doc.documentElement.dataset.theme !== 'dark') throw new Error('the dark theme was not restored');
    doc.getElementById('sheet-close').click();
    return 'light then dark, saved to the theme key';
  });

  await check('skill library installs the bundled workflows', async () => {
    await openMenuItem(/^Skills/);
    const installAll = buttonWith(/^Install all/);
    if (!installAll) throw new Error('the library has no Install all button');
    const rows = [...doc.querySelectorAll('#sheet-body .row.tap')];
    if (rows.length < 30) throw new Error('expected the full bundled library, saw ' + rows.length + ' rows');
    if (!rows.some((r) => /^ponytail/.test(r.textContent))) throw new Error('ponytail is not in the library');
    installAll.click();
    await wait(200);
    const installed = window.__kestrel.skills();
    if (installed.length < 30) throw new Error('only ' + installed.length + ' skills were installed');
    const files = window.__kestrel.files();
    if (!files.includes('skills/ponytail.md')) throw new Error('skills/ponytail.md is missing: ' + files.slice(0, 8).join(', '));
    const search = doc.querySelector('#sheet-body input[placeholder^="Search skills"]');
    if (!search) throw new Error('the skills sheet has no search field');
    search.value = 'ponytail';
    search.dispatchEvent(new window.Event('input'));
    await wait(30);
    let filtered = [...doc.querySelectorAll('#sheet-body .row.tap')];
    if (!filtered.length || filtered.length >= rows.length) {
      throw new Error('search did not filter the list: ' + filtered.length + ' of ' + rows.length);
    }
    if (!filtered.every((r) => /ponytail/i.test(r.textContent))) {
      throw new Error('a non-matching skill survived the search');
    }
    search.value = '';
    search.dispatchEvent(new window.Event('input'));
    const packChip = [...doc.querySelectorAll('#sheet-body .filter-chip')].find((b) => /agent-skills/i.test(b.textContent));
    if (!packChip) throw new Error('no agent-skills filter chip');
    packChip.click();
    await wait(30);
    filtered = [...doc.querySelectorAll('#sheet-body .row.tap')];
    if (!filtered.length || filtered.length >= rows.length) {
      throw new Error('the source filter is wrong: ' + filtered.length + ' of ' + rows.length);
    }
    if (packChip.getAttribute('aria-pressed') !== 'true') throw new Error('the filter chip did not show its state');
    doc.getElementById('sheet-close').click();

    const matched = window.__kestrel.previewSkills('write unit tests for the parser');
    if (matched.indexOf('test-driven-development') < 0) throw new Error('auto-match missed a testing request: ' + matched.join(','));
    if (window.__kestrel.previewSkills('hello there').length) throw new Error('small talk matched a skill');
    return installed.length + ' skills installed; auto-match picks ' + matched[0];
  });

  await check('voice, custom instructions, share and drafts', async () => {
    await closeEverything();
    await openMenuItem(/^Settings/);
    const about = doc.querySelector('#sheet-body textarea');
    if (!about) throw new Error('no custom-instructions field');
    about.value = 'Keep answers short.';
    buttonWith(/Save instructions/).click();
    await wait(40);
    if (!String(doc.defaultView.localStorage.getItem('kestrel.instructions.v1') || '').includes('Keep answers short')) {
      throw new Error('the instructions were not saved');
    }
    const speak = buttonWith(/Read replies aloud/);
    if (!speak) throw new Error('no read-aloud toggle');
    speak.click();
    await wait(30);
    if (doc.defaultView.localStorage.getItem('kestrel.speak.v1') !== '1') throw new Error('the voice toggle did not persist');
    if (!/on/.test(speak.textContent)) throw new Error('the toggle label did not change');
    speak.click();
    await wait(30);
    doc.getElementById('sheet-close').click();

    const mic = doc.getElementById('btn-mic');
    if (!mic) throw new Error('the composer has no microphone');
    mic.click();
    await wait(30);
    if (!/phone build only/.test(doc.getElementById('toast').textContent)) {
      throw new Error('the mic should say it needs the phone here');
    }

    const composer = doc.getElementById('composer');
    composer.value = 'a half typed thought';
    composer.dispatchEvent(new window.Event('input'));
    await wait(60);
    if (window.__kestrel.draft() !== 'a half typed thought') throw new Error('the draft is not on the session');
    doc.getElementById('btn-new').click();
    await wait(60);
    if (composer.value !== '') throw new Error('a new chat should start with an empty composer');
    return 'instructions saved, read-aloud toggles, mic falls back, drafts persist';
  });

  await check('Files sheet creates and deletes a file', async () => {
    await openMenuItem(/^Files/);
    const input = doc.querySelector('#sheet-body input');
    if (!input) throw new Error('no new-file field');
    input.value = 'notes/from-the-test.md';
    const create = buttonWith(/Create file/);
    if (!create) throw new Error('no Create file button');
    create.click();
    await wait(60);
    if (!window.__kestrel.files().includes('notes/from-the-test.md')) {
      throw new Error('the file was not created: ' + window.__kestrel.files().slice(0, 10).join(', '));
    }
    doc.getElementById('sheet-close').click();
    await openMenuItem(/^Files/);
    const row = [...doc.querySelectorAll('#sheet-body .row.tap')].find((r) => r.textContent.includes('from-the-test.md'));
    if (!row) throw new Error('the new file is not listed');
    row.querySelector('button').click();
    await wait(20);
    const del = [...doc.querySelectorAll('#dlg-actions button')].find((b) => /Delete/.test(b.textContent));
    del.click();
    await wait(60);
    if (window.__kestrel.files().includes('notes/from-the-test.md')) throw new Error('the file was not deleted');
    doc.getElementById('sheet-close').click();
    return 'created notes/from-the-test.md, then deleted it';
  });

  await check('projects: create with a template, switch, delete', async () => {
    await closeEverything();
    doc.querySelector('.title-block').click();
    await wait(30);
    if (!buttonWith(/New project/)) throw new Error('no New project button');
    buttonWith(/New project/).click();
    await wait(20);
    doc.querySelector('#sheet-body input').value = 'demo app';
    doc.querySelector('#sheet-body select').value = 'web';
    buttonWith(/Create project/).click();
    await wait(80);

    const meta = doc.getElementById('meta').textContent;
    if (!meta.startsWith('demo-app')) throw new Error('status bar did not switch project: ' + meta);
    const files = window.__kestrel.files();
    if (!files.includes('index.html') || !files.includes('styles.css')) {
      throw new Error('template files missing: ' + files.join(', '));
    }

    doc.querySelector('.title-block').click();
    await wait(20);
    const back = [...doc.querySelectorall('#sheet-body .row.tap')].find((r) => r.textContent.includes('my-project'));
    if (!back) throw new Error('no row to switch back to');
    back.click();
    await wait(60);
    if (!doc.getElementById('meta').textContent.startsWith('my-project')) {
      throw new Error('switching back failed: ' + doc.getElementById('meta').textContent);
    }
    if (window.__kestrel.files().includes('index.html')) throw new Error('the two projects share files');

    doc.querySelector('.title-block').click();
    await wait(20);
    const row = [...doc.querySelectorAll('#sheet-body .row.tap')].find((r) => r.textContent.includes('demo-app'));
    if (!row) throw new Error('demo-app is not listed');
    const cross = [...row.querySelectorAll('button')].find((b) => b.textContent === '✕');
    if (!cross) throw new Error('no delete button on the project row');
    cross.click();
    await wait(20);
    const del = [...doc.querySelectorAll('#dlg-actions button')].find((b) => /Delete/.test(b.textContent));
    if (!del) throw new Error('no confirm delete');
    del.click();
    await wait(60);
    doc.querySelector('.title-block').click();
    await wait(20);
    const names = [...doc.querySelectorAll('#sheet-body .row.tap')].map((r) => r.textContent);
    if (names.some((n) => n.includes('demo-app'))) throw new Error('the project was not deleted');
    doc.getElementById('sheet-close').click();

    doc.getElementById('btn-sessions').click();
    await wait(30);
    const sessions = [...doc.querySelectorAll('#drawer-body .row.tap')].map((r) => r.textContent);
    if (sessions.some((s) => s.includes('demo-app'))) throw new Error('a chat outlived its project: ' + sessions.join(' | '));
    doc.getElementById('drawer-close').click();
    if (window.__kestrel.currentProject() !== 'my-project') {
      throw new Error('current project is ' + window.__kestrel.currentProject() + ' after the delete');
    }
    return 'created demo-app with 3 files, switched away and back, deleted it and its chats';
  });

  await check('chat drawer: search, rename, pin, archive, end; project rename', async () => {
    await closeEverything();
    const drawerRow = (text) => [...doc.querySelectorAll('#drawer-body .row.tap')].find((r) => r.textContent.includes(text));
    const openActions = async () => {
      doc.getElementById('btn-sessions').click();
      await wait(30);
      const more = [...doc.querySelectorAll('#drawer-body button')].find((b) => b.textContent === '⋯');
      if (!more) throw new Error('no chat actions button');
      more.click();
      await wait(30);
    };

    doc.getElementById('btn-sessions').click();
    await wait(30);
    if (!doc.getElementById('drawer').classList.contains('hidden')) {
      const search = doc.getElementById('drawer-search');
      search.value = 'note';
      search.dispatchEvent(new window.Event('input'));
      await wait(30);
      if (!drawerRow('phone build')) throw new Error('search hid the matching chat');
      search.value = 'zzz-nothing';
      search.dispatchEvent(new window.Event('input'));
      await wait(30);
      if (drawerRow('phone build')) throw new Error('search did not filter');
      search.value = '';
      search.dispatchEvent(new window.Event('input'));
      await wait(30);
    }
    doc.getElementById('drawer-close').click();

    await openActions();
    buttonWith(/^Rename$/).click();
    await wait(30);
    const input = doc.getElementById('dlg-input');
    if (!input || input.classList.contains('hidden')) throw new Error('the rename dialog has no field');
    input.value = 'renamed on the phone';
    buttonWith(/Save/).click();
    await wait(60);
    if (!doc.getElementById('drawer-body').textContent.includes('renamed on the phone')) {
      throw new Error('the new title is not in the drawer');
    }

    await openActions();
    buttonWith(/Pin to top/).click();
    await wait(50);
    if (!doc.getElementById('drawer-body').textContent.includes('pinned')) throw new Error('no pinned badge');

    await openActions();
    buttonWith(/^Archive$/).click();
    await wait(50);
    if (drawerRow('renamed on the phone')) throw new Error('the archived chat is still listed');
    const showArchived = buttonWith(/Show archived/);
    if (!showArchived) throw new Error('no archived toggle');
    showArchived.click();
    await wait(30);
    if (!drawerRow('renamed on the phone')) throw new Error('the archived chat is missing');

    drawerRow('renamed on the phone').querySelector('button').click();
    await wait(30);
    buttonWith(/Restore from archive/).click();
    await wait(50);

    await openActions();
    buttonWith(/End session/).click();
    await wait(60);
    doc.getElementById('sheet-close').click();

    doc.getElementById('btn-sessions').click();
    await wait(30);
    const ended = drawerRow('renamed on the phone');
    if (!ended.textContent.includes('ended')) throw new Error('no ended badge');
    ended.click();
    await wait(60);
    if (!/Session ended/.test(doc.getElementById('transcript').textContent)) {
      throw new Error('no ended notice in the transcript');
    }
    const before = window.__kestrel.messageCount();
    type('this must not send');
    doc.getElementById('send').click();
    await wait(80);
    if (window.__kestrel.messageCount() !== before) throw new Error('an ended chat accepted a message');
    if (!/ended/i.test(doc.getElementById('toast').textContent)) throw new Error('no ended toast');
    doc.getElementById('composer').value = '';

    doc.querySelector('.title-block').click();
    await wait(30);
    const projectRow = [...doc.querySelectorAll('#sheet-body .row.tap')].find((r) => r.textContent.includes('my-project'));
    if (!projectRow) throw new Error('no project row');
    [...projectRow.querySelectorAll('button')].find((b) => b.textContent === '✎').click();
    await wait(30);
    doc.getElementById('dlg-input').value = 'main-project';
    [...doc.querySelectorAll('#dlg-actions button')].find((b) => /Save/.test(b.textContent)).click();
    await wait(80);
    const meta = doc.getElementById('meta').textContent;
    if (!meta.startsWith('main-project')) {
      throw new Error(
        'project rename did not reach the status bar: ' + meta +
          ' | session=' + JSON.stringify(window.__kestrel.session()) +
          ' | projects=' + JSON.stringify(window.__kestrel.projects())
      );
    }
    doc.getElementById('sheet-close').click();
    return 'searched, renamed, pinned, archived, restored, ended (send blocked), project renamed';
  });

  await check('import, attach and open-in-browser controls', async () => {
    await closeEverything();
    // Share needs a chat with something in it: the voice step left a new, empty one.
    doc.getElementById('btn-sessions').click();
    await wait(40);
    const withHistory = [...doc.querySelectorAll('#drawer-body .row.tap')].find((r) => {
      const count = r.textContent.match(/(\d+) msg/);
      return count && Number(count[1]) > 0;
    });
    if (!withHistory) throw new Error('no chat with messages in the drawer');
    withHistory.click();
    await wait(50);
    doc.querySelector('.title-block').click();
    await wait(30);
    const importBtn = buttonWith(/Import from GitHub/);
    if (!importBtn) throw new Error('no Import from GitHub button');
    importBtn.click();
    await wait(30);
    doc.querySelector('#sheet-body input').value = 'https://github.com/octocat/Hello-World';
    buttonWith(/Import repository/).click();
    await wait(100);
    const status = doc.getElementById('sheet-body').textContent;
    if (!/phone build only|Failed/i.test(status)) {
      throw new Error('the browser preview should explain the device is needed: ' + status.slice(0, 160));
    }
    doc.getElementById('sheet-close').click();

    await openMenuItem(/^Files/);
    const labels = [...doc.querySelectorAll('#sheet-body button')].map((b) => b.textContent);
    if (!labels.some((t) => /Add file/.test(t))) throw new Error('no Add file button');
    if (!labels.some((t) => /Add photo/.test(t))) throw new Error('no Add photo button');

    const fileRow = [...doc.querySelectorAll('#sheet-body .row.tap')].find((r) => /\.md/.test(r.textContent));
    if (!fileRow) throw new Error('no file to open');
    fileRow.click();
    await wait(30);
    if (!buttonWith(/Open in browser/)) throw new Error('the file view has no Open in browser button');
    doc.getElementById('sheet-close').click();

    if (!doc.getElementById('btn-attach')) throw new Error('the composer has no attach button');

    await openMenuItem(/^Share chat/);
    await wait(40);
    const dialogOpen = !doc.getElementById('dialog').classList.contains('hidden');
    if (dialogOpen) {
      const shown = doc.getElementById('dlg-code').textContent;
      if (!shown.includes('## You') || !shown.includes('## Kestrel')) {
        throw new Error('the copied transcript is wrong: ' + shown.slice(0, 120));
      }
      doc.querySelectorAll('#dlg-actions button')[0].click();
      await wait(20);
    } else if (!/copied/i.test(doc.getElementById('toast').textContent)) {
      throw new Error('share did nothing: ' + doc.getElementById('toast').textContent);
    }
    return 'Import from GitHub, Add file, Add photo, attach, Share and Open in browser all present';
  });

  await check('editing a message forks the conversation', async () => {
    await closeEverything();
    doc.getElementById('btn-sessions').click();
    await wait(40);
    const row = [...doc.querySelectorAll('#drawer-body .row.tap')].find((r) => {
      const count = r.textContent.match(/(\d+) msg/);
      return count && Number(count[1]) > 0;
    });
    if (!row) throw new Error('the demo chat is not in the drawer');
    row.click();
    await wait(60);
    const before = window.__kestrel.messageCount();
    const edit = [...doc.querySelectorAll('.msg.user .act')].find((b) => b.textContent === 'Edit');
    if (!edit) throw new Error('no Edit action on the user message');
    edit.click();
    await wait(60);
    const after = window.__kestrel.messageCount();
    if (after >= before) throw new Error('the fork kept later messages: ' + before + '→' + after);
    if (!doc.getElementById('composer').value.includes('phone build')) {
      throw new Error('the message did not return to the composer');
    }
    return 'dropped ' + (before - after) + ' later message(s), composer refilled';
  });

  await check('no console or runtime errors', async () => {
    if (errors.length) throw new Error(errors