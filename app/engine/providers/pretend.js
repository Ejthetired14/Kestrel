// Scripted provider used by the self-check: no key, no network, deterministic.
// The prompt picks a scenario so one fake model can exercise every code path.
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stream text word by word so the UI receives real deltas.
async function* words(text, delayMs = 0) {
  for (const word of text.split(/(\s+)/)) {
    if (!word) continue;
    if (delayMs) await sleep(delayMs);
    yield { type: 'text', text: word };
  }
}

// Tool rounds belonging to the current turn, counted from the last user message.
function toolRounds(messages) {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') break;
    if (messages[i].role === 'tool') n++;
  }
  return n;
}

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') return typeof m.content === 'string' ? m.content : '';
  }
  return '';
}

async function* stream({ messages, signal, purpose, depth = 0 }) {
  if (signal && signal.aborted) return yield { type: 'aborted' };

  if (purpose === 'compact') {
    yield* words(
      'Compacted context: the user asked Kestrel to read a fixture, write a summary file, '
        + 'delegate an inspection and edit a notebook. Files touched: selfcheck/fixture/. '
        + 'No open questions.'
    );
    yield { type: 'usage', input: 90, output: 40 };
    return yield { type: 'done' };
  }

  if (depth > 0) {
    yield* words('Sub-agent report: the fixture notes contain four lines, and the first line names Kestrel.');
    yield { type: 'usage', input: 40, output: 12 };
    return yield { type: 'done' };
  }

  const prompt = lastUser(messages).toLowerCase();
  const rounds = toolRounds(messages);

  if (prompt.includes('slow reply')) {
    // Slow on purpose: the self-check stops this turn mid-sentence.
    for (const word of 'This is a slow reply so the stop button can be tested before the sentence finishes.'.split(/(\s+)/)) {
      if (!word) continue;
      if (signal && signal.aborted) return yield { type: 'aborted' };
      await sleep(60);
      yield { type: 'text', text: word };
    }
    yield { type: 'usage', input: 60, output: 20 };
    return yield { type: 'done' };
  }

  if (prompt.includes('planmode')) {
    if (rounds === 0) {
      yield* words('Switching to plan mode to look around before proposing anything. ');
      yield { type: 'tool_call', id: 'call_plan_in', name: 'enter_plan_mode', input: {} };
    } else if (rounds === 1) {
      yield* words('Read enough. Leaving plan mode with a proposal. ');
      yield {
        type: 'tool_call',
        id: 'call_plan_out',
        name: 'exit_plan_mode',
        input: { plan: '1. read the notes\n2. summarise them in summary.md\n3. report back' },
      };
    } else {
      yield* words('Plan mode round-trip complete: entered read-only, then came back with a plan.');
    }
    yield { type: 'usage', input: 80, output: 30 };
    return yield { type: 'done' };
  }

  if (prompt.includes('deny this')) {
    if (rounds === 0) {
      yield* words('Trying to write a file that the user may refuse. ');
      yield {
        type: 'tool_call',
        id: 'call_denied_1',
        name: 'write',
        input: { path: 'selfcheck/fixture/denied.md', content: 'this file must never appear\n' },
      };
    } else {
      yield* words('The write was refused, so I left the file alone.');
    }
    yield { type: 'usage', input: 45, output: 15 };
    return yield { type: 'done' };
  }

  if (prompt.includes('shell command')) {
    if (rounds === 0) {
      yield* words('Running a shell command to prove the terminal panel. ');
      yield { type: 'tool_call', id: 'call_bash_1', name: 'bash', input: { command: 'echo kestrel-shell-ok' } };
    } else {
      yield* words('The shell command finished; its output is in the terminal panel.');
    }
    yield { type: 'usage', input: 55, output: 16 };
    return yield { type: 'done' };
  }

  if (prompt.includes('delegate')) {
    if (rounds === 0) {
      yield* words('Delegating the inspection to a sub-agent. ');
      yield {
        type: 'tool_call',
        id: 'call_task_1',
        name: 'task',
        input: {
          description: 'Inspect the fixture',
          prompt: 'Read selfcheck/fixture/notes.txt and report the line count.',
        },
      };
    } else {
      yield* words('The sub-agent reported back, and its report is in the task card above.');
    }
    yield { type: 'usage', input: 70, output: 25 };
    return yield { type: 'done' };
  }

  if (prompt.includes('notebook')) {
    if (rounds === 0) {
      yield* words('Editing the first notebook cell. ');
      yield {
        type: 'tool_call',
        id: 'call_nb_1',
        name: 'notebook_edit',
        input: {
          path: 'selfcheck/fixture/demo.ipynb',
          action: 'replace',
          cell_index: 0,
          source: '# edited by kestrel\nprint("hello from kestrel")\n',
        },
      };
    } else {
      yield* words('Notebook cell updated and saved.');
    }
    yield { type: 'usage', input: 50, output: 18 };
    return yield { type: 'done' };
  }

  if (rounds === 0) {
    yield* words('Reading the project so I can answer about it. ');
    yield {
      type: 'tool_call',
      id: 'call_read_1',
      name: 'read',
      input: { path: 'selfcheck/fixture/notes.txt' },
    };
    yield { type: 'usage', input: 120, output: 24 };
  } else if (rounds === 1) {
    yield* words('The notes mention the fixture. Now I will write a summary file. ');
    yield {
      type: 'tool_call',
      id: 'call_write_1',
      name: 'write',
      input: {
        path: 'selfcheck/fixture/summary.md',
        content: '# Summary\n\nGenerated by the Kestrel self-check.\n',
      },
    };
    yield { type: 'usage', input: 180, output: 40 };
  } else {
    yield* words(
      'Done. I read the notes, wrote selfcheck/fixture/summary.md, '
        + 'and this reply proves streaming reached the window.\n\nPrompt was: '
        + lastUser(messages).slice(0, 80)
    );
    yield { type: 'usage', input: 240, output: 60 };
  }

  yield { type: 'done' };
}

module.exports = {
  id: 'pretend',
  label: 'Pretend',
  stream,
  async listModels() {
    return [{ id: 'pretend-1', label: 'pretend-1', context: 8192 }];
  },
  async validateKey() {
    return { ok: true, note: 'no key needed' };
  },
};
