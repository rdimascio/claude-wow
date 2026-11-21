'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const I = require('../bridge/idle');

function fakeTime() {
  let t = 0;
  return {
    now: () => t,
    sleep: async ms => {
      t += ms;
    },
  };
}

test('idleStatus: a run in flight or a queued message is busy, an empty state is idle, no running bridge is idle', () => {
  assert.equal(I.idleStatus({}).idle, true);
  assert.equal(I.idleStatus({ inflight: {}, queued: [] }).idle, true);
  const run = I.idleStatus({ inflight: { c1: { id: 7 } } });
  assert.equal(run.idle, false);
  assert.match(run.reason, /1 agent run\(s\) in flight \(#7\)/);
  const q = I.idleStatus({ inflight: {}, queued: [{ id: 9, chat: 'c2' }] });
  assert.equal(q.idle, false);
  assert.match(q.reason, /1 message\(s\) waiting in the queue \(#9\)/);
  assert.equal(I.idleStatus(null).idle, false, 'an unreadable state.json is not taken as idle');
  assert.equal(I.idleStatus({ inflight: { c1: { id: 7 } } }, { bridgeRunning: false }).idle, true, 'what a dead bridge left behind does not block');
});

test('readState and the probe: a missing state.json is empty, a corrupt one is unknown, bridge.lock decides whether a bridge runs', () => {
  const dir = path.join(__dirname, 'tmp', 'idle');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  const bridgeLockFile = path.join(dir, 'bridge.lock');
  assert.deepEqual(I.readState(stateFile), {});
  fs.writeFileSync(stateFile, '{not json');
  assert.equal(I.readState(stateFile), null);
  fs.writeFileSync(stateFile, JSON.stringify({ inflight: { c: { id: 3 } }, queued: [{ id: 4 }] }));
  const alivePids = new Set([100, 101, 300]);
  const alive = pid => alivePids.has(pid);
  assert.equal(
    I.probeFor({ stateFile, bridgeLockFile, alive })().idle,
    true,
    'no bridge.lock and no pid file: no bridge, so what is left in state.json does not block (after service stop)',
  );
  assert.equal(I.probeFor({ stateFile, bridgeLockFile, readPid: () => null, alive })().idle, true);
  fs.writeFileSync(bridgeLockFile, JSON.stringify({ pid: 300, startedAt: 1 }));
  assert.equal(I.probeFor({ stateFile, bridgeLockFile, alive })().idle, false, 'a live pid in bridge.lock is a running bridge');
  fs.writeFileSync(bridgeLockFile, JSON.stringify({ pid: 400, startedAt: 1 }));
  assert.equal(I.probeFor({ stateFile, bridgeLockFile, alive })().idle, true, 'a dead pid in bridge.lock is no bridge');
  assert.equal(
    I.probeFor({ stateFile, bridgeLockFile, readPid: () => ({ pid: 100, bridgePid: 101 }), alive })().idle,
    false,
    'a bridge without the lock is still found through the pid file',
  );
  assert.equal(
    I.probeFor({ stateFile, bridgeLockFile, readPid: () => ({ pid: 100, bridgePid: 201 }), alive })().idle,
    true,
    'a supervisor alone, between bridge restarts, runs nothing',
  );
});

test('idleStatus: a message a plugin is handling (live session, stream, a roast hook) keeps the bridge busy', () => {
  const s = I.idleStatus({ handling: { 'c1#12': { id: 12, plugin: 'live' } } });
  assert.equal(s.idle, false);
  assert.match(s.reason, /1 message\(s\) being handled by a plugin \(#12 live\)/);
  assert.equal(I.idleStatus({ handling: {} }).idle, true);
});

test('waitForIdle gives up at the timeout with the reason and never reports idle', async () => {
  const t = fakeTime();
  let reads = 0;
  await assert.rejects(
    I.waitForIdle({
      probe: () => {
        reads++;
        return { idle: false, reason: '1 agent run(s) in flight (#4)' };
      },
      timeoutMs: 5000,
      pollMs: 1000,
      settleMs: 0,
      now: t.now,
      sleep: t.sleep,
    }),
    /did not go idle within 5 s \(1 agent run\(s\) in flight \(#4\)\)\. Nothing was switched/,
  );
  assert.equal(reads, 6);
  await assert.rejects(
    I.waitForIdle({
      probe: () => ({ idle: true, reason: 'idle' }),
      timeoutMs: 1000,
      pollMs: 1000,
      settleMs: 5000,
      now: t.now,
      sleep: t.sleep,
    }),
    /idle for less than 5 s/,
  );
});
