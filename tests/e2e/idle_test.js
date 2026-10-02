'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

test('a stopped bridge leaves no queue in state.json, so a deploy after "service stop" does not wait for messages nobody will run', async () => {
  await withGame({ config: { maxParallel: 1 } }, async h => {
    await h.client.connect();
    h.client.send('first [[hang]]');
    await h.client.waitFor(() => Object.keys(h.state().inflight || {}).length === 1, { label: 'the first run in flight' });
    h.client.runLua('ClaudeWoW.NewChat("Two")');
    const second = h.client.lastSeq() + 1;
    h.client.send('second [[hang]]');
    await h.bridge.waitForLine(new RegExp(`#${second}@\\S+ queued \\(1 running\\)`));
    await h.bridge.stop();
    const st = h.state();
    assert.equal(st.queued, undefined, 'the queue is gone with the bridge that held it');
    assert.equal(st.handling, undefined);
    assert.equal(I.idleStatus({ ...st, inflight: {} }).idle, true);
  });
});

test('a message the live plugin is waiting on is in state.json (handling), so a deploy waits for it; it goes when the plugin answers', async () => {
  await withGame({ config: { plugins: { default: 'live', live: { waitMs: 4000 } } } }, async h => {
    await h.client.connect();
    const id = h.client.lastSeq() + 1;
    h.client.send('are you there');
    await h.client.waitFor(() => Object.values(h.state().handling || {}).some(x => x.id === id && x.plugin === 'live'), { label: 'the live job in state.json handling' });
    const st = h.state();
    assert.deepEqual(Object.keys(st.inflight || {}), [], 'no agent run of its own');
    const s = I.idleStatus(st);
    assert.equal(s.idle, false);
    assert.match(s.reason, new RegExp(`being handled by a plugin \\(#${id} live\\)`));
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+.*no live session connected`), { timeoutMs: 15000 });
    await h.client.waitFor(() => h.state().handling === undefined, { label: 'the handling entry gone' });
  });
});

test('while a deploy.lock says switching, a new message is held (not run, not dropped) and starts once the lock goes', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    const calls = h.agentCalls().length;
    const lockFile = path.join(h.sb.home, 'deploy.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), started: Date.now(), command: 'dev deploy', token: 'e2e', phase: 'switching' }));
    const id = h.client.lastSeq() + 1;
    h.client.send('wait for the deploy');
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ held: a deploy \\(pid ${process.pid}\\) is switching releases`));
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(h.agentCalls().length, calls, 'nothing ran while the deploy switches');
    assert.deepEqual(Object.keys(h.state().inflight || {}), []);
    assert.equal(I.idleStatus(h.state()).idle, true, 'a held message does not stop the deploy it waits for');
    fs.rmSync(lockFile);
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ released: the deploy ended`));
    await h.client.waitFor(() => h.agentCalls().length > calls && Object.keys(h.state().inflight || {}).length === 0, { label: 'the held message ran' });
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
