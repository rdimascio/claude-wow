'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const G = require('../bridge/gamefs');

const posixOnly = { skip: process.platform === 'win32' };
const modeOf = file => fs.statSync(file).mode & 0o777;

function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `claude-wow-gamefs-${name}-`));
}

function withUmask(mask, fn) {
  const before = process.umask(mask);
  try {
    return fn();
  } finally {
    process.umask(before);
  }
}

test('atomicWrite replaces a file and leaves it 0777 whatever the umask and the old mode', posixOnly, () => {
  const dir = scratch('atomic');
  const file = path.join(dir, 'Inbox.lua');
  fs.writeFileSync(file, 'old', { mode: 0o600 });
  withUmask(0o077, () => G.atomicWrite(file, 'new'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.equal(modeOf(file), 0o777);
  assert.deepEqual(fs.readdirSync(dir), ['Inbox.lua']);
  fs.rmSync(dir, { recursive: true, force: true });
});

function victimIn(dir) {
  const victim = path.join(dir, 'victim');
  fs.writeFileSync(victim, 'secret', { mode: 0o600 });
  return victim;
}

function assertUntouched(victim) {
  assert.equal(fs.readFileSync(victim, 'utf8'), 'secret');
  assert.equal(modeOf(victim), 0o600);
}

test('atomicWrite never writes or chmods through a link planted at the old fixed temp name', posixOnly, () => {
  const dir = scratch('planted-tmp');
  const victim = victimIn(dir);
  const folder = path.join(dir, 'ClaudeWoW_S001');
  fs.mkdirSync(folder);
  const file = path.join(folder, 'Inbox.lua');
  fs.symlinkSync(victim, file + '.tmp');
  G.atomicWrite(file, 'payload');
  assertUntouched(victim);
  assert.equal(fs.readFileSync(file, 'utf8'), 'payload');
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a link planted at the random temp name makes the write fail instead of following it', posixOnly, t => {
  const dir = scratch('planted-random');
  const victim = victimIn(dir);
  const file = path.join(dir, 'Inbox.lua');
  const fixed = Buffer.alloc(8, 0xab);
  t.mock.method(crypto, 'randomBytes', () => fixed);
  fs.symlinkSync(victim, `${file}.${fixed.toString('hex')}.tmp`);
  assert.throws(() => G.atomicWrite(file, 'payload'), { code: 'EEXIST' });
  assertUntouched(victim);
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFile and copyFile replace a link at the target instead of writing through it', posixOnly, () => {
  const dir = scratch('linked-target');
  const victim = victimIn(dir);
  const src = path.join(dir, 'src.lua');
  fs.writeFileSync(src, 'copied');
  const written = path.join(dir, 'w.lua');
  const copied = path.join(dir, 'c.lua');
  fs.symlinkSync(victim, written);
  fs.symlinkSync(victim, copied);
  G.writeFile(written, 'payload');
  G.copyFile(src, copied);
  assertUntouched(victim);
  assert.equal(fs.lstatSync(written).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(copied).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(written, 'utf8'), 'payload');
  assert.equal(fs.readFileSync(copied, 'utf8'), 'copied');
  assert.equal(modeOf(written), 0o777);
  assert.equal(modeOf(copied), 0o777);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a write into a folder that is a link is refused and leaves the linked folder alone', posixOnly, () => {
  const dir = scratch('linked-folder');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const folder = path.join(dir, 'ClaudeWoW_S001');
  fs.symlinkSync(home, folder);
  assert.throws(() => G.atomicWrite(path.join(folder, 'Inbox.lua'), 'payload'), { code: 'EUNSAFE' });
  assert.throws(() => G.writeFile(path.join(folder, 'Inbox.lua'), 'payload'), { code: 'EUNSAFE' });
  assert.deepEqual(fs.readdirSync(home), []);
  assert.equal(modeOf(home), 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the publish note gives the refusal reason for an unsafe folder and the setup hint only for a missing one', posixOnly, () => {
  const dir = scratch('publish-note');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const linked = path.join(dir, 'ClaudeWoW_Runtime');
  fs.symlinkSync(home, linked);
  const failure = target => {
    try {
      G.atomicWrite(target, 'payload');
    } catch (e) {
      return e;
    }
    assert.fail('the write did not fail');
  };
  const unsafeFile = path.join(linked, 'Inbox.lua');
  const unsafeNote = G.publishFailureNote(unsafeFile, '_classic_era_', failure(unsafeFile));
  assert.match(unsafeNote, /^publish: refused to write .*Inbox\.lua in _classic_era_: .*not a real folder$/);
  assert.doesNotMatch(unsafeNote, /setup|not installed/);
  const missingFile = path.join(dir, 'Gone', 'Inbox.lua');
  const missingNote = G.publishFailureNote(missingFile, '_classic_era_', failure(missingFile));
  assert.equal(missingNote, `publish: cannot write ${missingFile} (ENOENT); addon not installed in _classic_era_? run: node setup.js, then restart WoW`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('repair does not chmod a link swapped in after the walk checked the entry', posixOnly, t => {
  const addons = scratch('repair-swap');
  const victim = victimIn(addons);
  const folder = path.join(addons, 'ClaudeWoW_S001');
  fs.mkdirSync(folder, { mode: 0o755 });
  const inbox = path.join(folder, 'Inbox.lua');
  fs.writeFileSync(inbox, 'x', { mode: 0o644 });
  const realLstat = fs.lstatSync;
  let swapped = false;
  t.mock.method(fs, 'lstatSync', (target, ...rest) => {
    const st = realLstat(target, ...rest);
    if (target === inbox && !swapped) {
      swapped = true;
      fs.unlinkSync(inbox);
      fs.symlinkSync(victim, inbox);
    }
    return st;
  });
  const result = G.repair(addons);
  t.mock.restoreAll();
  assert.equal(swapped, true);
  assertUntouched(victim);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0], /Inbox\.lua/);
  assert.equal(modeOf(folder), 0o777);
  fs.rmSync(addons, { recursive: true, force: true });
});

test('repair sets every file and folder under the ClaudeWoW addon folders to 0777 and nothing else', posixOnly, () => {
  const addons = scratch('repair');
  const presence = path.join(addons, 'ClaudeWoW_Runtime', 'presence');
  fs.mkdirSync(presence, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(presence, '0007.wav'), 'RIFF', { mode: 0o644 });
  fs.mkdirSync(path.join(addons, 'ClaudeWoW'), { mode: 0o755 });
  fs.mkdirSync(path.join(addons, 'ClaudeWoW_Runtimes'), { mode: 0o755 });
  fs.mkdirSync(path.join(addons, 'ClaudeWoW_S001'), { mode: 0o755 });
  fs.writeFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'x', { mode: 0o644 });
  fs.mkdirSync(path.join(addons, 'SomeOtherAddon'), { mode: 0o755 });
  fs.writeFileSync(path.join(addons, 'SomeOtherAddon', 'a.lua'), 'x', { mode: 0o644 });
  const first = G.repair(addons);
  assert.equal(first.fixed, first.checked);
  assert.ok(first.fixed >= 5);
  assert.deepEqual(first.failed, []);
  for (const f of [
    path.join(addons, 'ClaudeWoW'),
    path.join(addons, 'ClaudeWoW_Runtime'),
    presence,
    path.join(presence, '0007.wav'),
    path.join(addons, 'ClaudeWoW_S001'),
    path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'),
  ]) {
    assert.equal(modeOf(f), 0o777, f);
  }
  assert.equal(modeOf(path.join(addons, 'ClaudeWoW_Runtimes')), 0o755, 'only the exact runtime folder name counts');
  assert.equal(modeOf(path.join(addons, 'SomeOtherAddon', 'a.lua')), 0o644, 'another addon is not touched');
  const again = G.repair(addons);
  assert.equal(again.fixed, 0);
  assert.deepEqual(G.repair(path.join(addons, 'missing')), { checked: 0, fixed: 0, failed: [] });
  fs.rmSync(addons, { recursive: true, force: true });
});

test('repair fixes a file its owner cannot read and never chmods a hard link to a file outside the addon folders', posixOnly, () => {
  const addons = scratch('repair-links');
  const slot = path.join(addons, 'ClaudeWoW_S001');
  fs.mkdirSync(slot, { mode: 0o777 });
  fs.chmodSync(slot, 0o777);
  const unreadable = path.join(slot, 'Inbox.lua');
  fs.writeFileSync(unreadable, 'x');
  fs.chmodSync(unreadable, 0o200);
  const outside = path.join(addons, 'outside.lua');
  fs.writeFileSync(outside, 'secret');
  fs.chmodSync(outside, 0o644);
  const linked = path.join(slot, 'Linked.lua');
  fs.linkSync(outside, linked);
  const result = G.repair(addons);
  assert.equal(modeOf(unreadable), 0o777);
  assert.equal(modeOf(outside), 0o644);
  assert.deepEqual(result.failed, [`${linked} (EUNSAFE)`]);
  assert.equal(G.writeFile(linked, 'secret'), true);
  assert.equal(modeOf(outside), 0o644);
  assert.notEqual(fs.statSync(linked).ino, fs.statSync(outside).ino);
  assert.equal(modeOf(linked), 0o777);
  fs.rmSync(addons, { recursive: true, force: true });
});

test('writeFile and copyFile skip a file that already has the content, fix its mode, and still rewrite a changed one', () => {
  const dir = scratch('unchanged');
  const file = path.join(dir, 'w.lua');
  const src = path.join(dir, 'src.lua');
  const copied = path.join(dir, 'c.lua');
  fs.writeFileSync(src, 'copied');
  assert.equal(G.writeFile(file, 'same'), true);
  assert.equal(G.copyFile(src, copied), true);
  const before = fs.statSync(file).ino;
  if (process.platform !== 'win32') fs.chmodSync(file, 0o644);
  assert.equal(G.writeFile(file, 'same'), false);
  assert.equal(G.copyFile(src, copied), false);
  assert.equal(fs.statSync(file).ino, before, 'an unchanged file is left in place');
  if (process.platform !== 'win32') assert.equal(modeOf(file), 0o777);
  assert.equal(G.writeFile(file, 'sane'), true, 'same size, other bytes');
  assert.equal(fs.readFileSync(file, 'utf8'), 'sane');
  assert.equal(G.writeFile(file, 'longer text'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'longer text');
  fs.writeFileSync(src, 'changed');
  assert.equal(G.copyFile(src, copied), true);
  assert.equal(fs.readFileSync(copied, 'utf8'), 'changed');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['c.lua', 'src.lua', 'w.lua']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureFile creates a missing file and its folders 0777 and never writes through a dangling link', posixOnly, () => {
  const dir = scratch('ensure');
  const file = path.join(dir, 'a', 'b', '001.wav');
  assert.equal(
    withUmask(0o077, () => G.ensureFile(file, 'RIFF')),
    true,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), 'RIFF');
  assert.equal(modeOf(file), 0o777);
  assert.equal(modeOf(path.join(dir, 'a')), 0o777);
  assert.equal(G.ensureFile(file, 'other'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'RIFF');
  const target = path.join(dir, 'outside.wav');
  const linked = path.join(dir, 'a', 'b', '002.wav');
  fs.symlinkSync(target, linked);
  assert.equal(G.ensureFile(linked, 'RIFF'), false);
  assert.equal(fs.existsSync(target), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
