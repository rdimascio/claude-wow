'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const REL = require('../bridge/releases');

const NO_SYMLINKS = process.platform === 'win32';

function scratch(name) {
  const dir = path.join(__dirname, 'tmp', 'releases', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fakeBinary(dir, text) {
  const file = path.join(dir, `built-${text}`);
  fs.writeFileSync(file, text);
  return file;
}

function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = ms => { t += ms; };
  return now;
}

test('the lock: one holder at a time, a second caller is refused with the holder named, and only the holder releases it', () => {
  const l = REL.layout(scratch('lock'));
  const first = REL.acquireLock(l.lock, { pid: 4242, command: 'dev deploy', alive: () => true });
  assert.ok(fs.existsSync(l.lock));
  assert.throws(() => REL.acquireLock(l.lock, { pid: 5151, alive: () => true }), /another deploy holds .*pid 4242 \(dev deploy\)/);
  const elsewhere = REL.acquireLock(path.join(l.base, 'other.lock'), { pid: 5151, alive: () => true });
  assert.match(elsewhere.token, /^[0-9a-f]{32}$/);
  assert.notEqual(elsewhere.token, first.token);
  assert.equal(REL.releaseLock(l.lock, elsewhere.token), false, 'a real token of another lock cannot release this one');
  assert.equal(REL.releaseLock(l.lock, ''), false, 'no token releases nothing');
  assert.ok(fs.existsSync(l.lock));
  assert.equal(REL.readLock(l.lock).token, first.token, 'the holder still holds it');
  assert.equal(elsewhere.release(), true);
  assert.equal(first.release(), true);
  assert.ok(!fs.existsSync(l.lock));
  const second = REL.acquireLock(l.lock, { pid: 5151, alive: () => true });
  assert.equal(second.staleRemoved, false);
  second.release();
});

test('a stale lock is taken over: a dead holder, an old one, an unreadable one past its grace; a live, recent holder never is', () => {
  const l = REL.layout(scratch('stale'));
  const now = clock();
  const dead = new Set([4242]);
  const alive = pid => !dead.has(pid);
  REL.acquireLock(l.lock, { pid: 4242, alive, now });
  const taken = REL.acquireLock(l.lock, { pid: 5151, alive, now });
  assert.equal(taken.staleRemoved, true, 'the dead holder\'s lock was removed');
  assert.equal(REL.readLock(l.lock).pid, 5151);
  assert.deepEqual(fs.readdirSync(path.dirname(l.lock)).filter(f => f.includes('stale')), [], 'no aside file is left behind');

  assert.throws(() => REL.acquireLock(l.lock, { pid: 6161, alive, now }), /another deploy holds/, 'a live holder keeps it');
  now.advance(REL.LOCK_MAX_AGE_MS + 1);
  assert.equal(REL.acquireLock(l.lock, { pid: 6161, alive, now }).staleRemoved, true, 'past the maximum age, even a live pid loses it');

  fs.writeFileSync(l.lock, '');
  const fresh = clock(fs.statSync(l.lock).mtimeMs);
  assert.throws(() => REL.acquireLock(l.lock, { pid: 7171, alive, now: fresh }), /has not written its pid yet/, 'an empty lock may be one being written');
  fresh.advance(61 * 1000);
  assert.equal(REL.acquireLock(l.lock, { pid: 7171, alive, now: fresh }).staleRemoved, true);
});

test('a stale lock is taken over only when the file moved aside is the one judged stale: a pid-less lock replaced in between is put back', () => {
  const l = REL.layout(scratch('stale-race'));
  const old = clock(10_000_000);
  fs.writeFileSync(l.lock, '');
  const judged = REL.readLock(l.lock);
  assert.equal(judged.pid, 0);
  fs.writeFileSync(`${l.lock}.next`, '');
  fs.renameSync(`${l.lock}.next`, l.lock);
  const replaced = REL.readLock(l.lock);
  assert.equal(replaced.pid, 0, 'the new file is just as pid-less as the old one');
  assert.throws(() => REL.takeOverStale(l.lock, judged, 5151), /another deploy holds/);
  assert.ok(fs.existsSync(l.lock), 'the newer lock is back in place');
  assert.equal(REL.readLock(l.lock).ino, replaced.ino);
  assert.deepEqual(fs.readdirSync(path.dirname(l.lock)).filter(f => f.includes('stale')), []);
  fs.unlinkSync(l.lock);

  const a = REL.acquireLock(l.lock, { pid: 4242, alive: () => false, now: old });
  const seenByB = REL.readLock(l.lock);
  const c = REL.acquireLock(l.lock, { pid: 6161, alive: pid => pid === 6161, now: old });
  assert.equal(c.staleRemoved, true);
  assert.throws(() => REL.takeOverStale(l.lock, seenByB, 5151), /pid 6161/, 'B, late with its view of the dead lock, does not remove the lock C took');
  assert.equal(REL.readLock(l.lock).token, c.token);
  assert.equal(a.release(), false, 'the old holder cannot release the new one');
  assert.equal(c.release(), true);
});

test('three deploys racing for a stale lock: when the lock moved aside cannot be put back, the takeover fails closed and the deploy that lost its lock cannot switch', () => {
  const l = REL.layout(scratch('stale-race-three'));
  const now = clock();
  fs.writeFileSync(l.lock, JSON.stringify({ pid: 4242, host: require('os').hostname(), started: now(), token: 'dead-holder', phase: REL.PREPARING }));
  const judgedByB = REL.readLock(l.lock);
  const a = REL.acquireLock(l.lock, { pid: 5151, alive: pid => pid === 5151, now });
  assert.equal(a.staleRemoved, true);
  a.assertHeld();
  const realLink = fs.linkSync;
  const cLock = JSON.stringify({ pid: 6161, host: require('os').hostname(), started: now(), token: 'c-holder', phase: REL.PREPARING });
  fs.linkSync = (from, to) => {
    if (String(from).includes('.stale-') && to === l.lock) fs.writeFileSync(l.lock, cLock);
    return realLink(from, to);
  };
  try {
    assert.throws(() => REL.takeOverStale(l.lock, judgedByB, 7171), /could not be put back because another deploy took the lock in between/);
  } finally {
    fs.linkSync = realLink;
  }
  assert.equal(REL.readLock(l.lock).token, 'c-holder', 'C holds the lock');
  assert.deepEqual(fs.readdirSync(path.dirname(l.lock)).filter(f => f.includes('stale')), [], 'no aside file is left behind');
  assert.throws(() => a.assertHeld(), /no longer held by this process/, 'A finds out before it switches');
  assert.throws(() => a.setPhase(REL.SWITCHING), /no longer held by this process/);
  assert.equal(a.release(), false, 'A cannot remove C\'s lock');
  assert.ok(fs.existsSync(l.lock));
});

test('a new lock is never seen half written, carries a token, and only its token releases it or marks it switching', () => {
  const l = REL.layout(scratch('lock-token'));
  const now = clock();
  const lock = REL.acquireLock(l.lock, { pid: 4242, command: 'dev deploy', alive: () => true, now });
  const held = REL.readLock(l.lock);
  assert.match(held.token, /^[0-9a-f]{32}$/);
  assert.equal(held.token, lock.token);
  assert.equal(held.phase, REL.PREPARING);
  assert.deepEqual(fs.readdirSync(path.dirname(l.lock)).filter(f => f.endsWith('.new')), [], 'no temp file left');
  assert.equal(REL.releaseLock(l.lock, 'not-the-token'), false);
  assert.equal(REL.switchingHolder(l.lock, { alive: () => true, now }), null, 'preparing is not switching');
  lock.setPhase(REL.SWITCHING);
  const switching = REL.readLock(l.lock);
  assert.deepEqual([switching.phase, switching.token, switching.pid, switching.command], [REL.SWITCHING, lock.token, 4242, 'dev deploy']);
  assert.equal(REL.switchingHolder(l.lock, { alive: () => true, now }).pid, 4242);
  assert.equal(REL.switchingHolder(l.lock, { alive: () => false, now }), null, 'a dead deployer holds nothing');
  assert.equal(REL.switchingHolder(l.lock, { alive: () => true, now, host: 'another-host' }), null, 'a lock from another machine holds nothing here');
  fs.writeFileSync(l.lock, JSON.stringify({ ...JSON.parse(fs.readFileSync(l.lock, 'utf8')), token: 'someone-else' }));
  assert.throws(() => lock.setPhase(REL.SWITCHING), /no longer held by this process/);
  assert.equal(lock.release(), false);
});

test('a flip that fails puts previous back as it was, so the way back to the release before is not lost', { skip: NO_SYMLINKS }, () => {
  const base = scratch('flip-order');
  const l = REL.layout(base);
  for (const n of ['a', 'b', 'c']) REL.installRelease(l, { name: `0.5.0-${n}`, binaryFile: fakeBinary(base, n) });
  REL.activate(l, '0.5.0-a');
  assert.ok(!fs.existsSync(l.previous), 'nothing before the first release');
  const failFlip = { point: () => { throw new Error('the flip failed'); } };
  assert.throws(() => REL.activate(l, '0.5.0-b', failFlip), /the flip failed/);
  assert.ok(!fs.existsSync(l.previous), 'still no previous: a rollback cannot "go back" to the current release');
  assert.equal(REL.currentName(l), '0.5.0-a');
  REL.activate(l, '0.5.0-b');
  assert.deepEqual([REL.currentName(l), REL.previousName(l)], ['0.5.0-b', '0.5.0-a']);
  let seenDuringFlip = '';
  assert.throws(() => REL.activate(l, '0.5.0-c', { point: () => { seenDuringFlip = REL.previousName(l); throw new Error('the flip failed'); } }), /the flip failed/);
  assert.equal(seenDuringFlip, '0.5.0-b', 'previous is written before current moves');
  assert.deepEqual([REL.currentName(l), REL.previousName(l)], ['0.5.0-b', '0.5.0-a'], 'previous is a again');
  assert.equal(REL.rollback(l).name, '0.5.0-a', 'the rollback route survives the failed flip');
  assert.deepEqual(fs.readdirSync(base).filter(f => f.endsWith('.tmp')), []);
});

test('a deploy that died after it wrote previous and before the flip: rollback names the state and the way out, and running the deploy again repairs previous', { skip: NO_SYMLINKS }, () => {
  const base = scratch('died-before-flip');
  const l = REL.layout(base);
  for (const n of ['a', 'b', 'c']) REL.installRelease(l, { name: `0.5.0-${n}`, binaryFile: fakeBinary(base, n) });
  REL.activate(l, '0.5.0-a');
  REL.activate(l, '0.5.0-b');
  let diedAt = null;
  assert.throws(() => REL.activate(l, '0.5.0-c', { point: () => { diedAt = [REL.currentName(l), REL.previousName(l)]; throw new Error('killed'); } }), /killed/);
  fs.writeFileSync(l.previous, `${diedAt[1]}\n`);
  assert.deepEqual([REL.currentName(l), REL.previousName(l)], ['0.5.0-b', '0.5.0-b'], 'the state a kill between the two writes leaves');
  assert.throws(() => REL.rollback(l), e => {
    assert.match(e.message, /names 0\.5\.0-b, the current release, so there is nothing to roll back to/);
    assert.match(e.message, /stopped after it wrote .*previous and before it switched/);
    assert.match(e.message, /To finish that deploy, run it again/);
    return true;
  });
  assert.equal(REL.currentName(l), '0.5.0-b', 'nothing moved');
  REL.activate(l, '0.5.0-c');
  assert.deepEqual([REL.currentName(l), REL.previousName(l)], ['0.5.0-c', '0.5.0-b'], 'the deploy run again records the right previous');
  assert.equal(REL.rollback(l).name, '0.5.0-b');
});

test('a release counts only once its binary and release.json are flushed and the folder has its final name; a folder without the marker is never reused', { skip: NO_SYMLINKS }, () => {
  const base = scratch('durable');
  const l = REL.layout(base);
  const opened = new Map();
  const steps = [];
  const realOpen = fs.openSync, realFsync = fs.fsyncSync, realRename = fs.renameSync;
  fs.openSync = (p, ...rest) => { const fd = realOpen(p, ...rest); opened.set(fd, String(p)); return fd; };
  fs.fsyncSync = fd => { steps.push(['fsync', path.relative(base, opened.get(fd) || '?')]); return realFsync(fd); };
  fs.renameSync = (from, to) => { steps.push(['rename', path.basename(String(from)).replace(/-\d+-[0-9a-f]{8}$/, ''), path.relative(base, String(to))]); return realRename(from, to); };
  try {
    REL.installRelease(l, { name: '0.5.0-ok', binaryFile: fakeBinary(base, 'ok') });
  } finally {
    fs.openSync = realOpen;
    fs.fsyncSync = realFsync;
    fs.renameSync = realRename;
  }
  const staged = steps.map(s => s.join(' ').replace(/\.staging-0\.5\.0-ok-\d+-[0-9a-f]{8}/, '<staging>'));
  assert.deepEqual(staged, [
    `fsync ${path.join('releases', '<staging>', REL.BINARY)}`,
    `fsync ${path.join('releases', '<staging>', REL.RELEASE_INFO)}`,
    `fsync ${path.join('releases', '<staging>')}`,
    `rename .staging-0.5.0-ok ${path.join('releases', '0.5.0-ok')}`,
    'fsync releases',
  ]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(REL.releaseDir(l, '0.5.0-ok'), REL.RELEASE_INFO), 'utf8')).complete, true);
  assert.equal(REL.hasRelease(l, '0.5.0-ok'), true);

  const half = REL.releaseDir(l, '0.5.0-half');
  fs.mkdirSync(half);
  fs.writeFileSync(path.join(half, REL.BINARY), '');
  assert.equal(REL.hasRelease(l, '0.5.0-half'), false, 'a binary without release.json is not a release');
  fs.writeFileSync(path.join(half, REL.RELEASE_INFO), '');
  assert.equal(REL.hasRelease(l, '0.5.0-half'), false, 'nor with an empty release.json');
  fs.writeFileSync(path.join(half, REL.RELEASE_INFO), JSON.stringify({ name: '0.5.0-half' }));
  assert.equal(REL.hasRelease(l, '0.5.0-half'), false, 'nor with a release.json that does not say complete');
  assert.throws(() => REL.installRelease(l, { name: '0.5.0-half' }), /is not a finished release, so it is not reused/);
  assert.throws(() => REL.activate(l, '0.5.0-half'), /has no claude-wow/);
  const redone = REL.installRelease(l, { name: '0.5.0-half', binaryFile: fakeBinary(base, 'half') });
  assert.equal(redone.reused, false);
  assert.equal(fs.readFileSync(REL.releaseBinary(l, '0.5.0-half'), 'utf8'), 'half');
  assert.equal(REL.hasRelease(l, '0.5.0-half'), true);
});

test('pruning removes the staging folders of installs whose process is gone and keeps a live one', { skip: NO_SYMLINKS }, () => {
  const base = scratch('prune-staging');
  const l = REL.layout(base);
  REL.installRelease(l, { name: 'r1', binaryFile: fakeBinary(base, 'r1') });
  REL.activate(l, 'r1');
  const dead = path.join(l.releases, '.staging-0.5.0-abc-4242-0123abcd');
  const live = path.join(l.releases, '.staging-0.5.0-abc-5151-89abcdef');
  for (const d of [dead, live]) { fs.mkdirSync(d); fs.writeFileSync(path.join(d, REL.BINARY), 'partial'); }
  const r = REL.prune(l, 5, { alive: pid => pid === 5151 });
  assert.deepEqual(r.staging, [path.basename(dead)]);
  assert.ok(!fs.existsSync(dead));
  assert.ok(fs.existsSync(live));
  assert.deepEqual(REL.listReleases(l).map(x => x.name), ['r1']);
});

test('the flip: current is a symlink into releases, previous is recorded, the same release twice changes nothing', { skip: NO_SYMLINKS }, () => {
  const base = scratch('flip');
  const l = REL.layout(base);
  assert.equal(REL.currentName(l), '');
  REL.installRelease(l, { name: '0.5.0-aaa', binaryFile: fakeBinary(base, 'a') });
  const first = REL.activate(l, '0.5.0-aaa');
  assert.deepEqual(first, { name: '0.5.0-aaa', previous: '', changed: true });
  assert.ok(fs.lstatSync(l.current).isSymbolicLink());
  assert.equal(fs.readlinkSync(l.current), path.join('releases', '0.5.0-aaa'), 'relative, so the home folder can move');
  assert.equal(fs.readFileSync(REL.currentBinary(l), 'utf8'), 'a');
  assert.equal(REL.previousName(l), '', 'nothing before the first release');
  assert.equal(fs.statSync(REL.releaseBinary(l, '0.5.0-aaa')).mode & 0o111, 0o111, 'executable');

  REL.installRelease(l, { name: '0.5.0-bbb', binaryFile: fakeBinary(base, 'b') });
  assert.deepEqual(REL.activate(l, '0.5.0-bbb'), { name: '0.5.0-bbb', previous: '0.5.0-aaa', changed: true });
  assert.equal(fs.readFileSync(REL.currentBinary(l), 'utf8'), 'b');
  assert.equal(REL.previousName(l), '0.5.0-aaa');
  assert.deepEqual(REL.activate(l, '0.5.0-bbb'), { name: '0.5.0-bbb', previous: '0.5.0-aaa', changed: false });
  assert.equal(REL.previousName(l), '0.5.0-aaa', 'flipping to the current release does not record it as previous');
  assert.deepEqual(fs.readdirSync(base).filter(f => f.endsWith('.tmp')), [], 'no temp symlink left');

  assert.throws(() => REL.activate(l, '0.5.0-missing'), /has no claude-wow/);
  assert.equal(REL.currentName(l), '0.5.0-bbb', 'a failed flip leaves current alone');
  assert.throws(() => REL.activate(l, '../evil'), /not a usable release name/);
  assert.throws(() => REL.installRelease(l, { name: '0.5.0-bbb', binaryFile: fakeBinary(base, 'b2') }), /current release; it is not replaced in place/);
  assert.equal(REL.installRelease(l, { name: '0.5.0-bbb' }).reused, true, 'an installed release is reused');
});

test('rollback flips current to the previous release and records the one it left, so a second rollback goes forward again', { skip: NO_SYMLINKS }, () => {
  const base = scratch('rollback');
  const l = REL.layout(base);
  assert.throws(() => REL.rollback(l), /no previous release is recorded/);
  for (const n of ['a', 'b']) {
    REL.installRelease(l, { name: `0.5.0-${n}`, binaryFile: fakeBinary(base, n) });
    REL.activate(l, `0.5.0-${n}`);
  }
  assert.deepEqual(REL.rollback(l), { name: '0.5.0-a', previous: '0.5.0-b', changed: true });
  assert.equal(fs.readFileSync(REL.currentBinary(l), 'utf8'), 'a');
  assert.equal(REL.previousName(l), '0.5.0-b');
  assert.deepEqual(REL.rollback(l), { name: '0.5.0-b', previous: '0.5.0-a', changed: true });
  fs.rmSync(REL.releaseDir(l, '0.5.0-a'), { recursive: true });
  assert.throws(() => REL.rollback(l), /previous release 0\.5\.0-a is gone/);
  assert.equal(REL.currentName(l), '0.5.0-b');
});

test('pruning keeps the newest releases and never removes the current or the previous one', { skip: NO_SYMLINKS }, () => {
  const base = scratch('prune');
  const l = REL.layout(base);
  const now = clock();
  const names = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
  for (const n of names) {
    now.advance(1000);
    REL.installRelease(l, { name: n, binaryFile: fakeBinary(base, n), now });
  }
  REL.activate(l, 'r2');
  REL.activate(l, 'r1');
  assert.deepEqual([REL.currentName(l), REL.previousName(l)], ['r1', 'r2']);
  const r = REL.prune(l, 3);
  assert.deepEqual(r.removed.sort(), ['r3', 'r4']);
  assert.deepEqual(REL.listReleases(l).map(x => x.name), ['r7', 'r6', 'r5', 'r2', 'r1']);
  assert.deepEqual(REL.prune(l, 3).removed, [], 'nothing more to do');

  fs.unlinkSync(l.current);
  assert.equal(REL.prune(l, 1).skipped, 'current does not point at a release');
  assert.equal(REL.listReleases(l).length, 5, 'without a known current nothing is removed');
});

test('installAndActivate installs, waits for idle before the flip, flips, runs the after-flip step, and prunes last: the step the self-updater reuses', { skip: NO_SYMLINKS }, async () => {
  const base = scratch('install-activate');
  const l = REL.layout(base);
  const seen = [];
  const r = await REL.installAndActivate(l, { name: '0.5.0-x', binaryFile: fakeBinary(base, 'x'), meta: { sha: 'x' } }, {
    waitIdle: async () => { seen.push(['idle', REL.currentName(l), REL.hasRelease(l, '0.5.0-x')]); },
    afterFlip: async flip => { seen.push(['after', flip.name, REL.currentName(l)]); return 7; },
  });
  assert.deepEqual(seen, [['idle', '', true], ['after', '0.5.0-x', '0.5.0-x']], 'the release is on disk and current is untouched while it waits');
  assert.equal(r.outcome, 7);
  assert.equal(r.pruneError, '');
  assert.equal(r.changed, true);
  assert.equal(REL.currentName(l), '0.5.0-x');
  assert.equal(JSON.parse(fs.readFileSync(path.join(REL.releaseDir(l, '0.5.0-x'), REL.RELEASE_INFO), 'utf8')).sha, 'x');

  await assert.rejects(REL.installAndActivate(l, { name: '0.5.0-y', binaryFile: fakeBinary(base, 'y') }, {
    waitIdle: async () => { throw new Error('not idle'); },
  }), /not idle/);
  assert.equal(REL.currentName(l), '0.5.0-x', 'no flip when the idle wait fails');
  assert.deepEqual(fs.readdirSync(l.releases).filter(f => f.startsWith('.staging')), [], 'no staging folder left');
});
