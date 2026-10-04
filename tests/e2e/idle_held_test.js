'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const I = require('../../bridge/idle');
const { makeRoot, gameRunner, replyTo, switchingLock } = require('./helpers');

const ROOT = makeRoot('idle-held');
const withGame = gameRunner(ROOT);

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

test('a message held for a deploy survives the restart the deploy makes: the new bridge holds it again and runs it when the lock goes', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    const calls = h.agentCalls().length;
    const lockFile = switchingLock(h);
    const id = h.client.lastSeq() + 1;
    h.client.send('held across the restart [[tag held-restart]]');
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ held: a deploy`));
    const heldIds = () => (h.state().held || []).map(e => e.job.id);
    await h.client.waitFor(() => heldIds().includes(id), { label: 'the held message in state.json' });
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

test('a strip retried in the gap after the deploy ends runs the held message once, takes it off the held list, and a cancel then stops the run', async () => {
  await withGame({ config: { deployHoldPollMs: 120000 } }, async h => {
    await h.client.connect();
    const lockFile = switchingLock(h);
    const id = h.client.lastSeq() + 1;
    h.client.send('retried in the gap [[hang]]');
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ held: a deploy`));
    fs.rmSync(lockFile);
    h.client.slash('/claude resend');
    await h.client.waitFor(() => Object.values(h.state().inflight || {}).some(r => r.id === id), { label: 'the retried message running' });
    assert.ok(!(h.state().held || []).some(e => e.job.id === id), 'the message that started is no longer held in state.json');
    h.client.slash('/claude cancel');
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ cancelled from the game; ending it`));
    await h.client.waitFor(() => !Object.values(h.state().inflight || {}).some(r => r.id === id), { label: 'the run ended' });
    assert.doesNotMatch(h.bridge.output, new RegExp(`#${id}@\\S+ cancelled from the game while it was held`));
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
