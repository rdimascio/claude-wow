'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeRoot, gameRunner, replyTo, switchingLock } = require('./helpers');

const ROOT = makeRoot('idle-replies');
const withGame = gameRunner(ROOT);

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
