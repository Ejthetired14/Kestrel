// System prompt assembly. Our own wording; nothing is taken from another tool.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { offeredTools } = require('./loop');

function safeRead(p, max = 8000) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function gitSummary(cwd) {
  const { execFileSync } = require('node:child_process');
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd, timeout: 1500 }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd, timeout: 1500 }).toString().trim();
    return `git: branch=${branch || '(detached)'} changes=${dirty ? dirty.split('\n').length : 0}`;
  } catch {
    return 'git: not a repository';
  }
}

function memory(cwd) {
  for (const name of ['KESTREL.md', 'AGENTS.md']) {
    const text = safeRead(path.join(cwd, name));
    if (text) return { name, text };
  }
  return null;
}

function buildSystemPrompt({ cwd, mode, providerId, model, todos }) {
  const toolLines = offeredTools(mode)
    .map((t) => `- ${t.name}: ${t.description}`)
    .join('\n');

  const mem = memory(cwd);
  const date = new Date().toISOString().slice(0, 10);

  return [
    'You are Kestrel, a coding agent inside a desktop app.',
    'You work by reading the project, making small deliberate changes, and explaining what you did.',
    '',
    '## Environment',
    `- working directory: ${cwd}`,
    `- platform: ${os.platform()} ${os.release()}`,
    `- date: ${date}`,
    `- ${gitSummary(cwd)}`,
    `- provider: ${providerId}  model: ${model}`,
    `- mode: ${mode}${mode === 'plan' ? ' (read-only: you may not write or run commands)' : ''}`,
    '',
    '## Tools',
    toolLines,
    '',
    '## How to work',
    '- Read a file before you edit it; never guess at its contents.',
    '- Keep changes as small as the request allows, and prefer the edit tool over rewriting a whole file.',
    '- Use todo_write when the work has more than two steps.',
    '- Independent tool calls may be issued together; they run concurrently.',
    '- If a tool fails, say so plainly and adapt; never claim work you did not do.',
    '- When you are done, state what changed and how it can be checked.',
    '',
    todos && todos.length
      ? '## Current task list\n' + todos.map((t) => `- [${t.status}] ${t.content}`).join('\n')
      : '',
    '',
    mem ? `## Project memory (${mem.name})\n${mem.text}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = { buildSystemPrompt };
