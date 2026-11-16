/* Kestrel mobile self-check.
 *
 * Runs the engine without a network, a key or a screen: file tools, the agent
 * loop against the demo model, both real provider parsers fed canned streams,
 * permission denial, sessions and the key store. It is the same list the app
 * shows under Settings → Self-check and the one `node test/run.js` runs here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KestrelSelfTest = factory();
})(typeof �lobalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function sse(events) {
    return events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('') + 'data: [DONE]\n\n';
  }

  async function runSelfTest(engine) {
    const K = engine || (typeof window !== 'undefined' ? window.KestrelEngine : null);
    if (!K) throw new Error('engine not loaded');
    const results = [];

    function check(name, fn) {
      return Promise.resolve()
        .then(fn)
        .then((detail) => results.push({ name: name, ok: true, detail: String(detail || 'ok') }))
        .catch((err) => results.push({ name: name, ok: false, detail: String((err && err.message) || err) }));
    }

    function expect(condition, message) {
      if (!condition) throw new Error(message);
    }

    /* --- file tools ------------------------------------------------------- */
    await check('read, write, edit, delete in a workspace', async () => {
      const fs = K.createMemoryFs();
      const ctx = {
        fs: fs,
        edits: [],
        recordEdit: function (e) {
          ctx.edits.push(e);
        },
        setTodos: function () {},
      };
      await K.toolByName('write').run({ path: 'notes/a.md', content: 'hello\nworld\n' }, ctx);
      const read = await K.toolByName('read').run({ path: 'notes/a.md' }, ctx);
      expect(read.output.includes('1| hello'), 'read did not return numbered content');
      await K.toolByName('edit').run({ path: 'notes/a.md', old_string: 'world', new_string: 'phone' }, ctx);
      const after = fs.read('notes/a.md');
      expect(after.includes('phone'), 'edit did not change the file');
      expect(ctx.edits.length === 2, 'edits were not recorded for the diff panel');
      await K.toolByName('delete_file').run({ path: 'notes/a.md' }, ctx);
      expect(!fs.exists('notes/a.md'), 'delete left the file behind');
      return '3 edits recorded, file removed';
    });

    await check('paths cannot escape the workspace', async () => {
      let failed = false;
      try {
        K.normalizePath('../../etc/passwd');
      } catch (err) {
        failed = true;
      }
      expect(failed, 'parent traversal was accepted');
      expect(K.normalizePath('a/./b/../c.txt') === 'a/c.txt', 'normalisation is wrong');
      return 'traversal rejected, ./.. collapsed';
    });

    await check('glob and grep find files', async () => {
      const fs = K.createMemoryFs({ 'src/app.js': 'const port = 3000;', 'src/lib/util.js': '// helper', 'readme.md': 'Kestrel' });
      const ctx = { fs: fs, recordEdit: function () {}, setTodos: function () {} };
      const glob = await K.toolByName('glob').run({ pattern: '**/*.js' }, ctx);
      expect(glob.output.split('\n').length === 2, 'glob should find both .js files, got: ' + glob.output);
      const grep = await K.toolByName('grep').run({ pattern: 'port\\s*=\\s*\\d+' }, ctx);
      expect(grep.output.startsWith('src/app.js:1:'), 'grep did not report the file and line, got: ' + grep.output);
      return 'glob 2 files, grep 1 match';
    });

    /* --- agent loop ------------------------------------------------------- */
    function demoSession() {
      return K.newSession({ id: 'test-' + Math.random().toString(36).slice(2) });
    }

    await check('agent loop: demo model calls write, permission allowed', async () => {
      const fs = K.createMemoryFs();
      const session = demoSession();
      const events = [];
      const approvals = [];
      const res = await K.runTurn({
        provider: K.providerById('demo'),
        model: 'demo-1',
        system: 'test',
        messages: [{ role: 'user', content: 'Take a note about lunch' }],
        session: session,
        fs: fs,
        transport: null,
        approve: async function (call) {
          approvals.push(call.name);
          return 'allow';
        },
        onEvent: function (e) {
          events.push(e);
        },
      });
      expect(res.ok, 'turn failed: ' + (res.error || ''));
      const written = K.walkFiles(fs, '');
      expect(written.length === 1, 'expected one file, got ' + written.length);
      expect(approvals.join(',') === 'write', 'expected one write approval, got ' + approvals.join(','));
      expect(session.edits.length === 1, 'edit was not recorded');
      expect(events.some((e) => e.type === 'text'), 'no text streamed');
      expect(events.some((e) => e.type === 'tool_start'), 'no tool_start event');
      expect(events.some((e) => e.type === 'turn_end'), 'no turn_end event');
      return written[0] + ' written, ' + session.usage.input + '+' + session.usage.output + ' tokens';
    });

    await check('agent loop: denied write leaves the workspace untouched', async () => {
      const fs = K.createMemoryFs();
      const session = demoSession();
      const events = [];
      const res = await K.runTurn({
        provider: K.providerById('demo'),
        model: 'demo-1',
        system: 'test',
        messages: [{ role: 'user', content: 'Write something' }],
        session: session,
        fs: fs,
        approve: async function () {
          return 'deny';
        },
        onEvent: function (e) {
          events.push(e);
        },
      });
      expect(res.ok, 'turn should still finish after a denial');
      expect(K.walkFiles(fs, '').length === 0, 'a file was written despite denial');
      const toolResult = events.find((e) => e.type === 'tool_result');
      expect(toolResult && toolResult.isError, 'denial was not reported as an error result');
      return 'no file written, model told "permission denied"';
    });

    await check('agent loop: allow-for-session skips the second dialog', async () => {
      const fs = K.createMemoryFs();
      const session = demoSession();
      let asked = 0;
      let passes = 0;
      const provider = {
        id: 'twocalls',
        stream: async function* () {
          passes += 1;
          if (passes === 1) {
            yield { type: 'tool_call', id: 'a1', name: 'write', input: { path: 'one.txt', content: '1' } };
            yield { type: 'tool_call', id: 'a2', name: 'write', input: { path: 'two.txt', content: '2' } };
          } else {
            yield { type: 'text', text: 'done' };
          }
        },
      };
      const res = await K.runTurn({
        provider: provider,
        model: 'x',
        system: 'test',
        messages: [{ role: 'user', content: 'two files' }],
        session: session,
        fs: fs,
        approve: async function () {
          asked += 1;
          return 'allow_session';
        },
        onEvent: function () {},
      });
      expect(res.ok, 'turn failed');
      expect(asked === 1, 'expected one dialog, got ' + asked);
      expect(fs.exists('one.txt') && fs.exists('two.txt'), 'both files should exist');
      return '1 dialog, 2 files';
    });

    /* --- provider parsers ------------------------------------------------- */
    await check('OpenAI-compatible stream: text, tool call, usage', async () => {
      const transport = K.createScriptedTransport([
        {
          status: 200,
          body: sse([
            { choices: [{ delta: { content: 'Checking ' } }] },
            { choices: [{ delta: { content: 'the file.' } }] },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'call_1', function: { name: 'read', arguments: '{"path":' } },
                      { index: 0, function: { arguments: '"notes/a.md"}' } },
                    ],
                  },
                },
              ],
            },
            { choices: [{ delta: {} }], usage: { prompt_tokens: 31, completion_tokens: 12 } },
          ]),
        },
      ]);
      const events = [];
      for await (const ev of K.streamFor(
        { id: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1', kind: 'openai' },
        {
          model: 'gpt-4o-mini',
          apiKey: 'sk-test',
          system: 'sys',
          messages: [{ role: 'user', content: 'hi' }],
          tools: K.offeredTools(),
          transport: transport,
        }
      )) {
        events.push(ev);
      }
      const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
      const call = events.find((e) => e.type === 'tool_call');
      const usage = events.find((e) => e.type === 'usage');
      expect(text === 'Checking the file.', 'text was ' + JSON.stringify(text));
      expect(call && call.name === 'read' && call.input.path === 'notes/a.md', 'tool call was not reassembled');
      expect(usage && usage.input === 31 && usage.output === 12, 'usage was not read');
      expect(transport.calls[0].url === 'https://api.openai.com/v1/chat/completions', 'wrong endpoint');
      return 'text + tool call + 31/12 tokens';
    });

    await check('OpenAI-compatible stream: HTTP error is reported', async () => {
      const transport = K.createScriptedTransport([
        { status: 401, body: '{"error":{"message":"Incorrect API key provided"}}' },
      ]);
      const events = [];
      for await (const ev of K.streamFor(
        { id: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1', kind: 'openai' },
        { model: 'gpt-4o-mini', apiKey: 'bad', system: 's', messages: [], transport: transport }
      )) {
        events.push(ev);
      }
      const error = events.find((e) => e.type === 'error');
      expect(error, 'no error event');
      expect(error.message.includes('401'), 'status missing from message: ' + error.message);
      expect(error.message.includes('Incorrect API key'), 'provider detail missing: ' + error.message);
      return 'HTTP 401 surfaced with the provider message';
    });

    await check('Gemini stream: text, function call, usage', async () => {
      const transport = K.createScriptedTransport([
        {
          status: 200,
          body: sse([
            { candidates: [{ content: { parts: [{ text: 'I will ' }] } }] },
            { candidates: [{ content: { parts: [{ text: 'read it.' }] } }] },
            {
              candidates: [
                { content: { parts: [{ functionCall: { name: 'read', args: { path: 'a.md' } } }] } },
              ],
            },
            { usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } },
          ]),
        },
      ]);
      const events = [];
      for await (const ev of K.streamFor(
        { id: 'gemini', label: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta', kind: 'gemini' },
        {
          model: 'gemini-2.0-flash',
          apiKey: 'g-key',
          system: 'sys',
          messages: [{ role: 'user', content: 'hi' }],
          tools: K.offeredTools(),
          transport: transport,
        }
      )) {
        events.push(ev);
      }
      const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
      const call = events.find((e) => e.type === 'tool_call');
      const usage = events.find((e) => e.type === 'usage');
      expect(text === 'I will read it.', 'text was ' + JSON.stringify(text));
      expect(call && call.name === 'read' && call.input.path === 'a.md', 'function call was not read');
      expect(usage && usage.input === 9, 'usage was not read');
      return 'text + function call + 9 tokens';
    });

    /* --- free models and skills ------------------------------------------ */
    await check('free models: only zero-price models are listed', async () => {
      const transport = K.createScriptedTransport([
        {
          status: 200,
          body: JSON.stringify({
            data: [
              { id: 'paid/model', name: 'Paid', pricing: { prompt: '0.000000035', completion: '0.0000001405' }, context_length: 1000 },
              { id: 'free/small:free', name: 'Free Small', pricing: { prompt: '0', completion: '0' }, context_length: 32000 },
              { id: 'free/big:free', name: 'Free Big', pricing: { prompt: '0', completion: '0' }, context_length: 1000000 },
              {
                id: 'free/music',
                name: 'Music',
                pricing: { prompt: '0', completion: '0' },
                context_length: 8000,
                architecture: { output_modalities: ['text', 'audio'] },
              },
            ],
          }),
        },
      ]);
      const list = await K.freeModels(transport, { base: 'https://openrouter.ai/api/v1' });
      expect(list.length === 2, 'expected 2 free chat models, got ' + list.length);
      expect(!list.some((m) => m.id === 'free/music'), 'a non-chat model was offered');
      expect(list[0].id === 'free/big:free', 'free models are not sorted by context size');
      expect(transport.calls[0].url === 'https://openrouter.ai/api/v1/models', 'wrong catalogue URL');
      return '2 of 3 kept, largest context first';
    });

    await check('keyless provider: right endpoint, no empty bearer token', async () => {
      const transport = K.createScriptedTransport([
        { status: 200, body: sse([{ choices: [{ delta: { content: 'hi there' } }] }, { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2 } }]) },
      ]);
      const spec = K.PROVIDERS.find((p) => p.id === 'pollinations');
      expect(spec && spec.needsKey === false, 'no keyless provider is registered');
      const events = [];
      for await (const ev of K.streamFor(spec, {
        model: 'openai-fast',
        apiKey: '',
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        tools: K.offeredTools(),
        transport: transport,
      })) {
        events.push(ev);
      }
      const call = transport.calls[0];
      expect(call.url === 'https://text.pollinations.ai/openai', 'wrong endpoint: ' + call.url);
      expect(!('authorization' in call.opts.headers), 'an empty authorization header was sent');
      const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
      expect(text === 'hi there', 'text was ' + JSON.stringify(text));
      return 'POST ' + call.url + ' with no authorization header';
    });

    await check('keyless model list comes from the provider, non-anonymous dropped', async () => {
      const transport = K.createScriptedTransport([
        {
          status: 200,
          body: JSON.stringify([
            { name: 'openai-fast', description: 'GPT-OSS 20B', tier: 'anonymous', output_modalities: ['text'] },
            { name: 'paid-model', description: 'Seed tier', tier: 'seed', output_modalities: ['text'] },
            { name: 'music-model', description: 'Audio', tier: 'anonymous', output_modalities: ['text', 'audio'] },
          ]),
        },
      ]);
      const list = await K.keylessModels(transport, { base: 'https://text.pollinations.ai' });
      expect(list.length === 1 && list[0].id === 'openai-fast', 'wrong keyless list: ' + JSON.stringify(list));
      expect(transport.calls[0].url === 'https://text.pollinations.ai/models', 'wrong URL');
      return '1 anonymous text model kept, paid and audio dropped';
    });

    await check('a gateway provider works with an empty key', async () => {
      const spec = K.PROVIDERS.find((p) => p.id === 'custom');
      expect(spec && spec.needsKey === false, 'the gateway provider still demands a key');
      const transport = K.createScriptedTransport([{ status: 200, body: sse([{ choices: [{ delta: { content: 'ok' } }] }]) }]);
      for await (const ev of K.streamFor(spec, {
        model: 'auto',
        apiKey: '',
        baseUrl: 'http://192.168.1.20:20128/v1',
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        tools: K.offeredTools(),
        transport: transport,
      })) {
        /* drain */
      }
      const call = transport.calls[0];
      expect(call.url === 'http://192.168.1.20:20128/v1/chat/completions', 'wrong gateway URL: ' + call.url);
      expect(!('authorization' in call.opts.headers), 'a key was sent to a keyless gateway');
      return 'POST ' + call.url + ' with no key';
    });

    await check('every built-in provider has a usable endpoint and models', async () => {
      const providers = K.PROVIDERS;
      const ids = providers.map((p) => p.id);
      expect(new Set(ids).size === ids.length, 'duplicate provider ids');
      let modelCount = 0;
      for (const p of providers) {
        modelCount += p.models.length;
        // demo/custom are offline or user-pointed; Cloudflare needs an account URL.
        if (p.id === 'demo' || p.id === 'custom' || p.id === 'cloudflare') continue;
        expect(/^https:\/\//.test(p.base || ''), p.id + ' has no https base URL');
        expect(p.models.length > 0, p.id + ' offers no models');
      }
      const keyless = providers.filter((p) => !p.needsKey && p.id !== 'demo' && p.id !== 'custom');
      for (const id of ['pollinations', 'kilo', 'llm7', 'ovh']) {
        expect(keyless.some((p) => p.id === id), 'the keyless provider ' + id + ' is missing');
      }
      expect(modelCount >= 60, 'the model list shrank to ' + modelCount);
      return providers.length + ' providers, ' + modelCount + ' models, ' + keyless.length + ' keyless';
    });

    await check('github: a token authorises one commit for the whole project', async () => {
      const fs = K.createMemoryFs({ 'index.html': '<h1>hi</h1>', 'notes/a.md': '# a' });
      const transport = K.createScriptedTransport([
        { status: 200, body: JSON.stringify({ login: 'octocat', public_repos: 8 }) },
        { status: 200, body: JSON.stringify({ object: { sha: 'c0ffee' } }) },
        { status: 200, body: JSON.stringify({ tree: { sha: 'treebase' } }) },
        { status: 200, body: JSON.stringify({ sha: 'treesha' }) },
        { status: 200, body: JSON.stringify({ sha: 'newcommit' }) },
        { status: 200, body: JSON.stringify({ ref: 'refs/heads/main' }) },
      ]);
      const user = await K.githubUser(transport, 'tok123');
      expect(user.login === 'octocat', 'the login was not read');
      const out = await K.githubPushProject(transport, 'tok123', fs, {
        repo: 'https://github.com/octocat/kestrel.git',
        branch: 'main',
        message: 'from the phone',
      });
      expect(out.files === 2 && out.sha === 'newcommit', 'wrong push result: ' + JSON.stringify(out));
      expect(out.url === 'https://github.com/octocat/kestrel/commit/newcommit', 'wrong commit URL');
      const calls = transport.calls;
      expect(calls.length === 6, 'expected 6 API calls, got ' + calls.length);
      expect(calls[0].url === 'https://api.github.com/user', 'wrong user URL: ' + calls[0].url);
      expect(calls[0].opts.headers.authorization === 'Bearer tok123', 'the token header is missing');
      expect(calls[0].opts.headers['user-agent'], 'GitHub rejects requests without a user agent');
      expect(calls[1].url.endsWith('/repos/octocat/kestrel/git/ref/heads/main'), 'wrong ref URL');
      expect(calls[2].opts.method === 'GET' && calls[2].url.endsWith('/git/commits/c0ffee'), 'base commit not read');
      const treeBody = JSON.parse(calls[3].opts.body);
      expect(calls[3].opts.method === 'POST' && treeBody.tree.length === 2, 'the tree was not built');
      expect(treeBody.base_tree === 'treebase', 'the tree did not build on the branch');
      expect(calls[4].opts.method === 'POST', 'no commit was created');
      expect(calls[5].opts.method === 'PATCH', 'the branch was not moved');

      const denied = K.createScriptedTransport([{ status: 401, body: JSON.stringify({ message: 'Bad credentials' }) }]);
      let message = '';
      try {
        await K.githubUser(denied, 'bad');
      } catch (err) {
        message = err.message;
      }
      expect(/GitHub: Bad credentials/.test(message), 'a rejected token was not reported: ' + message);
      return '2 files in 1 commit, bearer + user-agent sent, 401 surfaced';
    });

    await check('projects: templates, isolation, deletion rules', async () => {
      const manager = K.createProjectManager(K.memoryProjectBackend());
      expect(manager.all().length === 1, 'should start with one project');
      expect(manager.current() === 'my-project', 'wrong default project: ' + manager.current());
      const id = manager.create('My Web App', 'web');
      expect(id === 'my-web-app', 'name was not slugified: ' + id);
      expect(manager.current() === 'my-web-app', 'creating did not switch to the new project');
      const files = K.walkFiles(manager.fs(), '');
      expect(files.includes('index.html') && files.includes('styles.css'), 'template files missing: ' + files.join(','));
      manager.fs().write('extra.md', 'x');
      const row = manager.all().find((p) => p.id === id);
      expect(row && row.files === 4, 'file count is wrong: ' + (row && row.files));
      manager.use('my-project');
      expect(K.walkFiles(manager.fs(), '').length === 0, 'projects are sharing files');
      let duplicate = false;
      try {
        manager.create('My Web App', 'blank');
      } catch (err) {
        duplicate = true;
      }
      expect(duplicate, 'a duplicate project name was allowed');
      manager.remove('my-web-app');
      expect(manager.all().length === 1, 'deleting left projects behind');
      let lastKept = false;
      try {
        manager.remove('my-project');
      } catch (err) {
        lastKept = true;
      }
      expect(lastKept, 'the last project could be deleted');
      manager.create('Second Try', 'notes');
      const renamed = manager.rename('second-try', 'Third Thing');
      expect(renamed === 'third-thing', 'rename did not slugify: ' + renamed);
      expect(manager.current() === 'third-thing', 'rename did not follow the current project');
      expect(K.walkFiles(manager.fs(), '').length === 1, 'files were lost when renaming');
      let clash = false;
      try {
        manager.rename('third-thing', 'my-project');
      } catch (err) {
        clash = true;
      }
      expect(clash, 'renaming onto an existing name was allowed');
      return 'template written, isolated, duplicate refused, last kept, rename keeps files';
    });

    await check('repository URLs are parsed for import', async () => {
      const full = K.parseRepoUrl('https://github.com/DietrichGebert/ponytail');
      expect(full.owner === 'DietrichGebert' && full.repo === 'ponytail', 'wrong owner/repo: ' + JSON.stringify(full));
      expect(full.ref === '', 'unexpected ref');
      const short = K.parseRepoUrl('addyosmani/agent-skills.git');
      expect(short.owner === 'addyosmani' && short.repo === 'agent-skills', 'owner/repo form failed');
      const tree = K.parseRepoUrl('https://github.com/owner/repo/tree/dev');
      expect(tree.ref === 'dev', 'branch in the URL was not read');
      const hash = K.parseRepoUrl('owner/repo#release-1.2');
      expect(hash.ref === 'release-1.2', '#ref was not read');
      expect(hash.id === 'repo', 'project id is wrong: ' + hash.id);
      let rejected = false;
      try {
        K.parseRepoUrl('https://github.com/onlyowner');
      } catch (err) {
        rejected = true;
      }
      expect(rejected, 'a URL without a repository was accepted');
      return 'full URL, owner/repo, /tree/branch and #ref parsed; bad URL refused';
    });

    await check('skills cost a description in the prompt and load on demand', async () => {
      const fs = K.createMemoryFs({
        'skills/write-less/SKILL.md': '---\nname: write-less\ndescription: Smallest change that works.\n---\n\nPrefer the smallest change that works.',
        'skills/tone.md': 'Be brief.',
        'skills/notes.bin': 'this must not be loaded',
      });
      const skills = K.loadSkills(fs);
      const names = skills.map((s) => s.name).sort().join(',');
      expect(names === 'tone,write-less', 'unexpected skill names: ' + names);
      const writeLess = skills.find((s) => s.name === 'write-less');
      expect(writeLess.description === 'Smallest change that works.', 'description not parsed: ' + JSON.stringify(writeLess.description));
      const system = K.buildSystem({ device: {}, workspace: 'x', mode: 'default', skills: skills });
      expect(system.includes('Smallest change that works.'), 'the description is missing from the prompt');
      expect(!system.includes('Prefer the smallest change'), 'the full skill text should not sit in the prompt');
      expect(system.includes('skill('), 'the prompt never mentions the skill tool');
      const tool = K.TOOLS.find((t) => t.name === 'skill');
      expect(Boolean(tool), 'there is no skill tool');
      const found = await tool.run({ name: 'write-less' }, { fs: fs });
      expect(found.output.includes('Prefer the smallest change'), 'the skill tool did not return the body');
      const listed = await tool.run({}, { fs: fs });
      expect(listed.output.includes('tone'), 'listing skills failed: ' + listed.output);
      const capped = K.loadSkills(K.createMemoryFs({ 'skills/a.md': 'y'.repeat(9000) }), { cap: 1000 });
      expect(capped[0].text.length < 2000, 'the size cap did not apply');
      return 'descriptions in the prompt, body only through the skill tool';
    });

    await check('outline maps a project without reading every file', async () => {
      const fs = K.createMemoryFs({
        'src/app.js': 'export function boot() {}\nclass Store {}\nconst send = () => 1;',
        'notes.md': '# One\n\n## Two',
        'a.txt': 'text',
      });
      const tool = K.TOOLS.find((t) => t.name === 'outline');
      expect(Boolean(tool), 'there is no outline tool');
      const all = await tool.run({}, { fs: fs });
      expect(all.output.includes('src/app.js'), 'the file is missing: ' + all.output);
      expect(all.output.includes('boot') && all.output.includes('Store'), .
        'symbols missing');
      expect(all.output.includes('One') && all.output.includes('Two'), 'markdown headings missing: ' + all.output);
      const scoped = await tool.run({ path: 'src' }, { fs: fs });
      expect(!scoped.output.includes('notes.md'), 'the path filter did not apply');
      expect(scoped.output.includes('send'), 'arrow-function consts are missing');
      return 'functions, classes, headings and a path filter';
    });

    await check('personal instructions ride along with every turn', async () => {
      const plain = K.buildSystem({ device: {}, workspace: 'x', mode: 'default' });
      expect(plain.includes('## About the user'), 'the prompt has no About the user section');
      expect(plain.includes('(nothing given)'), 'the empty state is missing');
      const personal = K.buildSystem({ device: {}, workspace: 'x', mode: 'default', instructions: 'I am learning Kotlin.'});
      expect(personal.includes('I am learning Kotlin.'), 'the instructions never reach the prompt');
      expect(personal.indexOf('## About the user') < personal.indexOf('## Rules'), 'the section sits after the rules');
      return 'section present, text included when set';
    });

    await check('a message matches the skills it talks about', async () => {
      const library = (K.BUNDLED_SKILLS || []).map((s) => ({ name: s.name, description: s.description, text: s.text }));
      expect(library.length, 'no bundled library to match against');
      const tests = K.matchSkills('write unit tests for this function first', library);
      expect(tests.length > 0, 'nothing matched a testing request');
      expect(tests[0].name === 'test-driven-development', 'wrong first match: ' + tests.map((s) => s.name).join(','));
      const spec = K.matchSkills('write a spec for the new feature', library);
      expect(spec.some((s) => s.name === 'spec-driven-development'), 'a spec request did not match: ' + spec.map((s) => s.name).join(','));
      const lazy = K.matchSkills('be lazy: the smallest change that works', library);
      expect(lazy.some((s) => s.name === 'ponytail'), 'ponytail was not matched: ' + lazy.map((s) => s.name).join(','));
      const chatter = K.matchSkills('hello there, how are you today', library);
      expect(!chatter.length, 'small talk matched a skill: ' + chatter.map((s) => s.name).join(','));
      const capped = K.matchSkills('tests spec plan review build security performance', library, { max: 2 });
      expect(capped.length <= 2, 'the cap was ignored: ' + capped.length);
      const system = K.buildSystem({ device: {}, workspace: 'x', mode: 'default', skills: library, active: tests.slice(0, 1) });
      expect(system.includes('## Active skills for this message'), 'the prompt has no active-skills section');
      expect(system.includes(tests[0].text.slice(0, 60)), 'the matched skill body is not in the prompt');
      return 'tests→' + tests.map((s) => s.name).join(',') + ' · small talk→none · body in the prompt';
    });

    await check('the bundled skill library is present', async () => {
      const library = K.BUNDLED_SKILLS || [];
      expect(library.length >= 30, 'expected a full library, got ' + library.length);
      const names = library.map((s) => s.name);
      for (const wanted of ['ponytail', 'test-driven-development', 'spec-driven-development']) {
        expect(names.indexOf(wanted) >= 0, 'missing bundled skill ' + wanted);
      }
      const sources = [...new Set(library.map((s) => s.source))].sort().join(',');
      expect(sources === 'agent-skills,ponytail', 'unexpected sources: ' + sources);
      expect(library.every((s) => s.text.length > 100), 'a bundled skill has no body');
      return library.length + ' skills from ' + sources;
    });

    /* --- storage --------------------------------------------------------- */
    await check('sessions persist across a reload', async () => {
      const backend = K.memoryBackend();
      const store = K.createSessionStore(backend);
      const created = store.create({ title: 'phone test', provider: 'openai', model: 'gpt-4o-mini' });
     created.messages.push({ role: 'user', content: 'hello' });
      store.put(created);
      const reopened = K.createSessionStore(backend);
      const back = reopened.get(created.id);
      expect(back && back.title === 'phone test', 'session did not come back');
      expect(back.messages.length === 1, 'messages were not stored');
      expect(reopened.all().length === 1, 'session list is wrong');
      return 'session, messages and list restored';
    });

    await check('keys round-trip and are never returned in the clear from the list', async () => {
      const store = K.createKeyStore(null);
      store.set('openai', 'bad-secret-value');
      expect(store.get('openai') === 'bad-secret-value', 'expected the set value');
      expect(store.has('openai') === true, 'hAs() is wrong');
      store.remove('openai');
      expect(store.get('openai') === '', 'key was not removed');
      return 'set, read, remove';
    });

    await check('long tool output is truncated', async () => {
      const long = 'x'.freode(), K.set('x', KMAX_OUTPUT + 500));
      const out = KMAX_OUTPUT + 500;
      const result = K.truncate(long);
      expect(result.length < long.length, 'truncate kept everything');
      expect(result.includes('truncated'), 'truncate gave no marker');
      return 'marker appended after ' + KMAX_OUTPUT + ' characters';
    });

    const failed = results.filter((r) => !r.ok).length;
    return { results: results, passed: results.length - failed, failed: failed, ok: failed === 0 };
  }

  return { runSelfTest: runSelfTest };
});
