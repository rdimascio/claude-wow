'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const I = require('../../bridge/idle');
const V = require('../../bridge/vision');
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

test('at startup a vision screenshot that a held message needs is kept while leftovers go, and held messages past the saved limit are logged', async () => {
  const token = 'feedc0de1234';
  let kept = '', leftover = '';
  const beforeLaunch = sb => {
    const tmp = path.join(sb.home, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const png = V.encodePNG({ width: 1, height: 1, rgb: Buffer.from([10, 20, 30]) });
    kept = path.join(tmp, V.fileName(1));
    leftover = path.join(tmp, V.fileName(99));
    fs.writeFileSync(kept, png);
    fs.writeFileSync(leftover, png);
    const at = Date.now();
    const held = Array.from({ length: 21 }, (_, i) => ({ at, job: { id: i + 1, session: token, chat: `c${i + 1}`, cwd: '', text: `held ${i + 1}` } }));
    held[0].job.vision = true;
    held[0].job.image = { file: kept, width: 1, height: 1, mediaType: 'image/png', bytes: png.length };
    fs.writeFileSync(path.join(sb.home, 'state.json'), JSON.stringify({ held }));
    fs.writeFileSync(path.join(sb.home, 'deploy.lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), started: Date.now(), command: 'dev deploy', token: 'e2e', phase: 'switching' }));
  };
  await withGame({ beforeLaunch }, async h => {
    await h.bridge.waitForLine(new RegExp(`#21@${token} held: a deploy`));
    assert.ok(fs.existsSync(kept), 'the held message keeps its screenshot');
    assert.ok(!fs.existsSync(leftover), 'a screenshot no held message needs is still swept');
    await h.bridge.waitForLine(new RegExp(`1 held message\\(s\\) \\(#1@${token}\\) are not saved to state\\.json: only the newest 20 are`));
    assert.equal((h.state().held || []).length, 20);
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
