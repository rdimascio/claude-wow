'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PC = require('../dev/pack-check');

const ROOT = path.join(__dirname, '..');
const RUNTIME_FILES = [
  'bridge/config.json',
  'bridge/state.json',
  'bridge/transcripts.json',
  'bridge/bridge.log',
  'bridge/discord.token',
  'bridge/discord-webhook.json',
  'bridge/live.token',
  'bridge/probe.png',
  'bridge/notes.tmp',
  'bridge/tmp/prompt-1.txt',
  'bridge/data/forever/Map.csv',
  'bridge/mapjobs/1.json',
  'bridge/uijobs/1.json',
  'bridge/goals/Name-Realm/goals.json',
];
const CODE_FILES = ['bridge/supervisor.js', 'bridge/plugins/ask.js', 'bridge/config.example.json'];

test('problems: a packed path that git does not track or that .gitignore matches is named, and so is a required file left out', () => {
  const tracked = ['package.json', 'bridge/supervisor.js', 'setup.js', 'README.md', 'LICENSE', 'bridge/x.js'];
  assert.deepEqual(PC.problems({ packed: [...tracked, 'bridge/config.json'], tracked, ignored: ['bridge/x.js'] }), [
    'bridge/config.json is packed but not tracked by git',
    'bridge/x.js is packed but matches .gitignore',
  ]);
  assert.deepEqual(PC.problems({ packed: tracked, tracked, ignored: [] }), []);
  assert.deepEqual(PC.problems({ packed: ['package.json'], tracked, ignored: [] }), [
    'bridge/supervisor.js is missing from the package',
    'setup.js is missing from the package',
    'README.md is missing from the package',
    'LICENSE is missing from the package',
  ]);
});

test('publishProblems: publishing needs GitHub Actions and a clean checkout', () => {
  assert.deepEqual(PC.publishProblems({ env: { GITHUB_ACTIONS: 'true' }, status: '' }), []);
  assert.match(PC.publishProblems({ env: {}, status: '' })[0], /GitHub Actions/);
  assert.match(PC.publishProblems({ env: { GITHUB_ACTIONS: 'true' }, status: '?? bridge/config.json\n' })[0], /not clean/);
});

test('the files list packs no runtime file that a checkout used as the bridge home holds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wow-pack-'));
  try {
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
    for (const rel of [...RUNTIME_FILES, ...CODE_FILES]) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), 'x');
    }
    const packed = PC.packedPaths(dir);
    assert.deepEqual(
      RUNTIME_FILES.filter(f => packed.includes(f)),
      [],
      packed.join('\n'),
    );
    for (const code of CODE_FILES) assert.ok(packed.includes(code), code);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('this checkout packs only tracked files that .gitignore does not match, and no tests or internal docs', () => {
  const packed = PC.packedPaths();
  assert.deepEqual(PC.problems({ packed, tracked: PC.trackedPaths(), ignored: PC.ignoredPaths(packed) }), []);
  for (const p of packed) assert.ok(!/^(tests|docs\/plans)\/|^CLAUDE\.md$|^\.claude\//.test(p), p);
});
