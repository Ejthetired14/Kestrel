// Context compaction: ask the model to compress the transcript, then keep the
// summary plus the newest exchange so the loop can continue in a smaller window.
'use strict';

const providers = require('./providers');

const SUMMARY_RULES = [
  'Compress this coding session into a short briefing that another engineer could continue from.',
  'Keep: the current goal, decisions made, files touched and why, commands run and their outcomes,',
  'open questions and anything the user asked for explicitly. Drop pleasantries and repetition.',
  'Write plain prose under 400 words. No preamble.',
].join(' ');

function transcriptText(messages, budget = 40000) {
  const lines = [];
  for (const m of messages) {
    if (m.role === 'user') lines.push(`USER: ${m.content}`);
    else if (m.role === 'assistant') {
      lines.push(`ASSISTANT: ${m.content}`);
      for (const c of m.toolCalls || []) lines.push(`  → ${c.name}(${JSON.stringify(c.input).slice(0, 400)})`);
    } else if (m.role === 'tool') {
      for (const r of m.results || []) {
        lines.push(`  ← ${r.name}${r.isError ? ' (error)' : ''}: ${String(r.output).slice(0, 600)}`);
      }
    }
  }
  const text = lines.join('\n');
  return text.length > budget ? text.slice(0, 20000) + '\n…\n' + text.slice(-(budget - 20000)) : text;
}

function estimateTokens(messages) {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/**
 * Replace the transcript with a summary. Returns the summary text.
 * @param onEvent optional callback for streaming notices
 */
async function compact({ providerId, model, session, signal, onEvent = () => {} }) {
  if (session.messages.length < 2) return 'Nothing to compact yet.';

  const transcript = transcriptText(session.messages);
  let summary = '';

  for await (const ev of providers.get(providerId).stream({
    model,
    system: 'You compress conversations. You never add new facts.',
    messages: [{ role: 'user', content: `${SUMMARY_RULES}\n\n---\n${transcript}` }],
    tools: [],
    signal,
    purpose: 'compact',
  })) {
    if (ev.type === 'text') summary += ev.text;
    else if (ev.type === 'error') return `Compaction failed: ${ev.message}`;
  }

  summary = summary.trim();
  if (!summary) return 'Compaction produced no summary; conversation left unchanged.';

  const tail = session.messages.slice(-2).filter((m) => m.role !== 'tool');
  session.messages = [
    { role: 'user', content: `<compacted-context>\n${summary}\n</compacted-context>` },
    ...tail,
  ];
  session.compactions = (session.compactions || 0) + 1;
  session.lastCompact = { at: Date.now(), tokensBefore: estimateTokens(tail), summary };
  onEvent({ type: 'compacted', summary, compactions: session.compactions });
  return `Compacted ${session.compactions === 1 ? 'the conversation' : 'again'} into ${summary.length} characters of summary.`;
}

module.exports = { compact, estimateTokens, transcriptText };
