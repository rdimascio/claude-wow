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
    assert.ok((st.queued || []).map(j => j.id).includes(second), 'the second message is in state.json queued');
    assert.equal(I.idleStatus(st).idle, false);
    const queueOnly = I.idleStatus({ ...st, inflight: {} });
    assert.equal(queueOnly.idle, false, 'the queue alone keeps the bridge busy');
    assert.match(queueOnly.reason, new RegExp(`waiting in the queue \\((#\\d+, )*#${second}(, #\\d+)*\\)`));

    h.client.slash('/claude cancel');
    await h.bridge.waitForLine(new RegExp(`#${second}@\\S+ cancelled from the game before it started`));
    await h.client.waitFor(() => !(h.state().queued || []).some(j => j.id === second), { label: 'the queue entry gone from state.json' });
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

function switchingLock(h) {
  const lockFile = path.join(h.sb.home, 'deploy.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), started: Date.now(), command: 'dev deploy', token: 'e2e', phase: 'switching' }));
  return lockFile;
}

function replyTo(h, id) {
  const c = h.client.activeChat();
  if (!c || c.pendingId) return null;
  return (c.history || []).find(m => m.id === id && m.role !== 'user') || null;
}

test('a reply that finished while the game was not reading reaches the game after a bridge restart: the new bridge publishes it again', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    const id = h.client.lastSeq() + 1;
    h.client.send('answer me [[sleep 2]]');
    await h.client.waitFor(() => Object.keys(h.state().inflight || {}).length === 1, { label: 'the run in flight' });
    h.client.stop();
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ done`));
    assert.equal(h.client.activeChat().pendingId, id, 'the game has not read the reply yet');
    await h.bridge.restart();
    await h.bridge.waitForLine(/republishing \d+ finished repl(y|ies) from before the restart/);
    assert.ok(Object.values(h.state().replies || {}).some(e => e.record.id === id && e.record.status === 'done'), 'the reply is kept in state.json');
    h.client.start();
    const reply = await h.client.waitFor(() => replyTo(h, id), { label: 'the reply in the game after the restart' });
    assert.equal(reply.role, 'assistant');
    assert.match(reply.text, /answer me/);
  });
});

test('a message held for a deploy survives the restart the deploy makes: the new bridge holds it again and runs it when the lock goes', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    const calls = h.agentCalls().length;
    const lockFile = switchingLock(h);
    const id = h.client.lastSeq() + 1;
    h.client.send('held across the restart [[tag held-restart]]');
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ held: a deploy`));
    const heldIds = () => (h.state().held || []).map(e => e.job.id);
    assert.ok(heldIds().includes(id), 'the held message is in state.json');
    h.client.stop();
    await h.bridge.restart();
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ was held for a deploy when the previous bridge stopped; submitting it again`));
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ held: a deploy`));
    assert.equal(h.agentCalls().length, calls, 'still nothing ran while the deploy switches');
    assert.ok(heldIds().includes(id));
    fs.rmSync(lockFile);
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ released: the deploy ended`));
    await h.client.waitFor(() => h.agentCalls().some(c => c.directives && c.directives.tag === 'held-restart'), { label: 'the held message ran, with the game paused' });
    assert.equal(h.state().held, undefined);
    h.client.start();
    const reply = await h.client.waitFor(() => replyTo(h, id), { label: 'the reply to the held message' });
    assert.match(reply.text, /held across the restart/);
  });
});

test('a held message cancelled from the game never runs when the deploy ends', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    const calls = h.agentCalls().length;
    const lockFile = switchingLock(h);
    const id = h.client.lastSeq() + 1;
    h.client.send('cancel me while held [[tag held-cancel]]');
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ held: a deploy`));
    h.client.slash('/claude cancel');
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ cancelled from the game while it was held for a deploy`));
    assert.ok(!(h.state().held || []).some(e => e.job.id === id), 'gone from state.json too');
    const mark = h.bridge.output.length;
    fs.rmSync(lockFile);
    await new Promise(r => setTimeout(r, 3000));
    assert.ok(!h.agentCalls().slice(calls).some(c => c.directives && c.directives.tag === 'held-cancel'), 'the cancelled message did not run');
    assert.doesNotMatch(h.bridge.since(mark), new RegExp(`#${id}@\\S+ released`));
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
