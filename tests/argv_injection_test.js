// A record from the game is unauthenticated. Its allow=/once= rules, model,
// effort and resume id end up in an agent CLI's argv; a value that starts with a
// dash would be read as an option (--dangerously-skip-permissions, --add-dir,
// --mcp-config ...) and end the variadic --allowedTools list. These tests drive
// the record through parseFlags/parseOutbox and the real args builders.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../bridge/agents');
const P = require('../bridge/protocol');

const hex = s => Buffer.from(s, 'utf8').toString('hex');

const INJECTED = ['--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions', '--add-dir', '/', '--mcp-config', '/tmp/evil.json', '-y'];

const BENIGN = { allow: ['Read'], model: 'm', effort: 'e', resume: 'r' };

function optionsIn(argv) {
  return argv.filter(a => typeof a === 'string' && a.startsWith('-'));
}

function agentArgv(id, job, cfg = {}) {
  const acfg = P.withRunOnlyRules({ ...cfg, model: job.model, effort: job.effort }, [...(job.allow || []), ...(job.allowOnce || [])]);
  return A.AGENTS[id].args({ cfg: acfg, resume: job.resume || '', cwd: '/p', system: '', images: [], promptFile: '/p/f', prompt: 'hi' });
}

test('isToolRule takes tool names, rules with balanced arguments and mcp names only', () => {
  for (const ok of [
    'Read',
    'WebFetch',
    'Bash(git status:*)',
    'Read(//Users/me/**)',
    'AddDir(C:\\Program Files (x86)\\x)',
    'mcp__wow-data__wow_item',
    'mcp__wowgpt',
  ])
    assert.ok(P.isToolRule(ok), ok);
  for (const bad of [
    '--dangerously-skip-permissions',
    '-y',
    '--add-dir',
    'bypassPermissions)',
    'Bash(git',
    'Bash(a))(',
    'Bash(x)y',
    '1Read',
    'Re ad',
    'Bash(\nx)',
    '',
    'R'.repeat(401),
  ])
    assert.ok(!P.isToolRule(bad), JSON.stringify(bad));
});

test('parseFlags drops allow= and once= rules that are not tool rules', () => {
  const f = P.parseFlags('allow=Read,--dangerously-skip-permissions,--add-dir,/;once=Bash(git log:*),--permission-mode,bypassPermissions');
  assert.deepEqual(f.allow, ['Read']);
  assert.deepEqual(f.allowOnce, ['Bash(git log:*)', 'bypassPermissions'], 'a bare word is a tool name, harmless without its option');
});

test('parseFlags refuses a model, effort or resume id that starts with a dash', () => {
  const f = P.parseFlags('model=--dangerously-skip-permissions;effort=-x;resume=--add-dir');
  assert.equal(f.model, undefined);
  assert.equal(f.effort, undefined);
  assert.equal(f.resume, undefined);
  const ok = P.parseFlags('model=claude-opus-4[1m];effort=high;resume=abc-1');
  assert.equal(ok.model, 'claude-opus-4[1m]');
  assert.equal(ok.effort, 'high');
  assert.equal(ok.resume, 'abc-1');
});

test('parseOutbox drops injected allow and allowOnce rules', () => {
  const src = `WoWGPTDB = { ["outbox"] = { ["id"] = 4, ["text"] = "${hex('hi')}", ["allow"] = "${hex(['Read', '--add-dir', '/'].join('\x1F'))}", ["allowOnce"] = "${hex(['--mcp-config', 'Grep'].join('\x1F'))}", } }`;
  const job = P.parseOutbox(src);
  assert.deepEqual(job.allow, ['Read']);
  assert.deepEqual(job.allowOnce, ['Grep']);
});

test('no injected option reaches any agent argv from a record', () => {
  const flags = `allow=Read,${INJECTED.join(',')};once=${INJECTED.join(',')};model=--add-dir;effort=--yolo;resume=--mcp-config`;
  const job = P.parseFlags(flags);
  for (const id of A.agentIds()) {
    const base = optionsIn(agentArgv(id, BENIGN));
    const argv = agentArgv(id, job);
    for (const opt of optionsIn(argv)) assert.ok(base.includes(opt), `${id}: ${opt} came from the record`);
    for (const bad of INJECTED.filter(x => x.startsWith('-'))) if (!base.includes(bad)) assert.ok(!argv.includes(bad), `${id}: ${bad}`);
    assert.ok(!argv.includes('/tmp/evil.json') && !argv.includes('/'), `${id}: a path from the record reached argv`);
    assert.notEqual(argv[argv.indexOf('--permission-mode') + 1], 'bypassPermissions', `${id}: the record set the permission mode`);
  }
});

test('the args builders drop dash values even when a rule skipped the intake check', () => {
  const job = { allow: ['Read', '--dangerously-skip-permissions'], allowOnce: ['--add-dir', '/'], model: '--mcp-config', effort: '-x', resume: '--add-dir' };
  const cfg = { deniedTools: ['--permission-mode', 'Write'] };
  const claude = agentArgv('claude', job, cfg);
  assert.deepEqual(claude.slice(claude.indexOf('--allowedTools') + 1, claude.indexOf('--disallowedTools')), ['Read', '/']);
  assert.deepEqual(claude.slice(claude.indexOf('--disallowedTools') + 1), ['Write']);
  for (const id of A.agentIds()) {
    const base = optionsIn(agentArgv(id, BENIGN, cfg));
    for (const opt of optionsIn(agentArgv(id, job, cfg))) assert.ok(base.includes(opt), `${id}: ${opt} reached argv`);
  }
});
