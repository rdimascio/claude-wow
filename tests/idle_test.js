'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const I = require('../bridge/idle');

function fakeTime() {
  let t = 0;
  return { now: () => t, sleep: async ms => { t += ms; } };
}

test('idleStatus: a run in flight or a queued message is busy, an empty state is idle, no running bridge is idle', () => {
  assert.equal(I.idleStatus({}).idle, true);
  assert.equal(I.idleStatus({ inflight: {} , queued: [] }).idle, true);
  const run = I.idleStatus({ inflight: { 'c1': { id: 7 } } });
  assert.equal(run.idle, false);
  assert.match(run.reason, /1 agent run\(s\) in flight \(#7\)/);
  const q = I.idleStatus({ inflight: {}, queued: [{ id: 9, chat: 'c2' }] });
  assert.equal(q.idle, false);
  assert.match(q.reason, /1 message\(s\) waiting in the queue \(#9\)/);
  assert.equal(I.idleStatus(null).idle, false, 'an unreadable state.json is not taken as idle');
  assert.equal(I.idleStatus({ inflight: { c1: { id: 7 } } }, { bridgeRunning: false }).idle, true, 'what a dead bridge left behind does not block');
});

test('readState and the probe: a missing state.json is empty, a corrupt one is unknown, the pid file decides whether a bridge runs', () => {
  const dir = path.join(__dirname, 'tmp', 'idle');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, 'state.json');
  assert.deepEqual(I.readState(stateFile), {});
  fs.writeFileSync(stateFile, '{not json');
  assert.equal(I.readState(stateFile), null);
  fs.writeFileSync(stateFile, JSON.stringify({ inflight: { c: { id: 3 } } }));
  const alivePids = new Set([100]);
  const alive = pid => alivePids.has(pid);
  assert.equal(I.probeFor({ stateFile, readPid: () => ({ pid: 100, bridgePid: 101 }), alive })().idle, false);
  assert.equal(I.probeFor({ stateFile, readPid: () => null, alive })().idle, false, 'no pid file: a bridge may still run');
  assert.equal(I.probeFor({ stateFile, readPid: () => ({ pid: 200, bridgePid: 201 }), alive })().idle, true, 'supervisor and bridge both gone');
});

test('waitForIdle defers while a run is in flight and proceeds once idle has held for the settle time', async () => {
  const t = fakeTime();
  const states = [false, false, true, false, true, true, true, true, true];
  let i = 0;
  const waits = [];
  const r = await I.waitForIdle({
    probe: () => { const idle = states[Math.min(i++, states.length - 1)]; return { idle, reason: idle ? 'idle' : 'busy' }; },
    timeoutMs: 60000, pollMs: 1000, settleMs: 2000, now: t.now, sleep: t.sleep, onWait: s => waits.push(s.reason),
  });
  assert.equal(r.idle, true);
  assert.equal(i, 7, 'a busy read in the middle restarts the settle time');
  assert.equal(r.waitedMs, 6000);
  assert.deepEqual(waits, ['busy', 'busy'], 'told once per change into busy');
});

test('waitForIdle gives up at the timeout with the reason and never reports idle', async () => {
  const t = fakeTime();
  let reads = 0;
  await assert.rejects(I.waitForIdle({
    probe: () => { reads++; return { idle: false, reason: '1 agent run(s) in flight (#4)' }; },
    timeoutMs: 5000, pollMs: 1000, settleMs: 0, now: t.now, sleep: t.sleep,
  }), /did not go idle within 5 s \(1 agent run\(s\) in flight \(#4\)\)\. Nothing was switched/);
  assert.equal(reads, 6);
  await assert.rejects(I.waitForIdle({
    probe: () => ({ idle: true, reason: 'idle' }), timeoutMs: 1000, pollMs: 1000, settleMs: 5000, now: t.now, sleep: t.sleep,
  }), /idle for less than 5 s/);
});
