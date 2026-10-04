'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const I = require('../../bridge/idle');
const V = require('../../bridge/vision');
const CLI = require('../../bridge/clients');
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

test('a reply that finished while the game was closed reaches the game at its next login, with no bridge restart', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    const id = h.client.lastSeq() + 1;
    h.client.send('answer me while away [[sleep 2]]');
    await h.client.waitFor(() => Object.keys(h.state().inflight || {}).length === 1, { label: 'the run in flight' });
    assert.equal(h.client.activeChat().pendingId, id, 'the game closes while it waits');
    h.client.quit();
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ done`));
    h.client.launch();
    h.client.start();
    const reply = await h.client.waitFor(() => replyTo(h, id), { label: 'the reply in the game after the login' });
    assert.equal(reply.role, 'assistant');
    assert.match(reply.text, /answer me while away/);
  });
});

test('a new reply in a chat the bridge first saw long ago is still in the slots when 30 newer chats have replies', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    const token = h.client.db().session;
    const chat = h.client.activeChat().id;
    const clientKey = CLI.keyOf(h.sb.client);
    h.client.quit();
    await h.bridge.stop();
    const at = Date.now();
    const kept = { [`${token}:${chat}`]: { at, record: { chat, id: 1, status: 'done', text: 'an old reply', cwd: '', client: clientKey } } };
    for (let i = 1; i <= 30; i++) kept[`${token}:other${i}`] = { at, record: { chat: `other${i}`, id: 1000 + i, status: 'done', text: `other ${i}`, cwd: '', client: clientKey } };
    fs.writeFileSync(h.sb.state, JSON.stringify({ ...h.state(), replies: kept }));
    h.bridge.start();
    await h.bridge.ready();
    await h.bridge.waitForLine(/republishing 31 finished replies from before the restart/);
    h.client.launch();
    h.client.start();
    await h.client.connect();
    const id = h.client.lastSeq() + 1;
    h.client.send('the chat seen first [[tag first-chat]]');
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ done`));
    const reply = await h.client.waitFor(() => replyTo(h, id), { label: 'the reply in the chat the bridge saw first' });
    assert.match(reply.text, /the chat seen first/);
  });
});

test('the slot files name the run limit and the running message with its start time, and drop it once the run ends', async () => {
  await withGame({ config: { timeoutMs: 3600000, maxParallel: 1 } }, async h => {
    await h.client.connect();
    const token = h.client.db().session;
    const slot = () => fs.readFileSync(path.join(h.sb.addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8');
    h.client.send('a long one [[hang]]');
    const id = h.client.activeChat().pendingId;
    await h.client.waitFor(() => Object.keys(h.state().inflight || {}).length === 1, { label: 'the run in flight' });
    h.client.runLua('ClaudeWoW.NewChat("Two")');
    h.client.send('waits its turn [[hang]]');
    const second = h.client.activeChat().pendingId;
    await h.bridge.waitForLine(new RegExp(`#${second}@\\S+ queued \\(1 running\\)`));
    const listed = await h.client.waitFor(() => new RegExp(`alive = \\{ \\{ session = "${token}", id = ${id}, since = (\\d+) \\}, \\{ session = "${token}", id = ${second}, since = 0 \\} \\}`).exec(slot()), { label: 'the running and the queued message in the slot file' });
    assert.ok(Math.abs(Number(listed[1]) - Date.now() / 1000) < 60, 'since is the run start, in epoch seconds');
    assert.match(slot(), /\trunLimit = 3600,/);
    h.client.slash('/claude cancel');
    await h.bridge.waitForLine(new RegExp(`#${second}@\\S+ cancelled from the game before it started`));
    h.client.runLua('ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[1].id)');
    h.client.slash('/claude cancel');
    await h.client.waitFor(() => /\talive = \{  \},/.test(slot()), { label: 'an empty list once nothing is held' });
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

test('after a SavedVariables wipe, a reply kept for the old addon session is dropped and never answers the new session\'s message with the same chat and id', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    const oldToken = h.client.db().session;
    const chat = h.client.activeChat().id;
    const id = 50;
    h.client.runLua(`ClaudeWoWDB.lastSeq = ${id - 1}`);
    h.client.send('old session question');
    await h.client.waitFor(() => replyTo(h, id), { label: 'the old session reply' });
    assert.ok(Object.keys(h.state().replies || {}).some(k => k.startsWith(`${oldToken}:`)), 'the reply is kept in state.json');
    h.client.quit();
    fs.rmSync(h.sb.saved, { force: true });
    fs.rmSync(h.sb.saved + '.bak', { force: true });
    await h.bridge.restart();
    h.client.launch();
    h.client.start();
    await h.bridge.waitForLine(/republishing \d+ finished repl(y|ies) from before the restart/);
    await h.client.connect();
    const newToken = h.client.db().session;
    assert.notEqual(newToken, oldToken, 'the wipe made a new addon session');
    await h.bridge.waitForLine(new RegExp(`addon session ${newToken}: dropped \\d+ repl(y|ies) kept for another addon session`));
    assert.ok(!Object.keys(h.state().replies || {}).some(k => k.startsWith(`${oldToken}:`)), 'gone from state.json too');
    await h.client.waitFor(() => (h.client.db().chats || []).some(c => c.id === chat), { label: 'the old chat restored with its id' });
    h.client.runLua(`ClaudeWoW.SwitchChat(${JSON.stringify(chat)})`);
    assert.ok(h.client.lastSeq() < id - 1, 'ids restarted after the wipe');
    h.client.runLua(`ClaudeWoWDB.lastSeq = ${id - 1}`);
    const lockFile = switchingLock(h);
    h.client.send('new session question');
    assert.equal(h.client.activeChat().pendingId, id, 'the new message has the old chat and id');
    await h.bridge.waitForLine(new RegExp(`#${id}@${newToken} held: a deploy`));
    await new Promise(r => setTimeout(r, 7000));
    assert.equal(h.client.activeChat().pendingId, id, 'no old reply answered the held message');
    const afterNewQuestion = () => {
      const history = h.client.activeChat().history || [];
      const asked = history.findIndex(m => m.role === 'user' && m.text === 'new session question');
      return asked < 0 ? [] : history.slice(asked + 1).filter(m => m.id === id && m.role !== 'user');
    };
    assert.deepEqual(afterNewQuestion(), [], 'nothing answered the new question while it was held');
    fs.rmSync(lockFile);
    const replies = await h.client.waitFor(() => !h.client.activeChat().pendingId && afterNewQuestion().length ? afterNewQuestion() : null, { label: 'the real reply' });
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /new session question/);
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
