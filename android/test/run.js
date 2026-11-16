#!/usr/bin/env node
/* Runs the phone app's own self-check on this machine, without a phone.
 *
 *   node android/test/run.js
 *
 * It loads exactly the engine the APK ships (app/assets/www/*.js), runs the
 * self-check list, prints one line per step and writes checks/android/selftest.json.
 * Exit status is 0 only when every step passes.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const www = path.join(__dirname, '..', 'app', 'assets', 'www');
// The skill bundle is a plain script in the app; load it the same way first.
require(path.join(www, 'kestrel-skills.js'));
const engine = require(path.join(www, 'kestrel-engine.js'));
const { runSelfTest } = require(path.join(www, 'kestrel-selftest.js'));

(async () => {
  const started = Date.now();
  const result = await runSelfTest(engine);
  const ms = Date.now() - started;

  let width = 0;
  for (const r of result.results) width = Math.max(width, r.name.length);
  for (const r of result.results) {
    console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name.padEnd(width) + '  ' + r.detail);
  }
  console.log('');
  console.log(
    (result.ok ? 'SELF-CHECK PASS' : 'SELF-CHECK FAIL') +
      ` — ${result.passed}/${result.results.length} steps, ${result.failed} failed, ${ms} ms`
  );

  const outDir = path.join(__dirname, '..', '..', 'checks', 'android');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'selftest.json'),
    JSON.stringify({ when: new Date().toISOString(), ms, ...result }, null, 2) + '\n'
  );

  process.exit(result.ok ? 0 : 1);
})().catch((err) => {
  console.error('SELF-CHECK CRASHED');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
