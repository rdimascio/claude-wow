'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeRoot, gameRunner, switchingLock } = require('./helpers');

const ROOT = makeRoot('idle-held');
const withGame = gameRunner(ROOT);

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
    assert.ok(
      !h
        .agentCalls()
        .slice(calls)
        .some(c => c.directives && c.directives.tag === 'held-cancel'),
      'the cancelled message did not run',
    );
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
