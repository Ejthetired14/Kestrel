// Tool implementations. Every tool validates input, stays inside the session
// working directory, and reports failure as a normal result instead of throwing.
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const MAX_OUTPUT = 30000;
const background = new Map(); // id -> {proc, out, code, done}

function truncate(text) {
  if (typeof text !== 'string') text = String(text);
  if (text.length <= MAX_OUTPUT) return { text, truncated: false };
  return {
    text: text.slice(0, MAX_OUTPUT) + `\n… [truncated ${text.length - MAX_OUTPUT} chars]`,
    truncated: true,
  };
}

function resolveInside(root, p) {
  const base = path.resolve(root);
  const target = path.resolve(base, p || '.');
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes the working directory: ${p}`);
  }
  return target;
}

const tools = [
  {
    name: 'read',
    description:
      'Read a text file from the working directory. Returns numbered lines. Use offset/limit for large files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the working directory.' },
        offset: { type: 'number', description: '1-based first line.' },
        limit: { type: 'number', description: 'Maximum lines to return.' },
      },
      required: ['path'],
    },
    async run(input, ctx) {
      const file = resolveInside(ctx.cwd, input.path);
      const st = await fsp.stat(file);
      if (!st.isFile()) throw new Error('not a regular file');
      if (st.size > 2_000_000) throw new Error('file too large to read (>2 MB)');
      const text = await fsp.readFile(file, 'utf8');
      const lines = text.split('\n');
      const start = Math.max(0, (input.offset || 1) - 1);
      const end = input.limit ? start + input.limit : lines.length;
      const slice = lines.slice(start, end);
      const body = slice.map((l, i) => `${start + i + 1}\t${l}`).join('\n');
      ctx.edits; // no-op
      return {
        output: truncate(body || '(empty file)').text,
        meta: { lines: lines.length, bytes: st.size },
      };
    },
  },
  {
    name: 'write',
    description: 'Create or overwrite a file with the given content.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    requiresApproval: true,
    async run(input, ctx) {
      const file = resolveInside(ctx.cwd, input.path);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const before = fs.existsSync(file) ? await fsp.readFile(file, 'utf8') : '';
      await fsp.writeFile(file, input.content, 'utf8');
      ctx.recordEdit({ path: input.path, before, after: input.content, kind: 'write' });
      return { output: `wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}` };
    },
  },
  {
    name: 'edit',
    description:
      'Replace an exact string in a file. Fails when the old string is missing or appears more than once (unless replace_all).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    requiresApproval: true,
    async run(input, ctx) {
      const file = resolveInside(ctx.cwd, input.path);
      const before = await fsp.readFile(file, 'utf8');
      const count = before.split(input.old_string).length - 1;
      if (count === 0) throw new Error('old_string not found in ' + input.path);
      if (count > 1 && !input.replace_all) {
        throw new Error(`old_string appears ${count} times; add more context or set replace_all`);
      }
      const after = input.replace_all
        ? before.split(input.old_string).join(input.new_string)
        : before.replace(input.old_string, input.new_string);
      await fsp.writeFile(file, after, 'utf8');
      ctx.recordEdit({ path: input.path, before, after, kind: 'edit' });
      return { output: `edited ${input.path} (${count} replacement${count > 1 ? 's' : ''})` };
    },
  },
  {
    name: 'multi_edit',
    description: 'Apply several exact-string edits to one file, in order.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { old_string: { type: 'string' }, new_string: { type: 'string' } },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['path', 'edits'],
    },
    requiresApproval: true,
    async run(input, ctx) {
      const file = resolveInside(ctx.cwd, input.path);
      const before = await fsp.readFile(file, 'utf8');
      let after = before;
      for (const [i, e] of input.edits.entries()) {
        if (!after.includes(e.old_string)) throw new Error(`edit ${i + 1}: old_string not found`);
        after = after.replace(e.old_string, e.new_string);
      }
      await fsp.writeFile(file, after, 'utf8');
      ctx.recordEdit({ path: input.path, before, after, kind: 'multi_edit' });
      return { output: `applied ${input.edits.length} edits to ${input.path}` };
    },
  },
  {
    name: 'ls',
    description: 'List a directory.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
    async run(input, ctx) {
      const dir = resolveInside(ctx.cwd, input.path || '.');
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const lines = entries
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name));
      return { output: lines.join('\n') || '(empty)' };
    },
  },
  {
    name: 'glob',
    description: 'Find files by glob pattern (supports * and **), newest first.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
      required: ['pattern'],
    },
    async run(input, ctx) {
      const root = resolveInside(ctx.cwd, input.path || '.');
      const found = [];
      const rx = globToRegExp(input.pattern);
      async function walk(dir, depth) {
        if (depth > 12) return;
        let entries;
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const full = path.join(dir, e.name);
          const rel = path.relative(root, full).split(path.sep).join('/');
          if (e.isDirectory()) await walk(full, depth + 1);
          else if (rx.test(rel)) found.push(rel);
        }
      }
      await walk(root, 0);
      return { output: found.slice(0, 500).join('\n') || 'no matches', meta: { count: found.length } };
    },
  },
  {
    name: 'grep',
    description: 'Search file contents with a regular expression.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        ignore_case: { type: 'boolean' },
        max: { type: 'number' },
      },
      required: ['pattern'],
    },
    async run(input, ctx) {
      const root = resolveInside(ctx.cwd, input.path || '.');
      const max = input.max || 200;
      let rx;
      try {
        rx = new RegExp(input.pattern, input.ignore_case ? 'i' : '');
      } catch (e) {
        throw new Error('bad pattern: ' + e.message);
      }
      const hits = [];
      async function walk(dir, depth) {
        if (depth > 10 || hits.length >= max) return;
        let entries;
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (hits.length >= max) return;
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            await walk(full, depth + 1);
            continue;
          }
          let st;
          try {
            st = await fsp.stat(full);
          } catch {
            continue;
          }
          if (st.size > 1_000_000) continue;
          let text;
          try {
            text = await fsp.readFile(full, 'utf8');
          } catch {
            continue;
          }
          if (text.includes('\u0000')) continue;
          const rel = path.relative(root, full);
          text.split('\n').forEach((line, i) => {
            if (hits.length < max && rx.test(line)) hits.push(`${rel}:${i + 1}: ${line.slice(0, 240)}`);
          });
        }
      }
      await walk(root, 0);
      return { output: hits.join('\n') || 'no matches', meta: { count: hits.length } };
    },
  },
  {
    name: 'bash',
    description:
      'Run a shell command in the working directory. Returns stdout, stderr and exit code. Use run_in_background for long jobs.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'number' },
        run_in_background: { type: 'boolean' },
      },
      required: ['command'],
    },
    requiresApproval: true,
    async run(input, ctx) {
      if (input.run_in_background) {
        const id = 'bg_' + Math.random().toString(36).slice(2, 8);
        const proc = spawn('bash', ['-c', input.command], { cwd: ctx.cwd });
        const rec = { proc, out: '', code: null };
        proc.stdout.on('data', (d) => (rec.out += d.toString()));
        proc.stderr.on('data', (d) => (rec.out += d.toString()));
        proc.on('close', (code) => (rec.code = code));
        background.set(id, rec);
        ctx.recordTerminal({ command: input.command, output: `[background ${id}]`, code: null });
        return { output: `started in background as ${id}` };
      }
      const timeout = Math.min(Math.max(input.timeout_ms || 120000, 1000), 600000);
      return await new Promise((resolve) => {
        execFile(
          'bash',
          ['-c', input.command],
          { cwd: ctx.cwd, timeout, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout, stderr) => {
            const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
            const combined = [stdout, stderr].filter(Boolean).join('\n');
            const t = truncate(combined || '(no output)');
            ctx.recordTerminal({ command: input.command, output: t.text, code });
            resolve({
              output: `${t.text}\n[exit ${code}]`,
              isError: code !== 0,
              meta: { exitCode: code, truncated: t.truncated },
            });
          }
        );
      });
    },
  },
  {
    name: 'bash_output',
    description: 'Read the output of a background shell started with bash.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run(input) {
      const rec = background.get(input.id);
      if (!rec) throw new Error('no such background shell: ' + input.id);
      return {
        output: `${truncate(rec.out || '(no output yet)').text}\n[running=${rec.code === null} exit=${rec.code}]`,
      };
    },
  },
  {
    name: 'bash_kill',
    description: 'Stop a background shell started with bash.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    requiresApproval: true,
    async run(input) {
      const rec = background.get(input.id);
      if (!rec) throw new Error('no such background shell: ' + input.id);
      rec.proc.kill();
      background.delete(input.id);
      return { output: `killed ${input.id}` };
    },
  },
  {
    name: 'todo_write',
    description: 'Replace the session task list. Each item has content and status.',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    async run(input, ctx) {
      ctx.setTodos(input.todos || []);
      return { output: `task list updated (${(input.todos || []).length} items)` };
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a URL and return its text content.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, prompt: { type: 'string' } },
      required: ['url'],
    },
    async run(input) {
      const url = String(input.url);
      if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) URLs are allowed');
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20000);
      try {
        const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
        const type = res.headers.get('content-type') || '';
        if (!/text|json|xml/.test(type)) throw new Error('unsupported content type: ' + type);
        const raw = await res.text();
        const text = raw
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return { output: truncate(`HTTP ${res.status} ${url}\n\n${text}`).text };
      } finally {
        clearTimeout(timer);
      }
    },
  },
  {
    name: 'task',
    description:
      'Delegate a read-only investigation to a sub-agent with its own context. Give it a self-contained prompt; it returns a report.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short label for the task.' },
        prompt: { type: 'string', description: 'Everything the sub-agent needs to start.' },
      },
      required: ['description', 'prompt'],
    },
    async run(input, ctx) {
      if (typeof ctx.subAgent !== 'function') throw new Error('sub-agents are unavailable in this context');
      const report = await ctx.subAgent({ description: input.description, prompt: input.prompt });
      return { output: report || 'sub-agent produced no report', meta: { description: input.description } };
    },
  },
  {
    name: 'notebook_edit',
    description:
      'Read or edit a Jupyter notebook (.ipynb). action=read lists cells; replace/insert/delete change one cell by index.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        action: { type: 'string', enum: ['read', 'replace', 'insert', 'delete'] },
        cell_index: { type: 'number' },
        cell_type: { type: 'string', enum: ['code', 'markdown'] },
        source: { type: 'string' },
      },
      required: ['path', 'action'],
    },
    requiresApproval: true,
    async run(input, ctx) {
      const file = resolveInside(ctx.cwd, input.path);
      const raw = await fsp.readFile(file, 'utf8');
      let nb;
      try {
        nb = JSON.parse(raw);
      } catch (e) {
        throw new Error('not a valid notebook: ' + e.message);
      }
      if (!Array.isArray(nb.cells)) throw new Error('notebook has no cells array');

      const sourceText = (cell) => (Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || ''));
      const asSource = (text) => String(text).split(/(?<=\n)/).filter(Boolean);

      if (input.action === 'read') {
        const listing = nb.cells
          .map((c, i) => `[${i}] ${c.cell_type}\n${sourceText(c).slice(0, 800)}`)
          .join('\n---\n');
        return { output: truncate(listing || '(no cells)').text, meta: { cells: nb.cells.length } };
      }

      const idx = Number(input.cell_index);
      if (!Number.isInteger(idx) || idx < 0) throw new Error('cell_index must be a non-negative integer');

      if (input.action === 'replace') {
        if (!nb.cells[idx]) throw new Error(`no cell at index ${idx}`);
        nb.cells[idx].source = asSource(input.source || '');
        if (input.cell_type) nb.cells[idx].cell_type = input.cell_type;
      } else if (input.action === 'insert') {
        const cell = {
          cell_type: input.cell_type || 'code',
          metadata: {},
          source: asSource(input.source || ''),
          ...(input.cell_type === 'code' || !input.cell_type ? { outputs: [], execution_count: null } : {}),
        };
        nb.cells.splice(Math.min(idx, nb.cells.length), 0, cell);
      } else if (input.action === 'delete') {
        if (!nb.cells[idx]) throw new Error(`no cell at index ${idx}`);
        nb.cells.splice(idx, 1);
      }

      const after = JSON.stringify(nb, null, 1) + '\n';
      await fsp.writeFile(file, after, 'utf8');
      ctx.recordEdit({ path: input.path, before: raw, after, kind: 'notebook_' + input.action });
      return { output: `${input.action} applied to ${input.path} (${nb.cells.length} cells)` };
    },
  },
  {
    name: 'enter_plan_mode',
    description: 'Switch to plan mode: read-only investigation until exit_plan_mode.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    planSafe: true,
    async run(input, ctx) {
      ctx.setMode('plan');
      return { output: 'plan mode on: investigation only, no edits or commands until exit_plan_mode.' };
    },
  },
  {
    name: 'exit_plan_mode',
    description: 'Leave plan mode, presenting the plan for approval.',
    inputSchema: {
      type: 'object',
      properties: { plan: { type: 'string', description: 'The plan, step by step.' } },
      required: ['plan'],
    },
    planSafe: true,
    async run(input, ctx) {
      ctx.setMode('default');
      return { output: 'plan mode off.\n\nProposed plan:\n' + String(input.plan || '').trim() };
    },
  },
  {
    name: 'web_search',
    description: 'Search the web. Disabled until a search backend is configured.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async run() {
      return {
        output: 'web_search is not configured in this build (no search backend key). Use web_fetch with a known URL.',
        isError: true,
      };
    },
  },
];

function globToRegExp(pattern) {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = esc.replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0001/g, '.*');
  return new RegExp('^' + body + '$');
}

module.exports = { tools, resolveInside, truncate, background };
