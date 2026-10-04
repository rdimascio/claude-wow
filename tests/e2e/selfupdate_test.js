'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeRoot, gameRunner } = require('./helpers');
const UPD = require('../../bridge/selfupdate');
const REL = require('../../bridge/releases');
const IDLE = require('../../bridge/idle');
const VERSION = require('../../package.json').version;

const ROOT = makeRoot('selfupdate');
const withGame = gameRunner(ROOT);

function count(text, re) {
  return (text.match(new RegExp(re.source, 'g')) || []).length;
}

test('an installed update waits for the run in flight, then the supervisor restarts the bridge once', async () => {
  await withGame({ supervised: true, config: { autoUpdateIdleSeconds: 6 } }, async h => {
    await h.bridge.waitForLine(/self-update: off \(running from source/, { from: 0 });
    await h.client.connect();
    const reply = h.client.say('slow job [[sleep 12]]', { timeoutMs: 60000 });
    await h.client.waitFor(() => h.agentCalls().length === 1, { label: 'the agent to start' });
    UPD.writeRecord(h.sb.home, { pendingRestart: true, version: '99.0.0', from: VERSION, attemptAt: Date.now(), ok: true, status: 'updated', message: 'test' });
    await h.bridge.waitForLine(/self-update: 99\.0\.0 is installed; the restart waits: 1 agent run\(s\) in flight \(#\d+\)/, { timeoutMs: 15000 });
    assert.equal(count(h.bridge.output, /self-update: restarting on/), 0, 'no restart while the run is in flight');
    const r = await reply;
    assert.equal(r.role, 'assistant');
    const restarting = await h.bridge.waitForLine(/self-update: restarting on 99\.0\.0 now: nothing is running/, { timeoutMs: 30000, from: 0 });
    const doneAt = h.bridge.output.search(new RegExp(`#${r.id}@\\S+ done \\(`));
    assert.ok(doneAt >= 0 && doneAt < restarting.index, 'the run finished before the restart');
    const stampOf = re => Date.parse((new RegExp(`\\[(\\S+)\\] ${re.source}`).exec(h.bridge.output) || [])[1]);
    const gap = stampOf(/self-update: restarting on 99\.0\.0/) - stampOf(new RegExp(`#${r.id}@\\S+ done \\(`));
    assert.ok(gap >= 5900, `the restart waits the quiet time after the reply too, so the game can read it (it came ${gap} ms after)`);
    await h.bridge.waitForLine(/bridge stopped for an update; starting /, { from: 0 });
    await h.bridge.waitForLine(/self-update: restarted for 99\.0\.0, but this is still/, { timeoutMs: 30000, from: 0 });
    await h.bridge.waitForLine(/screenshot transport: watching[\s\S]*screenshot transport: watching/, { timeoutMs: 30000, from: 0 });
    assert.match(h.bridge.output.slice(restarting.index), /republishing \d+ finished repl(y|ies) from before the restart/, 'the restarted bridge publishes the last reply again, in case the game had not read it');
    assert.ok(Object.values(h.state().replies || {}).some(e => e.record && e.record.id === r.id), 'the reply is kept in state.json across the update restart');
    await new Promise(res => setTimeout(res, UPD.RESTART_TICK_MS + 2000));
    assert.equal(count(h.bridge.output, /self-update: restarting on/), 1, 'exactly one restart');
    assert.equal(count(h.bridge.output, /bridge exited \(/), 0, 'the supervisor did not treat it as a crash');
    assert.equal(UPD.readRecord(h.sb.home).pendingRestart, false);
    const again = await h.client.say('after the restart');
    assert.equal(again.role, 'assistant');
  });
});

test('an installed update does not restart the bridge while a deploy is switching releases', async () => {
  await withGame({ supervised: true, config: { autoUpdateIdleSeconds: 6 } }, async h => {
    await h.client.connect();
    await h.bridge.waitForLine(/hello from session/, { from: 0 });
    await new Promise(res => setTimeout(res, 3000));
    assert.ok(IDLE.idleStatus(h.state()).idle, 'nothing is running, queued or handled before the deploy starts');
    const lock = REL.acquireLock(REL.layout(h.sb.home).lock, { command: 'e2e deploy' });
    try {
      lock.setPhase(REL.SWITCHING);
      UPD.writeRecord(h.sb.home, { pendingRestart: true, version: '99.0.0', from: VERSION, attemptAt: Date.now(), ok: true, status: 'updated', message: 'test' });
      await h.bridge.waitForLine(new RegExp(`self-update: 99\\.0\\.0 is installed; the restart waits: a deploy \\(pid ${process.pid}\\) is switching releases`), { timeoutMs: 20000 });
      await new Promise(res => setTimeout(res, UPD.RESTART_TICK_MS + 1000));
      assert.equal(count(h.bridge.output, /self-update: restarting on/), 0, 'no restart under the switching mark');
    } finally {
      lock.release();
    }
    await h.bridge.waitForLine(/self-update: restarting on 99\.0\.0 now/, { timeoutMs: 30000, from: 0 });
    await h.bridge.waitForLine(/self-update: restarted for 99\.0\.0, but this is still/, { timeoutMs: 30000, from: 0 });
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
