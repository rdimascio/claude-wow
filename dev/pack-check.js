#!/usr/bin/env node
'use strict';
// A dev checkout can be the bridge's home (bridge/config.json, tokens, logs),
// and .gitignore does not apply once package.json lists `files`.

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ALWAYS_REQUIRED = Object.freeze(['package.json', 'bridge/supervisor.js', 'setup.js', 'README.md', 'LICENSE']);

function run(cmd, args, input, cwd = ROOT) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', input, shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r;
}

function packedPaths(cwd = ROOT) {
  const r = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], undefined, cwd);
  if (r.status !== 0) throw new Error(`npm pack --dry-run failed:\n${r.stderr}`);
  const [pack] = JSON.parse(r.stdout);
  return pack.files.map(f => f.path);
}

function trackedPaths() {
  return run('git', ['ls-files', '-z']).stdout.split('\0').filter(Boolean);
}

function ignoredPaths(paths) {
  const r = run('git', ['check-ignore', '--no-index', '--stdin', '-z'], paths.join('\0'));
  return r.stdout.split('\0').filter(Boolean);
}

function problems({ packed, tracked, ignored }) {
  const isTracked = new Set(tracked);
  const isIgnored = new Set(ignored);
  const isPacked = new Set(packed);
  return [
    ...packed.filter(p => !isTracked.has(p)).map(p => `${p} is packed but not tracked by git`),
    ...packed.filter(p => isIgnored.has(p)).map(p => `${p} is packed but matches .gitignore`),
    ...ALWAYS_REQUIRED.filter(p => !isPacked.has(p)).map(p => `${p} is missing from the package`),
  ];
}

function publishProblems({ env, status }) {
  const out = [];
  if (env.GITHUB_ACTIONS !== 'true') out.push('publish only from the release workflow on GitHub Actions, not from a local checkout');
  if (status.trim()) out.push(`the checkout is not clean:\n${status.trim()}`);
  return out;
}

function main(argv = process.argv.slice(2)) {
  const packed = packedPaths();
  const found = problems({ packed, tracked: trackedPaths(), ignored: ignoredPaths(packed) });
  if (argv.includes('--publish')) {
    found.push(...publishProblems({ env: process.env, status: run('git', ['status', '--porcelain']).stdout }));
  }
  if (found.length) {
    for (const line of found) console.error(`pack-check: ${line}`);
    return 1;
  }
  console.log(`pack-check: ${packed.length} files, all tracked and none ignored`);
  return 0;
}

module.exports = { ALWAYS_REQUIRED, problems, publishProblems, packedPaths, trackedPaths, ignoredPaths };

if (require.main === module) process.exitCode = main();
