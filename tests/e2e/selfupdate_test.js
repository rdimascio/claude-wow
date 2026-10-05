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

test('an installed update does not restart the bridge while a deploy is switching releases', async () => {
  await withGame({ supervised: true, config: { autoUpdateIdleSeconds: 6 } }, async h => {
    await h.client.connect();
    await h.bridge.waitForLine(/hello from session/, { from: 0 });
    await new Promise(res => setTimeout(res, 3000));
    assert.ok(IDLE.idleStatus(h.state()).idle, 'nothing is running, queued or handled before the deploy starts');
    const lock = REL.acquireLock(REL.layout(h.sb.home).lock, { command: 'e2e deploy' });
    try {
      lock.setPhase(REL.SWITCHING);
      UPD.writeRecord(h.sb.home, {
        pendingRestart: true,
        version: '99.0.0',
        from: VERSION,
        attemptAt: Date.now(),
        ok: true,
        status: 'updated',
        message: 'test',
      });
      await h.bridge.waitForLine(
        new RegExp(`self-update: 99\\.0\\.0 is installed; the restart waits: a deploy \\(pid ${process.pid}\\) is switching releases`),
        { timeoutMs: 20000 },
      );
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
