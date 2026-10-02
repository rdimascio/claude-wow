'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const I = require('../../bridge/idle');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('idle');
const withGame = gameRunner(ROOT);

test('a message waiting in the queue is in state.json, so a deploy waits for it; cancelling it clears the entry', async () => {
  await withGame({ config: { maxParallel: 1 } }, async h => {
    await h.client.connect();
    const first = h.client.lastSeq() + 1;
    h.client.send('first [[hang]]');
    await h.client.waitFor(() => Object.keys(h.state().inflight || {}).length === 1, { label: 'the first run in flight' });
    h.client.runLua('ClaudeWoW.NewChat("Two")');
    const second = h.client.lastSeq() + 1;
    h.client.send('second [[hang]]');
    await h.bridge.waitForLine(new RegExp(`#${second}@\\S+ queued \\(1 running\\)`));
    const st = h.state();
    assert.deepEqual((st.queued || []).map(j => j.id), [second]);
    assert.equal(I.idleStatus(st).idle, false);
    const queueOnly = I.idleStatus({ ...st, inflight: {} });
    assert.equal(queueOnly.idle, false, 'the queue alone keeps the bridge busy');
    assert.match(queueOnly.reason, new RegExp(`waiting in the queue \\(#${second}\\)`));

    h.client.slash('/claude cancel');
    await h.bridge.waitForLine(new RegExp(`#${second}@\\S+ cancelled from the game before it started`));
    await h.client.waitFor(() => h.state().queued === undefined, { label: 'the queue entry gone from state.json' });
    assert.deepEqual(Object.values(h.state().inflight || {}).map(r => r.id), [first], 'the first run still blocks');
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
