// Shared OpenAI-compatible chat adapter + provider registry.
// All three providers speak the OpenAI chat-completions shape (Gemini through its
// documented /v1beta/openai compatibility endpoint), so there is one streaming
// parser and one tool-call accumulator to maintain.
'use strict';

const pretend = require('./pretend');

/** Convert our canonical transcript into OpenAI chat messages. */
function toOpenAIMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls && m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      for (const r of m.results) {
        out.push({
          role: 'tool',
          tool_call_id: r.id,
          content: typeof r.output === 'string' ? r.output : JSON.stringify(r.output),
        });
      }
    }
  }
  return out;
}

function toOpenAITools(tools) {
  return (tools || []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/**
 * Stream one assistant message. Yields text deltas immediately, tool calls when
 * the stream ends, then usage and done.
 */
async function* streamOpenAI(opts) {
  const { baseUrl, apiKey, model, system, messages, tools, signal, extraHeaders = {}, extraBody = {} } = opts;

  const body = {
    model,
    stream: true,
    messages: toOpenAIMessages(messages, system),
    ...extraBody,
  };
  if (tools && tools.length) {
    body.tools = toOpenAITools(tools);
    body.tool_choice = 'auto';
  }

  let res;
  try {
    res = await fetch(baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      yield { type: 'aborted' };
      return;
    }
    yield { type: 'error', message: 'network: ' + (err && err.message) };
    return;
  }

  if (!res.ok || !res.body) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      /* ignore */
    }
    yield { type: 'error', message: `HTTP ${res.status} ${res.statusText} ${detail}` };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const calls = new Map(); // index -> {id, name, args}
  let usage = null;

  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        yield { type: 'aborted' };
        return;
      }
      yield { type: 'error', message: 'stream: ' + (err && err.message) };
      return;
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.usage) usage = json.usage;

      const choice = json.choices && json.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (typeof delta.content === 'string' && delta.content) {
        yield { type: 'text', text: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const cur = calls.get(idx) || { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function && tc.function.name) cur.name = tc.function.name;
          if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
          calls.set(idx, cur);
        }
      }
    }
  }

  for (const [idx, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    let input = {};
    try {
      input = call.args ? JSON.parse(call.args) : {};
    } catch {
      input = { __parse_error: call.args };
    }
    yield {
      type: 'tool_call',
      id: call.id || `call_${idx}`,
      name: call.name,
      input,
    };
  }

  if (usage) {
    yield {
      type: 'usage',
      input: usage.prompt_tokens || 0,
      output: usage.completion_tokens || 0,
    };
  }
  yield { type: 'done' };
}

/** Small JSON GET helper shared by model listing and key validation. */
async function getJSON(url, headers = {}, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    return { ok: res.ok, status: res.status, json, text: text.slice(0, 300) };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { streamOpenAI, toOpenAIMessages, toOpenAITools, getJSON, pretend };
