'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FS = require('../bridge/fsutil');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wow-fsutil-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const tempFilesIn = dir => fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));

test('atomicWrite: the file holds the content, no temp file stays, and the mode is applied', t => {
  const dir = scratch(t);
  const file = path.join(dir, 'state.json');
  FS.atomicWrite(file, '{"a":1}\n', { mode: 0o600 });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n');
  assert.deepEqual(tempFilesIn(dir), []);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  FS.atomicWrite(file, Buffer.from('two'), { fsync: true });
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  assert.deepEqual(tempFilesIn(dir), []);
});

test('atomicWrite: a failing rename throws and leaves no temp file behind', t => {
  const dir = scratch(t);
  const target = path.join(dir, 'busy');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep'), 'x');
  assert.throws(() => FS.atomicWrite(target, 'content'));
  assert.deepEqual(tempFilesIn(dir), []);
  assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'x');
});

test('atomicWrite: two writers to the same file never share a temp name', t => {
  const dir = scratch(t);
  const file = path.join(dir, 'shared.json');
  const seen = new Set();
  const openSync = fs.openSync;
  t.mock.method(fs, 'openSync', (p, ...rest) => {
    seen.add(p);
    return openSync(p, ...rest);
  });
  FS.atomicWrite(file, 'a');
  FS.atomicWrite(file, 'b');
  assert.equal(seen.size, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), 'b');
});

test('readJson: a JSON file parses, a missing file gives the fallback without a log line', t => {
  const dir = scratch(t);
  const file = path.join(dir, 'ok.json');
  fs.writeFileSync(file, '{"n":2}');
  assert.deepEqual(FS.readJson(file, null), { n: 2 });
  const lines = [];
  assert.deepEqual(FS.readJson(path.join(dir, 'missing.json'), { fresh: true }, { log: l => lines.push(l) }), { fresh: true });
  assert.deepEqual(lines, []);
});

test('readJson: a non-JSON file gives the fallback and stays in place by default', t => {
  const dir = scratch(t);
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{not json');
  const lines = [];
  assert.equal(FS.readJson(file, 'fallback', { log: l => lines.push(l) }), 'fallback');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /bad\.json is not JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
  assert.equal(FS.readJson(file, 7), 7);
});

test('readJson: with moveAside a corrupt file is kept under a .corrupt- name and the log says how to recover', t => {
  const dir = scratch(t);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{broken');
  const lines = [];
  assert.deepEqual(FS.readJson(file, {}, { log: l => lines.push(l), moveAside: true }), {});
  assert.equal(fs.existsSync(file), false);
  const aside = fs.readdirSync(dir).filter(f => f.startsWith('state.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{broken');
  assert.match(lines[0], /state\.json is corrupt .*kept it as state\.json\.corrupt-.*put it back as state\.json/);
});

test('readJson: an unreadable file that exists is logged and gives the fallback', t => {
  const dir = scratch(t);
  const lines = [];
  assert.equal(FS.readJson(dir, 'fallback', { log: l => lines.push(l) }), 'fallback');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /cannot read it \(EISDIR\)/);
});

test('pidAlive: our own pid is alive, a bad pid is not', () => {
  assert.equal(FS.pidAlive(process.pid), true);
  assert.equal(FS.pidAlive(0), false);
  assert.equal(FS.pidAlive(-1), false);
  assert.equal(FS.pidAlive('12'), false);
  assert.equal(FS.pidAlive(NaN), false);
  assert.equal(FS.pidAlive(undefined), false);
});

test('pidAlive: EPERM means alive, the process exists but is not ours; ESRCH means gone', t => {
  const fail = code => () => {
    throw Object.assign(new Error(code), { code });
  };
  t.mock.method(process, 'kill', fail('EPERM'));
  assert.equal(FS.pidAlive(4242), true);
  process.kill.mock.mockImplementation(fail('ESRCH'));
  assert.equal(FS.pidAlive(4242), false);
});

test('probePid: alive with the code behind it, so a caller can tell our process from one of another user', t => {
  assert.deepEqual(FS.probePid(process.pid), { alive: true, code: null });
  assert.deepEqual(FS.probePid(0), { alive: false, code: 'EINVAL' });
  assert.deepEqual(FS.probePid('12'), { alive: false, code: 'EINVAL' });
  const fail = code => () => {
    throw Object.assign(new Error(code), { code });
  };
  t.mock.method(process, 'kill', fail('EPERM'));
  assert.deepEqual(FS.probePid(4242), { alive: true, code: 'EPERM' }, 'EPERM: the process exists and belongs to another user');
  assert.equal(FS.pidAlive(4242), true, 'pidAlive keeps the boolean view');
  process.kill.mock.mockImplementation(fail('ESRCH'));
  assert.deepEqual(FS.probePid(4242), { alive: false, code: 'ESRCH' });
  process.kill.mock.mockImplementation(() => {
    throw new Error('no code');
  });
  assert.deepEqual(FS.probePid(4242), { alive: false, code: 'ESRCH' }, 'a throw without a code counts as gone');
});

test('isSameProcess: a same-boot lock from another user is not the same process when the command is unknown', t => {
  const bootedAt = Date.now() - 60000;
  const now = Date.now();
  const same = (startedAt, command, platform) => FS.isSameProcess(4242, startedAt, 'bridge.js', { bootedAt, commandOf: () => command, platform });
  t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  });
  assert.equal(same(now, null, 'win32'), false, 'EPERM with no command: another user, so no exit 3');
  assert.equal(same(now, 'node bridge.js', 'darwin'), true, 'a readable command still decides');
  assert.equal(same(now, 'node other.js', 'darwin'), false);
  process.kill.mock.mockImplementation(() => undefined);
  assert.equal(same(now, null, 'win32'), true, 'our own live process on Windows keeps the old answer');
  assert.equal(same(now, null, 'darwin'), false, 'no command on a POSIX host is not the same process');
  assert.equal(same(bootedAt - 1, null, 'win32'), false, 'a lock from before this boot is stale');
  assert.equal(same(NaN, 'node bridge.js', 'darwin'), false);
  process.kill.mock.mockImplementation(() => {
    throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
  });
  assert.equal(same(now, 'node bridge.js', 'darwin'), false, 'a dead pid is never the same process');
});

test('isDirectory: true for a folder, false for a file and for nothing', t => {
  const dir = scratch(t);
  const file = path.join(dir, 'f');
  fs.writeFileSync(file, '');
  assert.equal(FS.isDirectory(dir), true);
  assert.equal(FS.isDirectory(file), false);
  assert.equal(FS.isDirectory(path.join(dir, 'nope')), false);
});
