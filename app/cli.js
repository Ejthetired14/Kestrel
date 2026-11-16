#!/usr/bin/env node
// Kestrel command-line mode.
//   kestrel -p "prompt" [--output-format text|json|stream-json] [--model id]
//           [--provider pretend|gemini|openrouter|nvidia] [--cwd dir]
//           [--max-turns n] [--yes] [--mode default|acceptEdits|plan|bypassPermissions]
'use strict';

const path = require('node:path');
const { runTurn } = require('./engine/loop');
const { buildSystemPrompt } = require('./engine/prompt');
const sessions = require('./engine/sessions');
const commands = require('./engine/commands');

function parseArgs(argv) {
  const out = {
    prompt: null,
    outputFormat: 'text',
    provider: 'pretend',
    model: 'pretend-1',
    cwd: process.cwd(),
    maxTurns: 12,
    yes: false,
    mode: 'default',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '-p' || a === '--print') out.prompt = next();
    else if (a === '--output-format') out.outputFormat = next();
    else if (a === '--model') out.model = next();
    else if (a === '--provider') out.provider = next();
    else if (a === '--cwd') out.cwd = path.resolve(next());
    else if (a === '--max-turns') out.maxTurns = Number(next());
    else if (a === '--mode') out.mode = next();
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('-') && !out.prompt) out.prompt = a;
  }
  return out;
}

function usage() {
  return [
    'kestrel -p "prompt" [options]',
    '',
    '  --output-format text|json|stream-json',
    '  --provider pretend|gemini|openrouter|nvidia   (default pretend)',
    '  --model <id>                                  (default pretend-1)',
    '  --mode default|acceptEdits|plan|bypassPermissions',
    '  --cwd <dir>                                   working directory',
    '  --max-turns <n>                               loop cap',
    '  --yes                                         allow tools without prompting',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.prompt) {
    process.stdout.write(usage() + '\n');
    process.exit(args.help ? 0 : 2);
  }

  const session = sessions.create({
    cwd: args.cwd,
    provider: args.provider,
    model: args.model,
    mode: args.mode,
    title: args.prompt.slice(0, 60),
  });

  // Slash commands work the same way in print mode.
  if (args.prompt.startsWith('/')) {
    const result = await commands.handle(args.prompt, {
      cwd: args.cwd,
      session,
      compact: async () => 'compaction is only available in the desktop app',
      getMode: () => args.mode,
      setMode: (m) => (args.mode = m),
      setModel: (m) => (args.model = m),
      listSessions: sessions.list,
      openSession: () => null,
    });
    if (result) {
      if (result.text) process.stdout.write(result.text + '\n');
      if (result.prompt) args.prompt = result.prompt;
      else process.exit(0);
    }
  }

  session.messages.push({ role: 'user', content: args.prompt });

  const json = args.outputFormat === 'stream-json';
  const collect = args.outputFormat === 'json';
  const collected = [];

  const emit = (obj) => {
    if (json) process.stdout.write(JSON.stringify({ ts: Date.now(), ...obj }) + '\n');
    else if (collect) collected.push(obj);
  };

  const result = await runTurn({
    providerId: args.provider,
    model: args.model,
    system: buildSystemPrompt({
      cwd: session.cwd,
      mode: args.mode,
      providerId: args.provider,
      model: args.model,
    }),
    messages: session.messages,
    mode: args.mode,
    session,
    onEvent: (ev) => {
      emit(ev);
      if (ev.type === 'text' && args.outputFormat === 'text') process.stdout.write(ev.text);
      if (ev.type === 'error' && args.outputFormat === 'text') process.stderr.write('\nerror: ' + ev.message + '\n');
    },
    approve: async (call) => {
      if (args.yes || args.mode === 'bypassPermissions') return 'allow';
      return 'deny';
    },
  });

  sessions.save(session);

  if (args.outputFormat === 'text') process.stdout.write('\n');
  if (collect) {
    const text = collected.filter((e) => e.type === 'text').map((e) => e.text).join('');
    process.stdout.write(JSON.stringify({ ok: result.ok, text, session: session.id, usage: session.usage }, null, 2) + '\n');
  }
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write('kestrel: ' + (err && err.message) + '\n');
  process.exit(1);
});
