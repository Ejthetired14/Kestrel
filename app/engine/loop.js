// The agent loop: model -> tool calls -> results -> model, until the model stops
// asking for tools. Independent tools run concurrently; approvals stay ordered.
'use strict';

const { tools } = require('./tools');
const providers = require('./providers');

const MAX_TURNS = 24;

// Tools the model may use while in plan mode (read-only + plan transitions).
const PLAN_SAFE = new Set([
  'read',
  'ls',
  'glob',
  'grep',
  'todo_write',
  'web_fetch',
  'web_search',
  'bash_output',
  'enter_plan_mode',
  'exit_plan_mode',
]);

function offeredTools(mode, depth = 0) {
  return tools
    .filter((t) => (mode === 'plan' ? PLAN_SAFE.has(t.name) : true))
    .filter((t) => !(t.name === 'task' && depth >= 2))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/**
 * @param opts.onEvent  callback for streaming UI events
 * @param opts.approve  async (call) => 'allow' | 'allow_session' | 'deny'
 * @param opts.session  mutable session object (edits/terminal/todos/usage)
 * @param opts.depth    sub-agent nesting level (0 = top level)
 */
async function runTurn({
  providerId,
  model,
  system,
  messages,
  mode = 'default',
  session,
  onEvent = () => {},
  approve = async () => 'deny',
  signal,
  depth = 0,
}) {
  const provider = providers.get(providerId);
  const convo = messages;
  const sessionAllows = new Set();
  let activeMode = mode;

  const setMode = (next) => {
    if (!['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(next)) {
      throw new Error('unknown mode: ' + next);
    }
    activeMode = next;
    session.mode = next;
    onEvent({ type: 'mode', mode: next });
    return next;
  };

  const ctx = {
    cwd: session.cwd,
    depth,
    recordEdit: (e) => {
      session.edits.push({ ...e, at: Date.now() });
      onEvent({ type: 'edit', edit: e });
    },
    recordTerminal: (t) => {
      session.terminal.push({ ...t, at: Date.now() });
      onEvent({ type: 'terminal', entry: t });
    },
    setTodos: (todos) => {
      session.todos = todos;
      onEvent({ type: 'todos', todos });
    },
    getMode: () => activeMode,
    setMode,
  };

  // Sub-agents get their own transcript and work read-only, so a delegated task
  // can look around the project without touching it.
  ctx.subAgent = async ({ description, prompt }) => {
    const subSession = { ...session, messages: [] };
    let last = '';
    await runTurn({
      providerId,
      model,
      system: [
        system,
        '',
        '## Delegated task',
        `You are a sub-agent working on: ${description || prompt}`,
        'Work read-only: investigate and report. Do not edit files or run commands that change state.',
      ].join('\n'),
      messages: subSession.messages,
      mode: 'plan',
      session: subSession,
      onEvent,
      approve: async () => 'deny',
      signal,
      depth: depth + 1,
    });
    for (const m of subSession.messages) if (m.role === 'assistant' && m.content) last = m.content;
    return last;
  };

  onEvent({ type: 'turn_start', mode: activeMode, provider: providerId, model });

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (signal && signal.aborted) {
      // An interrupted turn keeps its text but drops unfinished tool calls.
      const lastMsg = convo[convo.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') lastMsg.toolCalls = [];
      onEvent({ type: 'turn_end', ok: false, aborted: true });
      return { ok: false, aborted: true };
    }

    const calls = [];
    let text = '';
    let failure = null;
    let interrupted = false;

    for await (const ev of provider.stream({
      model,
      system,
      messages: convo,
      tools: offeredTools(activeMode, depth),
      signal,
      depth,
    })) {
      if (ev.type === 'text') {
        text += ev.text;
        onEvent({ type: 'text', text: ev.text });
      } else if (ev.type === 'tool_call') {
        calls.push(ev);
      } else if (ev.type === 'usage') {
        session.usage.input += ev.input || 0;
        session.usage.output += ev.output || 0;
        onEvent({ type: 'usage', usage: { ...session.usage } });
      } else if (ev.type === 'aborted') {
        interrupted = true;
        break;
      } else if (ev.type === 'error') {
        failure = ev.message;
        onEvent({ type: 'error', message: ev.message });
        break;
      }
    }

    // Partial text is worth keeping even when the turn was stopped.
    convo.push({ role: 'assistant', content: text, toolCalls: interrupted || failure ? [] : calls });
    session.usage.turns += 1;
    onEvent({
      type: 'assistant_message',
      content: text,
      toolCalls: (interrupted || failure ? [] : calls).map((c) => ({ name: c.name, input: c.input })),
    });

    if (interrupted) {
      onEvent({ type: 'turn_end', ok: false, aborted: true });
      return { ok: false, aborted: true };
    }
    if (failure) {
      onEvent({ type: 'turn_end', ok: false });
      return { ok: false, error: failure };
    }
    if (!calls.length) {
      onEvent({ type: 'turn_end', ok: true });
      return { ok: true };
    }

    // 1) decide approvals in order
    const decisions = [];
    for (const call of calls) {
      const tool = tools.find((t) => t.name === call.name);
      if (!tool) {
        decisions.push({ call, decision: 'deny', reason: 'unknown tool' });
        continue;
      }
      let decision = 'allow';
      if (tool.requiresApproval) {
        if (activeMode === 'bypassPermissions') decision = 'allow';
        else if (activeMode === 'acceptEdits' && tool.name !== 'bash' && tool.name !== 'bash_kill') decision = 'allow';
        else if (sessionAllows.has(tool.name)) decision = 'allow';
        else decision = await approve(call);
      }
      if (decision === 'allow_session') {
        sessionAllows.add(tool.name);
        decision = 'allow';
      }
      decisions.push({ call, decision, reason: decision === 'deny' ? 'denied by user' : '' });
    }

    // 2) run the allowed ones together
    const runnable = decisions.filter((d) => d.decision === 'allow');
    const results = new Array(decisions.length);

    decisions.forEach((d, i) => {
      if (d.decision === 'deny') {
        results[i] = {
          id: d.call.id,
          name: d.call.name,
          output: `permission denied${d.reason ? ': ' + d.reason : ''}`,
          isError: true,
        };
        onEvent({ type: 'tool_result', id: d.call.id, name: d.call.name, output: results[i].output, isError: true });
      }
    });

    await Promise.all(
      runnable.map(async (d) => {
        const i = decisions.indexOf(d);
        const tool = tools.find((t) => t.name === d.call.name);
        onEvent({ type: 'tool_start', id: d.call.id, name: d.call.name, input: d.call.input });
        try {
          const res = await tool.run(d.call.input || {}, ctx);
          results[i] = { id: d.call.id, name: d.call.name, output: res.output, isError: Boolean(res.isError) };
        } catch (err) {
          results[i] = { id: d.call.id, name: d.call.name, output: String(err.message || err), isError: true };
        }
        onEvent({
          type: 'tool_result',
          id: results[i].id,
          name: results[i].name,
          output: results[i].output,
          isError: results[i].isError,
        });
      })
    );

    convo.push({ role: 'tool', results: results.filter(Boolean) });
  }

  onEvent({ type: 'error', message: `stopped after ${MAX_TURNS} turns` });
  onEvent({ type: 'turn_end', ok: false });
  return { ok: false, error: 'turn limit' };
}

module.exports = { runTurn, offeredTools, MAX_TURNS };
