// bridge/legacyenv.js: the CLAUDE_WOW_* variables from before the rename to
// WoWGPT still count, and never override a WOWGPT_* one.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const LE = require('../bridge/legacyenv');

test('adopt gives each CLAUDE_WOW_* value to its WOWGPT_* name when that one is unset', () => {
  const env = { CLAUDE_WOW_HOME: '/old', CLAUDE_WOW_PROJECT: '/p', WOWGPT_PROJECT: '/new', CLAUDE_WOWX: 'no', PATH: '/bin' };
  assert.deepEqual(LE.adopt(env), ['WOWGPT_HOME']);
  assert.equal(env.WOWGPT_HOME, '/old');
  assert.equal(env.WOWGPT_PROJECT, '/new', 'a set new name is never overwritten');
  assert.equal(env.CLAUDE_WOW_HOME, '/old', 'the old name stays for older children');
  assert.equal(env.WOWGPT_X, undefined, 'only the exact old prefix');
  assert.deepEqual(LE.adopt(env), [], 'twice is the same as once');
});

test('read prefers the new name, then the old one', () => {
  assert.equal(LE.read({ WOWGPT_HOME: '/n', CLAUDE_WOW_HOME: '/o' }, 'HOME'), '/n');
  assert.equal(LE.read({ CLAUDE_WOW_HOME: '/o' }, 'HOME'), '/o');
  assert.equal(LE.read({}, 'HOME'), undefined);
  assert.equal(LE.newName('CLAUDE_WOW_SERVICE'), 'WOWGPT_SERVICE');
  assert.equal(LE.newName('WOWGPT_SERVICE'), '');
});

test('an entry point started with only an old variable runs with the new one: setup.js adopts before it reads the home', () => {
  const home = path.resolve(path.join(require('os').tmpdir(), 'wowgpt-legacy-env-home'));
  const probe = spawnSync(process.execPath, ['-e', "require('./setup.js'); console.log(process.env.WOWGPT_HOME, process.env.WOWGPT_PROBE)"], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: '/nonexistent-home', USERPROFILE: '/nonexistent-home', CLAUDE_WOW_HOME: home, CLAUDE_WOW_PROBE: 'x' },
    timeout: 60000,
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), `${home} x`);
});
