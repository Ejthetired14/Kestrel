#!/usr/bin/env node
// Self-check runner. Starts a private virtual display if there is none, launches
// the real app with --selfcheck, then exercises the CLI mode, and prints a summary.
//   node selfcheck/run.js [--keep-display]
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const APP = path.join(__dirname, '..');
const ROOT = path.join(APP, '..');
const CHECKS = path.join(ROOT, 'checks');
const started = new Date();

function log(line) {
  process.stdout.write(line + '\n');
}

function ensureFonts() {
  const fontDir = path.join(APP, 'vendor/fonts/usr/share/fonts/truetype/dejavu');
  if (!fs.existsSync(fontDir)) return null;
  const conf = path.join(APP, 'vendor/fonts.conf');
  if (!fs.existsSync(conf)) {
    fs.writeFileSync(
      conf,
      `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontDir}</dir>
  <cachedir>/tmp/kestrel-fontconfig</cachedir>
  <alias><family>sans-serif</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>monospace</family><prefer><family>DejaVu Sans Mono</family></prefer></alias>
</fontconfig>
`
    );
  }
  return conf;
}

function vendorEnv() {
  const root = path.join(APP, 'vendor/x11root');
  const fontConf = ensureFonts();
  return {
    ...(fontConf ? { FONTCONFIG_FILE: fontConf } : {}),
    LD_LIBRARY_PATH: [
      path.join(root, 'usr/lib/x86_64-linux-gnu'),
      path.join(root, 'lib/x86_64-linux-gnu'),
      process.env.LD_LIBRARY_PATH || '',
    ]
      .filter(Boolean)
      .join(':'),
    PATH: [path.join(root, 'usr/bin'), process.env.PATH || ''].filter(Boolean).join(':'),
  };
}

async function startXvfb(number = 99) {
  const bin = path.join(APP, 'vendor/x11root/usr/bin/Xvfb-patched');
  const xkb = path.join(APP, 'vendor/x11root/usr/share/X11/xkb');
  if (!fs.existsSync(bin)) return null;
  const display = `:${number}`;
  try {
    fs.mkdirSync('/tmp/.X11-unix', { recursive: true });
    fs.rmSync(`/tmp/.X${number}-lock`, { force: true });
  } catch {
    /* ignore */
  }
  const proc = spawn(bin, [display, '-screen', '0', '1280x900x24', '-xkbdir', xkb, '-nolisten', 'tcp', '-ac'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...vendorEnv() },
  });
  let err = '';
  proc.stderr.on('data', (d) => (err += d.toString()));
  proc.stdout.on('data', () => {});

  const socket = `/tmp/.X11-unix/X${number}`;
  for (let i = 0; i < 50; i++) {
    if (proc.exitCode !== null) break;
    if (fs.existsSync(socket)) return { proc, display, socket };
    await new Promise((r) => setTimeout(r, 100));
  }
  log('display: Xvfb did not come up ' + (err ? '(' + err.split('\n')[0] + ')' : '(no socket)'));
  proc.kill();
  return null;
}

function runElectron(display) {
  return new Promise((resolve) => {
    const electron = path.join(APP, 'node_modules/.bin/electron');
    const env = { ...process.env };
    if (display) env.DISPLAY = display;
    Object.assign(env, vendorEnv());
    env.ELECTRON_DISABLE_SANDBOX = '1';

    const proc = spawn(electron, ['--no-sandbox', '--selfcheck', 'main.js'], {
      cwd: APP,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(d);
    });
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      out += s;
      if (!/dbus|Failed to connect to the bus|gpu|GLES|libva|Vulkan/i.test(s)) process.stderr.write(s);
    });
    const timer = setTimeout(() => {
      log('electron: timeout after 180s, terminating');
      proc.kill('SIGKILL');
    }, 180000);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

function runKeystore() {
  const res = spawnSync(process.execPath, [path.join(__dirname, 'keystore-check.js')], {
    encoding: 'utf8',
    timeout: 30000,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    /* keep null */
  }
  return { ok: res.status === 0 && Boolean(parsed && parsed.ok), checks: parsed ? parsed.checks : [], stderr: String(res.stderr).slice(0, 400) };
}

function runCLI() {
  const res = spawnSync(
    process.execPath,
    [path.join(APP, 'cli.js'), '-p', 'Summarise the fixture', '--provider', 'pretend', '--yes', '--output-format', 'json'],
    { cwd: APP, encoding: 'utf8', timeout: 60000 }
  );
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    /* keep null */
  }
  const help = spawnSync(process.execPath, [path.join(APP, 'cli.js'), '-p', '/help'], {
    cwd: APP,
    encoding: 'utf8',
    timeout: 30000,
  });
  const helpOk = help.status === 0 && String(help.stdout).includes('Commands:');

  return {
    ok: res.status === 0 && Boolean(parsed && parsed.ok) && helpOk,
    ok: res.status === 0 && Boolean(parsed && parsed.ok) && helpOk,
    status: res.status,
    text: parsed ? parsed.text.slice(0, 160) : String(res.stdout).slice(0, 300),
    slashCommand: { ok: helpOk, status: help.status },
    stderr: String(res.stderr).slice(0, 600),
  };
}

(async () => {
  fs.mkdirSync(CHECKS, { recursive: true });
  const report = { startedAt: started.toISOString(), cli: null, gui: null, ok: false };

  // Isolated state: the self-check must never touch the real sessions or keys.
  const configHome = path.join(CHECKS, 'config');
  fs.rmSync(path.join(configHome, 'kestrel', 'sessions'), { recursive: true, force: true });
  process.env.XDG_CONFIG_HOME = configHome;

  let display = process.env.DISPLAY;
  let xvfb = null;
  if (!display) {
    for (const n of [99, 98, 97]) {
      xvfb = await startXvfb(n);
      if (xvfb) break;
    }
    if (xvfb) {
      display = xvfb.display;
      log(`display: started private Xvfb on ${display} (socket ready)`);
    } else {
      log('display: none available and Xvfb helper missing — window check cannot run');
    }
  } else {
    log('display: using ' + display);
  }

  if (display) {
    log('gui: launching the app…');
    const res = await runElectron(display);
    report.gui = { code: res.code, pass: res.code === 0 };
    log('gui: exit ' + res.code);
  } else {
    report.gui = { code: null, pass: false, reason: 'no display' };
  }

  log('cli: running print mode with the pretend provider…');
  report.cli = runCLI();
  log(`cli: ${report.cli.ok ? 'pass' : 'FAIL'} (exit ${report.cli.status})`);

  log('cli: running print mode with the pretend provider…');
  report.cli = runCLI();
  log(`cli: ${report.cli.ok ? 'pass' : 'FAIL'} (exit ${report.cli.status})`);

  log('keys: checking the encrypted store…');
  report.keystore = runKeystore();
  log(`keys: ${report.keystore.ok ? 'pass' : 'FAIL'}`);

  const last = path.join(CHECKS, 'last-run.json');
  if (fs.existsSync(last)) report.guiDetail = JSON.parse(fs.readFileSync(last, 'utf8'));

  report.ok = Boolean(report.gui && report.gui.pass && report.cli.ok && report.keystore && report.keystore.ok);
  report.ok = Boolean(report.gui && report.gui.pass && report.cli.ok && report.keystore && report.keystore.ok);

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - started.getTime();
  fs.writeFileSync(path.join(CHECKS, 'summary.json'), JSON.stringify(report, null, 2));

  if (xvfb) {
    xvfb.proc.kill();
    log('display: stopped');
  }

  log('');
  log(report.ok ? 'SELFCHECK RESULT: PASS' : 'SELFCHECK RESULT: FAIL');
  process.exit(report.ok ? 0 : 1);
})();
