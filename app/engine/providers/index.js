// Provider registry: pretend (self-check), Gemini, OpenRouter, NVIDIA.
// Each provider exposes: id, label, stream(), listModels(), validateKey().
'use strict';

const { streamOpenAI, getJSON, pretend } = require('./openai-compat');
const keys = require('../keys');

// ---------- OpenRouter ----------
const openrouter = {
  id: 'openrouter',
  label: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  async *stream(opts) {
    yield* streamOpenAI({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: keys.get('openrouter'),
      extraHeaders: { 'HTTP-Referer': 'https://localhost/kestrel', 'X-Title': 'Kestrel' },
      ...opts,
    });
  },
  async listModels() {
    const r = await getJSON('https://openrouter.ai/api/v1/models');
    if (!r.ok || !r.json || !r.json.data) throw new Error(`model list failed (${r.status}) ${r.text}`);
    return r.json.data
      .map((m) => ({ id: m.id, label: m.name || m.id, context: m.context_length || null }))
      .sort((a, b) => a.id.localeCompare(b.id));
  },
  async validateKey(key) {
    const r = await getJSON('https://openrouter.ai/api/v1/key', { Authorization: `Bearer ${key}` });
    if (!r.ok) return { ok: false, note: `HTTP ${r.status}` };
    return { ok: true, note: r.json?.data?.label || 'key accepted' };
  },
};

// ---------- NVIDIA NIM ----------
const nvidia = {
  id: 'nvidia',
  label: 'NVIDIA',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  async *stream(opts) {
    yield* streamOpenAI({
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey: keys.get('nvidia'),
      ...opts,
    });
  },
  async listModels() {
    const key = keys.get('nvidia');
    const r = await getJSON('https://integrate.api.nvidia.com/v1/models', { Authorization: `Bearer ${key}` });
    if (!r.ok || !r.json || !r.json.data) throw new Error(`model list failed (${r.status}) ${r.text}`);
    return r.json.data.map((m) => ({ id: m.id, label: m.id, context: null })).sort((a, b) => a.id.localeCompare(b.id));
  },
  async validateKey(key) {
    const r = await getJSON('https://integrate.api.nvidia.com/v1/models', { Authorization: `Bearer ${key}` });
    return r.ok ? { ok: true, note: 'key accepted' } : { ok: false, note: `HTTP ${r.status}` };
  },
};

// ---------- Gemini ----------
// Chat goes through Gemini's documented OpenAI-compatible endpoint; the model
// catalogue comes from the native models endpoint.
const gemini = {
  id: 'gemini',
  label: 'Gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  async *stream(opts) {
    yield* streamOpenAI({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: keys.get('gemini'),
      ...opts,
    });
  },
  async listModels() {
    const key = keys.get('gemini');
    const r = await getJSON(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
    if (!r.ok || !r.json || !r.json.models) throw new Error(`model list failed (${r.status}) ${r.text}`);
    return r.json.models
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({
        id: String(m.name || '').replace(/^models\//, ''),
        label: m.displayName || String(m.name || '').replace(/^models\//, ''),
        context: m.inputTokenLimit || null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  },
  async validateKey(key) {
    const r = await getJSON(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
    return r.ok ? { ok: true, note: 'key accepted' } : { ok: false, note: `HTTP ${r.status}` };
  },
};

// ---------- Claude Code CLI ----------
// Not a wire protocol: the installed CLI runs its own harness. main.js routes
// this provider to engine/claude.js; stream() here only exists to fail loudly if
// something (such as compaction) tries to use it as a normal provider.
const claudeCli = {
  id: 'claude-cli',
  label: 'Claude Code (CLI)',
  async *stream() {
    yield {
      type: 'error',
      message: 'the Claude Code CLI runs inside its own process; this provider cannot stream here',
    };
  },
  async listModels() {
    return [
      { id: 'default', label: 'default (CLI decides)', context: null },
      { id: 'sonnet', label: 'sonnet', context: null },
      { id: 'opus', label: 'opus', context: null },
      { id: 'haiku', label: 'haiku', context: null },
    ];
  },
  async validateKey() {
    return { ok: true, note: 'runs the installed CLI, no key needed' };
  },
};

const registry = { pretend, gemini, openrouter, nvidia, 'claude-cli': claudeCli };
const KEY_PROVIDERS = new Set(['gemini', 'openrouter', 'nvidia']);

module.exports = {
  get: (id) => {
    const p = registry[id];
    if (!p) throw new Error('unknown provider: ' + id);
    return p;
  },
  list: () => Object.values(registry).map((p) => ({ id: p.id, label: p.label, needsKey: KEY_PROVIDERS.has(p.id) })),
};
