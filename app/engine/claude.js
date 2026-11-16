// Claude Code subprocess mode: run the installed CLI in print/stream-json mode,
// translate its events into Kestrel's own event stream, and answer its tool
// permission requests with Kestrel's dialog.
//
// The CLI is a complete harness of its own, so in this mode Kestrel does not run
// tools itself — it displays what the CLI did and decides whether the CLI may.
// That is why this module bypasses engine/loop.js entirely.
//
// Wire protocol (JSON lines, one direction each):
//   stdout: {"type":"control_request","request_id":ID,"request":{"subtype":"can_use_tool",
//            "tool_name":NAME,"input":{...},"permission_suggestions":[...]}}
//   stdin:  {"type":"control_response","response":{"subtype":"success","request_id":ID,
//            "response":{"behavior":"allow","updatedInput":{...}}}}
//           {"type":"control_response","response":{"subtype":"success","request_id":ID,
//            "response":{"behavior":"deny","message":"..."}}}
'use strict';

const { spawn, spawnSync } = require('node:child_process');

// Our modes onto the CLI's permission modes.
const MODE_MAP = {
  default: 'manual',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  bypassPermissions: 'bypassPermissions',
};

function bin() {
  return process.env.KESTREL_CLAUDE_BIN || 'claude';
}

let versionCache = null;
function cliVersion() {
  if (versionCache !== null) return versionCache;
  try {
    const res = spawnSync(bin(), ['--version'], { encoding: 'utf8', timeout: 15000 });
    versionCache = res.status === 0 ? String(res.stdout).trim() : null;
  } catch {
    versionCache = null;
  }
  return versionCache;
}

function hasClaude() {
  return Boolean(cliVersion());
}

/** The CLI starts fresh each run, so earlier turns are replayed as context. */
function promptWithHistory(session, prompt, budget = 6000) {
  const prior = (session.messages || [])
    .filter((m) => (m.role === 'user' && m.content) || (m.role === 'assistant' && m.content))
    .slice(-8)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');
  if (!prior) return prompt;
  return `Earlier in this conversation:\n${prior.slice(-budget)}\n\nCurrent request:\n${prompt}`;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

/**
 * Run one CLI turn. Resolves with { ok, text, cost, error, aborted }.
 * Events: turn_start, notice, text, tool_start, tool_result, usage,
 *         assistant_message, error, turn_end.
 *
 * @param approve async ({name, input, id}) => 'allow' | 'allow_session' | 'deny'
 */
function runClaudeTurn({ session, prompt, model, mode = 'default', onEvent = () => {}, signal, approve }) {
  return new Promise((resolve) => {
    const bridged = typeof approve === 'function' && mode !== 'bypassPermissions';
    const args = [
      '-p',
      promptWithHistory(session, prompt),
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      MODE_MAP[mode] || 'manual',
      '--permission-prompts',
      bridged ? 'host' : 'none',
    ];
    if (model && model !== 'default') args.push('--model', model);

    onEvent({ type: 'turn_start', mode, provider: 'claude-cli', model: model || 'default' });

    const child = spawn(bin(), args, {
      cwd: session.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = '';
    let text = '';
    let errorText = null;
    let cost = 0;
    let stderr = '';
    let closed = false;
    const toolNames = new Map();
    const sessionAllows = new Set();
    const aborted = { value: false };

    const write = (obj) => {
      if (closed || !child.stdin.writable) return;
      try {
        child.stdin.write(JSON.stringify(obj) + '\n');
      } catch {
        /* the CLI may have exited first */
      }
    };

    const answer = (requestId, result) => {
      write({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: result },
      });
    };

    const handleControlRequest = async (obj) => {
      const request = obj.request || {};
      const requestId = obj.request_id;

      if (request.subtype !== 'can_use_tool') {
        // Nothing else needs an answer from us; an empty success keeps the CLI moving.
        answer(requestId, {});
        return;
      }

      const name = request.tool_name || 'tool';
      const input = request.input || {};

      if (sessionAllows.has(name)) {
        answer(requestId, { behavior: 'allow', updatedInput: input });
        onEvent({ type: 'notice', text: `allowed ${name} for this session (CLI)` });
        return;
      }

      let decision = 'deny';
      try {
        decision = await approve({ id: requestId, name, input });
      } catch {
        decision = 'deny';
      }

      if (decision === 'allow' || decision === 'allow_session') {
        if (decision === 'allow_session') sessionAllows.add(name);
        answer(requestId, { behavior: 'allow', updatedInput: input });
        onEvent({ type: 'permission_result', name, allowed: true, session: decision === 'allow_session' });
      } else {
        answer(requestId, { behavior: 'deny', message: 'Denied by the user in Kestrel.' });
        onEvent({ type: 'permission_result', name, allowed: false });
      }
    };

    const onAbort = () => {
      aborted.value = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const handle = (obj) => {
      switch (obj.type) {
        case 'system':
          if (obj.subtype === 'init') {
            onEvent({
              type: 'notice',
              text: `claude-cli ${obj.claude_code_version || ''} · model ${obj.model} · ${
                (obj.tools || []).length
              } tools${bridged ? ' · permissions bridged' : ''}`,
            });
          }
          break;

        case 'control_request':
          // Answered asynchronously so a slow human does not block the event loop.
          handleControlRequest(obj).catch(() => {});
          break;

        case 'stream_event': {
          const e = obj.event || {};
          if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && e.delta.text) {
            text += e.delta.text;
            onEvent({ type: 'text', text: e.delta.text });
          }
          break;
        }

        case 'assistant': {
          const content = (obj.message && obj.message.content) || [];
          for (const c of content) {
            if (c.type === 'tool_use') {
              toolNames.set(c.id, c.name);
              onEvent({ type: 'tool_start', id: c.id, name: c.name, input: c.input });
            }
          }
          // Message text is either the same text we already streamed as deltas, or
          // text that never came as deltas (for example after a permission pause).
          // Compare content instead of trusting a flag that a tool round can reset.
          const messageText = content
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text)
            .join('');
          if (messageText && !text.endsWith(messageText)) {
            text += messageText;
            onEvent({ type: 'text', text: messageText });
          }
          break;
        }

        case 'user': {
          const content = (obj.message && obj.message.content) || [];
          for (const c of content) {
            if (c.type !== 'tool_result') continue;
            onEvent({
              type: 'tool_result',
              id: c.tool_use_id,
              name: toolNames.get(c.tool_use_id) || 'tool',
              output: toolResultText(c.content),
              isError: Boolean(c.is_error),
            });
          }
          break;
        }

        case 'result': {
          if (obj.usage) {
            session.usage.input += obj.usage.input_tokens || 0;
            session.usage.output += obj.usage.output_tokens || 0;
            onEvent({ type: 'usage', usage: { ...session.usage } });
          }
          if (typeof obj.total_cost_usd === 'number') cost = obj.total_cost_usd;
          if (obj.is_error) errorText = obj.result || 'the CLI reported an error';
          else if (!text && obj.result) {
            text = obj.result;
            onEvent({ type: 'text', text: obj.result });
          }
          // A result ends the turn: close the control channel and make sure a CLI
          // that lingers on an open stdin cannot hang the app.
          try {
            if (child.stdin.writable) child.stdin.end();
          } catch {
            /* already closed */
          }
          setTimeout(() => {
            if (!closed) {
              try {
                child.kill('SIGTERM');
              } catch {
                /* gone */
              }
            }
          }, 1500);
          break;
        }

        default:
          break;
      }
    };

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        try {
          handle(JSON.parse(line));
        } catch {
          /* a line we cannot parse is not worth failing the turn over */
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      const message = `could not start "${bin()}": ${err.message}`;
      onEvent({ type: 'error', message });
      onEvent({ type: 'turn_end', ok: false });
      resolve({ ok: false, text, error: message });
    });

    child.on('close', (code) => {
      closed = true;
      if (buffer.trim().startsWith('{')) {
        try {
          handle(JSON.parse(buffer.trim()));
        } catch {
          /* ignore trailing partial line */
        }
      }
      // The streamed text often already carries the same sentence; do not show it twice.
      if (errorText && errorText.trim() !== text.trim()) onEvent({ type: 'error', message: errorText });
      else if (!text && stderr.trim()) onEvent({ type: 'error', message: stderr.trim().slice(0, 600) });

      onEvent({ type: 'assistant_message', content: text, toolCalls: [] });
      onEvent({ type: 'turn_end', ok: !errorText && code === 0 && !aborted.value, aborted: aborted.value, exitCode: code });
      resolve({ ok: !errorText && code === 0 && !aborted.value, text, cost, error: errorText, aborted: aborted.value });
    });
  });
}

module.exports = { runClaudeTurn, cliVersion, hasClaude, promptWithHistory, MODE_MAP };
