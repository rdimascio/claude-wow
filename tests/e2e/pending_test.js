'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const CLI = require('../../bridge/clients');
const { makeRoot, gameRunner, replyTo } = require('./helpers');

const ROOT = makeRoot('pending');
const withGame = gameRunner(ROOT);

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
    for (let i = 1; i <= 30; i++)
      kept[`${token}:other${i}`] = { at, record: { chat: `other${i}`, id: 1000 + i, status: 'done', text: `other ${i}`, cwd: '', client: clientKey } };
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
    const listed = await h.client.waitFor(
      () =>
        new RegExp(`alive = \\{ \\{ session = "${token}", id = ${id}, since = (\\d+) \\}, \\{ session = "${token}", id = ${second}, since = 0 \\} \\}`).exec(
          slot(),
        ),
      { label: 'the running and the queued message in the slot file' },
    );
    assert.ok(Math.abs(Number(listed[1]) - Date.now() / 1000) < 60, 'since is the run start, in epoch seconds');
    assert.match(slot(), /\trunLimit = 3600,/);
    h.client.slash('/claude cancel');
    await h.bridge.waitForLine(new RegExp(`#${second}@\\S+ cancelled from the game before it started`));
    h.client.runLua('ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[1].id)');
    h.client.slash('/claude cancel');
    await h.client.waitFor(() => /\talive = \{  \},/.test(slot()), { label: 'an empty list once nothing is held' });
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
