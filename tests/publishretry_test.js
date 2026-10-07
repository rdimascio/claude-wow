'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../bridge/gamefs');
const PUBR = require('../bridge/publishretry');

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const queue = [];
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      queue.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      const i = queue.findIndex(t => t.id === id);
      if (i >= 0) queue.splice(i, 1);
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at || a.id - b.id);
        if (!queue.length || queue[0].at > until) break;
        const t = queue.shift();
        now = t.at;
        t.fn();
      }
      now = until;
    },
    pending: () => queue.map(t => t.at - now),
    get now() {
      return now;
    },
  };
}

const sharingError = code => Object.assign(new Error(code), { code });

function flakyDisk(failures) {
  const disk = new Map();
  const writes = [];
  const left = new Map(Object.entries(failures));
  const write = (file, content) => {
    const codes = left.get(file) || [];
    writes.push({ file, content, failed: codes[0] || null });
    if (codes.length) {
      left.set(file, codes.slice(1));
      throw sharingError(codes[0]);
    }
    disk.set(file, content);
  };
  const lock = (file, codes) => left.set(file, codes);
  return { disk, writes, write, lock };
}

function retrier(disk, overrides = {}) {
  const clock = fakeClock();
  const logs = [];
  const republished = [];
  const retry = PUBR.createPublishRetry({
    write: disk.write,
    log: line => logs.push(line),
    republish: key => republished.push(key),
    platform: 'win32',
    timers: clock,
    ...overrides,
  });
  return { clock, logs, republished, retry };
}

const failed = (file, content, code = 'EPERM') => ({ file, content, code });

test('a write the game holds through two retries lands on the third, with no log and no early republish', () => {
  const disk = flakyDisk({ inbox: ['EPERM', 'EBUSY'] });
  const { clock, logs, republished, retry } = retrier(disk);
  retry.settle('era', [failed('inbox', 'reply')]);
  assert.deepEqual(clock.pending(), [25]);
  clock.advance(25);
  assert.deepEqual(clock.pending(), [50]);
  clock.advance(50);
  assert.equal(disk.disk.has('inbox'), false);
  assert.deepEqual(clock.pending(), [100]);
  clock.advance(100);
  assert.equal(disk.disk.get('inbox'), 'reply');
  assert.equal(retry.pendingFor('era'), false);
  assert.deepEqual(clock.pending(), []);
  assert.deepEqual(logs, []);
  assert.deepEqual(republished, []);
  disk.lock('inbox', Array(4).fill('EPERM'));
  retry.settle('era', [failed('inbox', 'next')]);
  clock.advance(375);
  assert.equal(logs.length, 1, 'the retry that landed ended the incident, so the next one is logged');
});

test('the retries back off 25, 50, 100 and 200 ms and finish well under a second', () => {
  assert.deepEqual(PUBR.RETRY_DELAYS_MS, [25, 50, 100, 200]);
  assert.ok(PUBR.RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) < 1000);
  assert.ok(PUBR.REPUBLISH_SOON_MS <= 2000);
});

test('a file still locked after every retry is logged once and republished once, soon', () => {
  const always = Array(20).fill('EBUSY');
  const disk = flakyDisk({ inbox: always, slot: always });
  const { clock, logs, republished, retry } = retrier(disk);
  retry.settle('era', [failed('inbox', 'reply', 'EBUSY'), failed('slot', 'reply', 'EBUSY')], ' (_classic_era_)');
  clock.advance(25 + 50 + 100 + 200);
  assert.equal(disk.writes.length, 8);
  assert.equal(logs.length, 1);
  assert.match(
    logs[0],
    /^publish \(_classic_era_\): 2 file\(s\) still locked by another program \(EBUSY\) after 4 retries: inbox, slot; writing them again in 1\.5 s$/,
  );
  assert.deepEqual(clock.pending(), [1500]);
  clock.advance(1499);
  assert.deepEqual(republished, []);
  clock.advance(1);
  assert.deepEqual(republished, ['era']);

  retry.settle('era', [failed('inbox', 'newer', 'EBUSY')]);
  clock.advance(10000);
  assert.equal(logs.length, 1, 'one log per incident, not per attempt or per republish');
  assert.deepEqual(republished, ['era'], 'the quick republish happens once per incident; the regular cycle takes over');

  retry.settle('era', []);
  retry.settle('era', [failed('inbox', 'later', 'EPERM')]);
  clock.advance(375);
  assert.equal(logs.length, 2, 'a write that succeeded ends the incident, so the next one is logged again');
  assert.match(logs[1], /still locked .*writing them again in 1\.5 s$/);
});

test('a retry that lands after a quick republish ends the incident, so the next lock is logged and republished again', () => {
  const disk = flakyDisk({ inbox: Array(4).fill('EPERM') });
  const { clock, logs, republished, retry } = retrier(disk);
  retry.settle('era', [failed('inbox', 'one')]);
  clock.advance(375 + 1500);
  assert.equal(logs.length, 1);
  assert.deepEqual(republished, ['era']);
  disk.lock('inbox', ['EPERM']);
  retry.settle('era', [failed('inbox', 'two')]);
  clock.advance(75);
  assert.equal(disk.disk.get('inbox'), 'two');
  disk.lock('inbox', Array(4).fill('EPERM'));
  retry.settle('era', [failed('inbox', 'three')]);
  clock.advance(375 + 1500);
  assert.equal(logs.length, 2);
  assert.deepEqual(republished, ['era', 'era']);
});

test('a retry writes again only the files that are still locked', () => {
  const disk = flakyDisk({ inbox: Array(4).fill('EPERM') });
  const { clock, retry } = retrier(disk);
  retry.settle('era', [failed('inbox', 'reply'), failed('slot', 'reply')]);
  clock.advance(375);
  assert.equal(disk.writes.filter(w => w.file === 'slot').length, 1);
  assert.equal(disk.writes.filter(w => w.file === 'inbox').length, 4);
});

test('a newer publish supersedes a pending retry, so an old reply never lands over a newer one', () => {
  const disk = flakyDisk({});
  const { clock, retry } = retrier(disk);
  retry.settle('era', [failed('inbox', 'old reply')]);
  clock.advance(10);
  disk.write('inbox', 'new reply');
  retry.settle('era', []);
  clock.advance(10000);
  assert.equal(disk.disk.get('inbox'), 'new reply');
  assert.deepEqual(
    disk.writes.map(w => w.content),
    ['new reply'],
  );
});

test('supersede alone cancels the pending retry and a pending quick republish', () => {
  const disk = flakyDisk({ inbox: Array(10).fill('EPERM') });
  const { clock, republished, retry } = retrier(disk);
  retry.settle('era', [failed('inbox', 'old')]);
  retry.supersede('era');
  clock.advance(10000);
  assert.equal(disk.writes.length, 0);
  retry.settle('era', [failed('inbox', 'old')]);
  clock.advance(375);
  assert.equal(retry.pendingFor('era'), true);
  retry.supersede('era');
  clock.advance(10000);
  assert.deepEqual(republished, []);
});

test('a newer locked publish retries its own content, not the older one', () => {
  const disk = flakyDisk({ inbox: ['EPERM'] });
  const { clock, retry } = retrier(disk);
  retry.settle('era', [failed('inbox', 'old')]);
  clock.advance(10);
  retry.settle('era', [failed('inbox', 'new')]);
  clock.advance(10000);
  assert.equal(disk.disk.get('inbox'), 'new');
  assert.deepEqual(
    disk.writes.map(w => w.content),
    ['new', 'new'],
  );
});

test('retries of one client never cancel or write the files of another', () => {
  const disk = flakyDisk({});
  const { clock, retry } = retrier(disk);
  retry.settle('forever', [failed('a', 'A')]);
  retry.settle('era', [failed('b', 'B')]);
  retry.settle('forever', []);
  clock.advance(25);
  assert.equal(disk.disk.get('b'), 'B');
  assert.equal(disk.disk.has('a'), false);
});

test('a file that turns non-transient during a retry is dropped, not retried', () => {
  const disk = flakyDisk({ inbox: ['ENOSPC', 'EPERM'] });
  const { clock, logs, republished, retry } = retrier(disk);
  retry.settle('era', [failed('inbox', 'reply')]);
  clock.advance(10000);
  assert.equal(disk.writes.length, 1);
  assert.deepEqual(logs, []);
  assert.deepEqual(republished, []);
});

test('a publish batch returns each write error and retries only the locked files', () => {
  const disk = flakyDisk({});
  const { clock, retry } = retrier(disk);
  const write = disk.write;
  const fails = { inbox: 'EPERM', slot2: 'ENOSPC', slot3: 'EBUSY' };
  const batch = PUBR.createPublishRetry({
    write: (file, content) => {
      if (fails[file] && !disk.disk.has(file + ':tried')) {
        disk.disk.set(file + ':tried', true);
        throw sharingError(fails[file]);
      }
      write(file, content);
    },
    log() {},
    republish() {},
    platform: 'win32',
    timers: clock,
  }).begin('era');
  assert.equal(batch.write('inbox', 'r').code, 'EPERM');
  assert.equal(batch.write('slot1', 'r'), null);
  assert.equal(batch.write('slot2', 'r').code, 'ENOSPC');
  assert.equal(batch.write('slot3', 'r').code, 'EBUSY');
  assert.equal(batch.locked(), 2);
  batch.end();
  clock.advance(25);
  assert.deepEqual(
    disk.writes.map(w => w.file),
    ['slot1', 'inbox', 'slot3'],
  );
  assert.equal(disk.disk.has('slot2'), false);
  assert.equal(retry.pendingFor('era'), false);
});

test('a publish batch with nothing locked cancels the older pending retry', () => {
  const disk = flakyDisk({});
  const { clock, retry } = retrier(disk);
  retry.settle('era', [failed('inbox', 'old')]);
  const batch = retry.begin('era');
  assert.equal(batch.write('inbox', 'new'), null);
  assert.equal(batch.locked(), 0);
  batch.end();
  assert.equal(retry.pendingFor('era'), false);
  clock.advance(10000);
  assert.equal(disk.disk.get('inbox'), 'new');
});

test('only the Windows sharing codes are transient, and only on Windows', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    assert.equal(PUBR.isSharingError(sharingError(code), 'win32'), true, code);
    for (const platform of ['darwin', 'linux']) assert.equal(PUBR.isSharingError(sharingError(code), platform), false, `${code} on ${platform}`);
  }
  for (const code of ['ENOENT', 'ENOSPC', 'EEXIST', 'EUNSAFE', 'EROFS']) assert.equal(PUBR.isSharingError(sharingError(code), 'win32'), false, code);
  assert.equal(PUBR.isSharingError(null, 'win32'), false);
  assert.equal(PUBR.isSharingError(new Error('no code'), 'win32'), false);
  const posix = PUBR.createPublishRetry({ write() {}, log() {}, republish() {}, platform: 'linux', timers: fakeClock() });
  assert.equal(posix.isTransient(sharingError('EPERM')), false);
});

test('the real atomicWrite retried after a locked rename keeps no temp files and lands the content', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wow-publishretry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Inbox.lua');
  fs.writeFileSync(file, 'old');
  const realRename = fs.renameSync;
  let locks = 2;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (locks-- > 0) throw sharingError('EPERM');
    return realRename(from, to);
  });
  const clock = fakeClock();
  const retry = PUBR.createPublishRetry({ write: G.atomicWrite, log() {}, republish() {}, platform: 'win32', timers: clock });
  const locked = [];
  try {
    G.atomicWrite(file, 'reply');
  } catch (e) {
    assert.equal(retry.isTransient(e), true);
    locked.push({ file, content: 'reply', code: e.code });
  }
  assert.deepEqual(fs.readdirSync(dir), ['Inbox.lua'], 'the failed rename removed its exclusive temp');
  retry.settle('era', locked);
  clock.advance(25);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  clock.advance(50);
  assert.equal(fs.readFileSync(file, 'utf8'), 'reply');
  assert.deepEqual(fs.readdirSync(dir), ['Inbox.lua']);
});
