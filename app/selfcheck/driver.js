// Self-check driver. Runs inside the real Electron main process with --selfcheck,
// drives the real window, and records evidence under checks/.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const sessions = require('../engine/sessions');

const ROOT = path.join(__dirname, '..', '..');
const CHECKS = path.join(ROOT, 'checks');
const started = new Date();
const steps = [];

function ensureChecks() {
  fs.mkdirSync(CHECKS, { recursive: true });
  return path.join(CHECKS, 'runs');
}

function stamp() {
  return started.toISOString().replace(/[:.]/g, '-');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ win }) {
  const runDir = path.join(ensureChecks(), stamp());
  fs.mkdirSync(runDir, { recursive: true });

  // A dead renderer leaves executeJavaScript pending forever, so every call is
  // raced against a timeout: a crash then shows up as a step failure.
  const js = (code) =>
    Promise.race([
      win.webContents.executeJavaScript(code, true),
      new Promise((_, reject) => setTimeout(() => reject(new Error('renderer did not answer within 8s')), 8000)),
    ]);
  const evidence = { startedAt: started.toISOString(), runDir, steps, errors: [], screenshots: [], proof: {} };
  let errorCount = 0;

  const shoot = async (label) => {
    try {
      // Let the compositor paint what the DOM already reports.
      await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => {});
      await sleep(250);
      const img = await win.webContents.capturePage();
      const file = path.join(runDir, `${label}.png`);
      fs.writeFileSync(file, img.toPNG());
      evidence.screenshots.push(path.relative(ROOT, file));
    } catch (err) {
      evidence.errors.push('screenshot failed: ' + err.message);
    }
  };

  async function step(name, fn) {
    const t = Date.now();
    try {
      const value = await fn();
      steps.push({ name, ok: true, ms: Date.now() - t });
      if (value !== undefined) evidence.proof[name] = value;
      return value;
    } catch (err) {
      errorCount++;
      const entry = { name, ok: false, ms: Date.now() - t, error: String(err && err.message ? err.message : err) };
      steps.push(entry);
      evidence.errors.push(`${name}: ${entry.error}`);
      await shoot(`error-${errorCount}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
      throw err;
    }
  }

  async function waitFor(name, expression, timeoutMs = 20000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      try {
        if (await js(expression)) return true;
      } catch {
        /* page may still be loading */
      }
      await sleep(120);
    }
    throw new Error(`timed out waiting for ${name}`);
  }

  const setProvider = async (id) => {
    await js(
      `(() => { const s = document.getElementById('provider'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change')); return true; })()`
    );
    await sleep(500);
    const actual = await js('document.getElementById("provider").value');
    if (actual !== id) throw new Error(`provider did not switch to ${id} (got ${actual})`);
  };

  // Type into the real composer and click send, exactly like a user.
  const sendPrompt = async (text, { waitTurn = true } = {}) => {
    await js(
      `(() => { const c = document.getElementById('composer'); c.value = ${JSON.stringify(text)}; c.dispatchEvent(new Event('input')); document.getElementById('send').click(); return true; })()`
    );
    if (waitTurn) await waitFor('turn finished for: ' + text, 'window.__kestrel.streaming() === false', 30000);
  };

  // Auto-approve permission dialogs for the whole run, except when a step asks
  // for the next one to be denied.
  let permits = 0;
  let denials = 0;
  let denyNext = false;
  let pauseApprovals = false;
  let poller = null;
  const startPoller = () => {
    if (poller) return;
    poller = setInterval(async () => {
      try {
        const visible = await js('!document.getElementById("permission").classList.contains("hidden")');
        if (visible) {
          if (pauseApprovals) {
            // A step is photographing or deliberately answering this one itself.
            return;
          } else if (denyNext) {
            denyNext = false;
            denials++;
            await js('document.getElementById("perm-deny").click(), true');
          } else {
            permits++;
            await js('document.getElementById("perm-allow").click(), true');
          }
        }
      } catch {
        /* window may be closing */
      }
    }, 150);
  };

  try {
    await step('window-opened', async () => {
      await waitFor('renderer ready', 'document.documentElement.dataset.ready === "1"');
      startPoller();
      return { size: win.getSize(), title: win.getTitle() };
    });

    await step('fresh-session', async () => {
      await js('document.getElementById("new-session").click(), true');
      await sleep(400);
      const id = await js('window.__kestrel.sessionId()');
      const title = await js('document.getElementById("session-title").textContent');
      return { id, title, emptyTranscript: (await js('window.__kestrel.transcript()')).trim().length === 0 };
    });

    await step('model-picker', async () => {
      const provider = await js('document.getElementById("provider").value');
      const options = await js('[...document.getElementById("model").options].map(o=>o.value)');
      const modes = await js('[...document.getElementById("mode").options].map(o=>o.value)');
      if (provider !== 'pretend') throw new Error('expected pretend provider, got ' + provider);
      if (!options.includes('pretend-1')) throw new Error('pretend-1 missing from model picker: ' + options.join(','));
      if (!modes.includes('plan')) throw new Error('mode picker incomplete');
      return { provider, options, modes };
    });

    await step('keys-screen', async () => {
      await js('document.getElementById("keys-open").click(), true');
      await waitFor('keys screen visible', '!document.getElementById("keys-screen").classList.contains("hidden")');
      const rows = await js('[...document.querySelectorAll("#keys-rows .key-row .p")].map(e=>e.textContent)');
      await shoot('keys-screen');
      await js('document.getElementById("keys-close").click(), true');
      await waitFor('keys screen closed', 'document.getElementById("keys-screen").classList.contains("hidden")');
      if (rows.length !== 3) throw new Error('expected 3 key rows, got ' + rows.length);
      return { providers: rows };
    });

    await step('prompt-and-permissions', async () => {
      await js(
        `(() => { const c = document.getElementById('composer'); c.value = 'Read the notes and write a summary file'; c.dispatchEvent(new Event('input')); document.getElementById('send').click(); return true; })()`
      );
      await waitFor('streaming started', 'window.__kestrel.streaming() === true', 15000);

      await waitFor('turn finished', 'window.__kestrel.streaming() === false', 40000);
      const text = await js('window.__kestrel.transcript()');
      if (!text.includes('streaming reached the window')) throw new Error('final assistant text did not reach the window');
      // read is auto-allowed; only the write must ask.
      if (permits < 1) throw new Error('no permission prompt appeared for the write');
      return { permits, transcriptChars: text.length };
    });

    await step('file-written-by-tool', async () => {
      const file = path.join(process.cwd(), 'selfcheck', 'fixture', 'summary.md');
      if (!fs.existsSync(file)) throw new Error('tool never wrote ' + file);
      const body = fs.readFileSync(file, 'utf8');
      if (!body.includes('Kestrel self-check')) throw new Error('summary content wrong: ' + body);
      return { file: path.relative(ROOT, file), bytes: body.length };
    });

    await step('changes-panel', async () => {
      const count = await js('document.getElementById("change-count").textContent');
      const hasDiff = await js('document.querySelectorAll("#tab-changes .change").length');
      if (Number(count) < 1 || hasDiff < 1) throw new Error('changes panel empty (count=' + count + ')');
      return { count, cards: hasDiff };
    });

    await step('transcript-tool-cards', async () => {
      const cards = await js('[...document.querySelectorAll("#transcript .tool .tool-name")].map(e=>e.textContent)');
      const statuses = await js('[...document.querySelectorAll("#transcript .tool-status")].map(e=>e.textContent)');
      if (!cards.includes('read') || !cards.includes('write')) throw new Error('expected read+write tool cards, got ' + cards);
      if (statuses.some((s) => s !== 'done')) throw new Error('a tool card did not finish: ' + statuses);
      return { cards, statuses };
    });

    await step('slash-help', async () => {
      await sendPrompt('/help');
      const text = await js('window.__kestrel.transcript()');
      const notices = await js('document.querySelectorAll(".notice").length');
      if (!text.includes('Commands:') || !text.includes('/compact')) throw new Error('/help did not list commands');
      if (notices < 1) throw new Error('command reply was not rendered as a notice');
      return { notices };
    });

    await step('slash-init', async () => {
      const file = path.join(process.cwd(), 'KESTREL.md');
      fs.rmSync(file, { force: true });
      await sendPrompt('/init');
      const wrote = fs.existsSync(file);
      const body = wrote ? fs.readFileSync(file, 'utf8') : '';
      fs.rmSync(file, { force: true });
      if (!wrote || !body.includes('Project memory')) throw new Error('/init did not write KESTREL.md');
      return { bytes: body.length };
    });

    await step('plan-mode-tools', async () => {
      await sendPrompt('planmode');
      const text = await js('window.__kestrel.transcript()');
      const mode = await js('document.getElementById("mode").value');
      if (!text.includes('Proposed plan')) throw new Error('exit_plan_mode output missing');
      if (!text.includes('plan mode off')) throw new Error('plan mode did not turn off');
      if (mode !== 'default') throw new Error('mode select not restored: ' + mode);
      return { mode };
    });

    await step('sub-agent-task', async () => {
      await sendPrompt('delegate this');
      const cards = await js('[...document.querySelectorAll("#transcript .tool .tool-name")].map(e=>e.textContent)');
      const text = await js('window.__kestrel.transcript()');
      if (!cards.includes('task')) throw new Error('task tool card missing; saw ' + cards.join(','));
      if (!text.includes('Sub-agent report')) throw new Error('sub-agent output did not reach the transcript');
      return { cards: cards.filter((c) => c === 'task').length };
    });

    await step('notebook-edit', async () => {
      const file = path.join(process.cwd(), 'selfcheck', 'fixture', 'demo.ipynb');
      const original = fs.readFileSync(file, 'utf8');
      await sendPrompt('notebook');
      const nb = JSON.parse(fs.readFileSync(file, 'utf8'));
      const first = Array.isArray(nb.cells[0].source) ? nb.cells[0].source.join('') : nb.cells[0].source;
      // Leave the fixture as it was so the next run starts clean.
      fs.writeFileSync(file, original);
      if (!first.includes('edited by kestrel')) throw new Error('notebook cell was not updated: ' + first.slice(0, 60));
      return { cells: nb.cells.length, firstCell: first.slice(0, 40) };
    });

    await step('interrupt-keeps-partial', async () => {
      await sendPrompt('slow reply please', { waitTurn: false });
      await waitFor('slow turn streaming', 'window.__kestrel.streaming() === true', 8000);
      await sleep(220);
      await js('document.getElementById("stop").click(), true');
      await waitFor('turn stopped', 'window.__kestrel.streaming() === false', 10000);
      const text = await js('window.__kestrel.transcript()');
      if (!/This is/.test(text)) throw new Error('partial text was dropped from the window');
      const id = await js('window.__kestrel.sessionId()');
      const stored = sessions.load(id);
      const last = [...stored.messages].reverse().find((m) => m.role === 'assistant');
      if (!last || !last.content) throw new Error('partial assistant message was not saved');
      if ((last.toolCalls || []).length) throw new Error('interrupted turn kept a tool call');
      if (!last.content.startsWith('This is')) throw new Error('saved text is not the streamed prefix: ' + last.content.slice(0, 40));
      const full = 'This is a slow reply so the stop button can be tested before the sentence finishes.';
      if (last.content.length >= full.length) throw new Error('turn was not interrupted, it completed');
      return { partialChars: last.content.length, fullChars: full.length };
    });

    await step('permission-denied', async () => {
      const target = path.join(process.cwd(), 'selfcheck', 'fixture', 'denied.md');
      fs.rmSync(target, { force: true });
      const before = denials;
      denyNext = true;
      await sendPrompt('deny this');
      const text = await js('window.__kestrel.transcript()');
      const statuses = await js(
        '[...document.querySelectorAll("#transcript .tool")].slice(-1).map(c => c.querySelector(".tool-status").textContent)'
      );
      if (denials !== before + 1) throw new Error('the deny button was never used');
      if (fs.existsSync(target)) throw new Error('denied write still created the file');
      if (!text.includes('permission denied')) throw new Error('denial was not reported to the model');
      if (statuses[0] !== 'error') throw new Error('tool card did not show the failure: ' + statuses[0]);
      if (!text.includes('left the file alone')) throw new Error('the turn did not continue after the denial');
      return { denials, toolStatus: statuses[0] };
    });

    await step('shell-command', async () => {
      await sendPrompt('shell command');
      const entries = await js('document.querySelectorAll("#tab-terminal .term").length');
      const panel = await js('document.getElementById("tab-terminal").innerText');
      const badge = await js('document.getElementById("term-count").textContent');
      const id = await js('window.__kestrel.sessionId()');
      const stored = sessions.load(id);
      const lastRun = (stored.terminal || []).slice(-1)[0];
      if (entries < 1 || Number(badge) < 1) throw new Error('terminal panel has no entries: ' + entries);
      if (!panel.includes('echo kestrel-shell-ok')) throw new Error('command text missing from the terminal panel');
      if (!panel.includes('kestrel-shell-ok')) throw new Error('command output missing from the terminal panel');
      if (!lastRun || lastRun.code !== 0) throw new Error('recorded exit code was not 0: ' + JSON.stringify(lastRun && lastRun.code));

      // Show the panel and keep the picture as evidence, then go back to Changes.
      await js('document.querySelector(\'.tab[data-tab="terminal"]\').click(), true');
      await waitFor('terminal tab visible', '!document.getElementById("tab-terminal").classList.contains("hidden")', 5000);
      await shoot('terminal-panel');
      await js('document.querySelector(\'.tab[data-tab="changes"]\').click(), true');

      return { entries, exitCode: lastRun.code };
    });

    await step('compact', async () => {
      const id = await js('window.__kestrel.sessionId()');
      const before = sessions.load(id).messages.length;
      await sendPrompt('/compact');
      const after = sessions.load(id);
      const text = await js('window.__kestrel.transcript()');
      if (!text.includes('Compacted')) throw new Error('compaction notice missing');
      if (!(after.compactions >= 1)) throw new Error('compaction counter not recorded');
      if (!(after.messages.length < before)) throw new Error(`messages did not shrink (${before} → ${after.messages.length})`);
      if (!String(after.messages[0].content).includes('<compacted-context>')) throw new Error('summary message not first');
      return { before, after: after.messages.length, compactions: after.compactions };
    });

    await step('claude-cli-real', async () => {
      const { cliVersion } = require('../engine/claude');
      const version = cliVersion();
      if (!version) throw new Error('the installed Claude Code CLI was not found');

      await setProvider('claude-cli');
      await sendPrompt('say hi');
      const text = await js('window.__kestrel.transcript()');
      if (!text.includes('claude-cli')) throw new Error('init notice from the CLI never appeared');
      // No login exists on this machine, so the CLI must report that clearly.
      if (!/login/i.test(text)) throw new Error('the CLI error was not surfaced in the transcript');
      return { version, reported: text.includes('Not logged in') };
    });

    await step('claude-cli-stub', async () => {
      const stub = path.join(__dirname, 'stub', 'claude');
      if (!fs.existsSync(stub)) throw new Error('stub CLI missing at ' + stub);
      process.env.KESTREL_CLAUDE_BIN = stub;
      try {
        await setProvider('claude-cli');
        const before = sessions.load(await js('window.__kestrel.sessionId()')).usage.input;
        await sendPrompt('read the fixture');
        const text = await js('window.__kestrel.transcript()');
        const cards = await js(
          '[...document.querySelectorAll("#transcript .tool")].slice(-1).map(c => ({n: c.querySelector(".tool-name").textContent, s: c.querySelector(".tool-status").textContent, b: c.querySelector(".tool-body").textContent}))'
        );
        const stored = sessions.load(await js('window.__kestrel.sessionId()'));
        if (!text.includes('Hello from the Claude CLI stub')) throw new Error('streamed CLI text missing');
        if (!text.includes('read the fixture through the CLI')) throw new Error('final CLI text missing');
        if (!cards[0] || cards[0].n !== 'Read') throw new Error('tool card for the CLI call missing: ' + JSON.stringify(cards[0]));
        if (cards[0].s !== 'done') throw new Error('CLI tool card did not finish: ' + cards[0].s);
        if (!cards[0].b.includes('Kestrel self-check fixture')) throw new Error('tool result text missing from the card');
        if (stored.usage.input - before !== 42) throw new Error(`CLI usage was not recorded (delta ${stored.usage.input - before})`);
        if (!(stored.cost > 0)) throw new Error('CLI cost was not recorded');
        await shoot('claude-cli-transcript');
        return { tool: cards[0].n, usageDelta: stored.usage.input - before, cost: stored.cost };
      } finally {
        delete process.env.KESTREL_CLAUDE_BIN;
        await setProvider('pretend');
      }
    });

    const withStub = async (fn) => {
      const stub = path.join(__dirname, 'stub', 'claude');
      process.env.KESTREL_CLAUDE_BIN = stub;
      try {
        await setProvider('claude-cli');
        return await fn();
      } finally {
        delete process.env.KESTREL_CLAUDE_BIN;
        await setProvider('pretend');
      }
    };

    await step('claude-cli-permission-allow', async () => {
      const target = path.join(process.cwd(), 'selfcheck', 'fixture', 'bridged-allow.md');
      fs.rmSync(target, { force: true });
      return await withStub(async () => {
        pauseApprovals = true;
        await sendPrompt('bridge-allow', { waitTurn: false });
        await waitFor('CLI permission dialog', '!document.getElementById("permission").classList.contains("hidden")', 15000);
        const asked = await js('document.getElementById("perm-input").textContent');
        await shoot('permission-dialog-cli');
        await js('document.getElementById("perm-allow").click(), true');
        pauseApprovals = false;
        await waitFor('bridged turn finished', 'window.__kestrel.streaming() === false', 20000);

        const text = await js('window.__kestrel.transcript()');
        if (!asked.includes('bridged-allow.md')) throw new Error('the dialog did not show the CLI tool input');
        if (!text.includes('the CLI saw: allow')) throw new Error('the CLI did not receive an allow answer');
        if (!fs.existsSync(target)) throw new Error('the CLI did not act on the allow (file missing)');
        const body = fs.readFileSync(target, 'utf8');
        if (!body.includes('written by the stub CLI')) throw new Error('allowed write had the wrong content');
        return { dialog: true, askedFor: 'bridged-allow.md', file: path.relative(ROOT, target), bytes: body.length };
      });
    });

    await step('claude-cli-permission-deny', async () => {
      const target = path.join(process.cwd(), 'selfcheck', 'fixture', 'bridged-deny.md');
      fs.rmSync(target, { force: true });
      return await withStub(async () => {
        const before = denials;
        denyNext = true;
        await sendPrompt('bridge-deny');
        const text = await js('window.__kestrel.transcript()');
        if (denials === before) throw new Error('the deny button was never used for the CLI request');
        if (!text.includes('the CLI saw: deny')) throw new Error('the CLI did not receive a deny answer');
        if (fs.existsSync(target)) throw new Error('the CLI wrote the file even though it was denied');
        return { dialog: true, fileAbsent: true };
      });
    });

    await step('claude-cli-permission-session', async () => {
      const one = path.join(process.cwd(), 'selfcheck', 'fixture', 'session-one.md');
      const two = path.join(process.cwd(), 'selfcheck', 'fixture', 'session-two.md');
      fs.rmSync(one, { force: true });
      fs.rmSync(two, { force: true });

      return await withStub(async () => {
        const permitsBefore = permits;
        const denialsBefore = denials;

        pauseApprovals = true;
        await sendPrompt('bridge-session', { waitTurn: false });
        await waitFor('first CLI dialog', '!document.getElementById("permission").classList.contains("hidden")', 15000);
        await js('document.getElementById("perm-session").click(), true');
        pauseApprovals = false;
        await waitFor('session turn finished', 'window.__kestrel.streaming() === false', 20000);

        const text = await js('window.__kestrel.transcript()');
        const stillOpen = await js('!document.getElementById("permission").classList.contains("hidden")');

        // The second request must never have reached the dialog.
        if (permits !== permitsBefore) throw new Error('a second dialog was auto-approved: ' + (permits - permitsBefore));
        if (denials !== denialsBefore) throw new Error('a second dialog was auto-denied');
        if (stillOpen) throw new Error('a permission dialog is still open');
        if (!text.includes('allowed Write for this session (CLI)')) {
          throw new Error('the adapter did not report a session allowance');
        }
        if (!text.includes('two writes: allow, allow')) {
          throw new Error('the second CLI request was not allowed: ' + (text.match(/two writes:[^\n]*/) || ['(missing)'])[0]);
        }
        if (!fs.existsSync(one) || !fs.existsSync(two)) throw new Error('not both files were written');

        return { dialogs: 1, permitsDelta: permits - permitsBefore, files: 2 };
      });
    });

    await step('mode-switch', async () => {
      await js(
        `(() => { const m = document.getElementById('mode'); m.value = 'plan'; m.dispatchEvent(new Event('change')); return true; })()`
      );
      await sleep(500);
      const status = await js('document.getElementById("status-mode").textContent');
      await js(
        `(() => { const m = document.getElementById('mode'); m.value = 'default'; m.dispatchEvent(new Event('change')); return true; })()`
      );
      if (!status.includes('plan')) throw new Error('mode did not switch: ' + status);
      return { status };
    });

    await step('rename-session', async () => {
      await js('document.getElementById("session-title").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
      await sleep(300);
      await waitFor('rename dialog', 'Boolean(document.getElementById("rename-input"))', 8000);
      await js(
        `(() => { const i = document.getElementById('rename-input'); i.value = 'Self-check run'; i.dispatchEvent(new Event('input')); return true; })()`
      );
      await js('document.getElementById("rename-save").click(), true');
      await sleep(600);
      const title = await js('document.getElementById("session-title").textContent');
      if (title !== 'Self-check run') throw new Error('title not applied: ' + title);
      return { title };
    });

    await step('saved-and-resumable', async () => {
      const id = await js('window.__kestrel.sessionId()');
      const stored = sessions.load(id);
      if (!stored) throw new Error('session file missing after the run');
      if (!stored.messages.some((m) => m.role === 'assistant')) throw new Error('assistant messages not persisted');
      if (!(stored.edits || []).length) throw new Error('edits not persisted');
      if (stored.title !== 'Self-check run') throw new Error('rename not persisted');
      const listed = sessions.list().some((s) => s.id === id);
      if (!listed) throw new Error('session missing from the sidebar listing');
      return { id, messages: stored.messages.length, edits: stored.edits.length, usage: stored.usage };
    });

    await step('restart-resume', async () => {
      // Reload the renderer the way a restart would, then reopen the session.
      await js('location.reload(), true');
      await waitFor('renderer reloaded', 'document.documentElement.dataset.ready === "1"', 25000);
      const id = evidence.proof['saved-and-resumable'].id;
      await js(`window.kestrel.session.open(${JSON.stringify(id)})`);
      await js('location.reload(), true');
      await waitFor('renderer reloaded again', 'document.documentElement.dataset.ready === "1"', 25000);
      await js(`window.kestrel.session.open(${JSON.stringify(id)})`);
      await sleep(800);
      const sessionsInList = await js('document.querySelectorAll("#session-list .session-item").length');
      return { id, sessionsInList };
    });

    await step('memory', async () => {
      const metrics = app.getAppMetrics();
      const total = metrics.reduce((sum, m) => sum + (m.memory ? m.memory.workingSetSize : 0), 0);
      return { total, processes: metrics.length, workingSetMiB: Math.round(total / 1024) };
    });

    await shoot('final');
    evidence.ok = true;
  } catch (err) {
    evidence.ok = false;
    evidence.fatal = String(err && err.stack ? err.stack : err);
    if (!evidence.screenshots.some((s) => s.includes('error-'))) await shoot('error-final');
  } finally {
    if (poller) clearInterval(poller);
    evidence.finishedAt = new Date().toISOString();
    evidence.durationMs = Date.now() - started.getTime();
    evidence.node = process.versions.node;
    evidence.electron = process.versions.electron;
    evidence.display = process.env.DISPLAY || null;
    const file = path.join(CHECKS, 'last-run.json');
    fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(evidence, null, 2));
    console.log(`SELFCHECK ${evidence.ok ? 'PASS' : 'FAIL'} ${steps.length} steps, ${evidence.errors.length} errors`);
    for (const s of steps) console.log(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.name} (${s.ms}ms)${s.error ? ' :: ' + s.error : ''}`);
    app.exit(evidence.ok ? 0 : 1);
  }
}

module.exports = { run };
