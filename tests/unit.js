'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = new Set(['codec_test.js', 'inject_test.js', 'live_session_test.js']);
const isBun = typeof Bun !== 'undefined';
const suites = fs
  .readdirSync(__dirname)
  .filter(f => f.endsWith('_test.js') && !SCRIPTS.has(f))
  .sort()
  .map(f => path.join('tests', f));
const root = path.join(__dirname, '..');

function run(args) {
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}

run([path.join('tests', 'order_check.js')]);
run(isBun ? ['test', '--timeout', '60000', ...suites.map(f => './' + f.replace(/\\/g, '/'))] : ['--test', ...process.argv.slice(2), ...suites]);
run([path.join('tests', 'codec_test.js')]);
