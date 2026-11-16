// Slash commands: built-ins plus user commands loaded from markdown files.
// A command either answers immediately or expands into a normal prompt.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { configDir } = require('./keys');

const BUILTINS = [
  ['help', 'list commands'],
  ['clear', 'empty this conversation (keeps the session)'],
  ['compact', 'summarise the conversation and shorten it'],
  ['model', 'show or switch model: /model <id>'],
  ['mode', 'show or switch mode: /mode default|acceptEdits|plan|bypassPermissions'],
  ['cost', 'token totals for this session'],
  ['resume', 'list sessions, or /resume <id> to open one'],
  ['init', 'write a KESTREL.md project memory file'],
  ['quit', 'close the app'],
];

function readCommandFile(file) {
  const body = fs.readFileSync(file, 'utf8');
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let description = '';
  let template = body;
  if (fm) {
    const d = fm[1].match(/description:\s*(.+)/);
    if (d) description = d[1].trim();
    template = body.slice(fm[0].length);
  }
  return { description, template };
}

/** User commands from ~/.config/kestrel/commands and <cwd>/.kestrel/commands. */
function userCommands(cwd) {
  const dirs = [path.join(configDir(), 'commands'), path.join(cwd, '.kestrel', 'commands')];
  const found = {};
  for (const dir of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const { description, template } = readCommandFile(path.join(dir, f));
        found[f.replace(/\.md$/, '')] = { description, template, source: path.join(dir, f) };
      } catch {
        /* unreadable command file: skip */
      }
    }
  }
  return found;
}

function helpText(cwd) {
  const custom = userCommands(cwd);
  const lines = ['Commands:', ...BUILTINS.map(([name, desc]) => `  /${name.padEnd(9)} ${desc}`)];
  const names = Object.keys(custom);
  if (names.length) {
    lines.push('', 'From .kestrel/commands or ~/.config/kestrel/commands:');
    for (const n of names) lines.push(`  /${n.padEnd(9)} ${custom[n].description || '(no description)'}`);
  }
  return lines.join('\n');
}

function initMemory(cwd) {
  const file = path.join(cwd, 'KESTREL.md');
  if (fs.existsSync(file)) return `KESTREL.md already exists (${file}).`;
  const body = [
    '# Project memory',
    '',
    'Notes Kestrel reads at the start of every session in this folder.',
    '',
    '## What this project is',
    '',
    '## How to build and test',
    '',
    '## Conventions',
    '',
  ].join('\n');
  fs.writeFileSync(file, body);
  return `Wrote ${file}.`;
}

/**
 * Handle one slash command.
 * @returns null when the text is not a command, else
 *          { text?: string, prompt?: string, quit?: boolean }
 */
async function handle(text, ctx) {
  const m = String(text).match(/^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const args = (m[2] || '').trim();

  switch (name) {
    case 'help':
      return { text: helpText(ctx.cwd) };
    case 'clear':
      ctx.session.messages = [];
      ctx.session.edits = [];
      ctx.session.terminal = [];
      return { text: 'Cleared this conversation.' };
    case 'compact':
      return { text: await ctx.compact() };
    case 'model':
      if (!args) return { text: `model: ${ctx.session.provider}/${ctx.session.model}` };
      ctx.setModel(args);
      return { text: `model → ${args}` };
    case 'mode':
      if (!args) return { text: `mode: ${ctx.getMode()}` };
      ctx.setMode(args);
      return { text: `mode → ${args}` };
    case 'cost': {
      const u = ctx.session.usage || { input: 0, output: 0, turns: 0 };
      return {
        text: `${u.turns} turns · ${u.input} input tokens · ${u.output} output tokens\nCost estimates need per-model pricing and are not shown yet.`,
      };
    }
    case 'resume': {
      if (!args) {
        const list = ctx.listSessions();
        if (!list.length) return { text: 'No saved sessions.' };
        return {
          text:
            ['Recent sessions:', ...list.slice(0, 8).map((s) => `  ${s.id}  ${s.title}`)].join('\n') +
            '\nUse /resume <id> to open one.',
        };
      }
      const opened = ctx.openSession(args);
      return opened ? { text: `Opened ${opened.title}` } : { text: `No session with id ${args}` };
    }
    case 'init':
      return { text: initMemory(ctx.cwd) };
    case 'quit':
      return { quit: true, text: 'Closing.' };
    default: {
      const cmd = userCommands(ctx.cwd)[name];
      if (!cmd) return { text: `Unknown command /${name}. Try /help.` };
      return { prompt: cmd.template.replace(/\$ARGUMENTS\b/g, args).trim() };
    }
  }
}

module.exports = { handle, helpText, userCommands, BUILTINS };
