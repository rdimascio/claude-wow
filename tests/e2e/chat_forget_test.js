'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeRoot, gameRunner, isAlive } = require('./helpers');

const ROOT = makeRoot('chatforget');
const withGame = gameRunner(ROOT);

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const inflightIds = h => Object.values(h.state().inflight || {}).map(r => r.id);

test('deleting a chat while its agent run works ends the run, and the run never writes the chat\'s session back', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    h.client.runLua('ClaudeWoW.NewChat("Doomed")');
    const chat = h.client.activeChat().id;
    const id = h.client.lastSeq() + 1;
    h.client.send('work on this [[hang]]');
    await h.client.waitFor(() => inflightIds(h).includes(id), { label: 'the run in flight' });
    const run = await h.client.waitFor(() => h.agentCalls().at(-1), { label: 'the agent process to start' });

    h.client.runLua(`ClaudeWoW.DeleteChat(${JSON.stringify(chat)})`);
    await h.bridge.waitForLine(new RegExp(`forgot chat ${chat}`));
    await h.client.waitFor(() => !isAlive(run.pid), { timeoutMs: 15000, label: 'the deleted chat\'s agent process to end' });
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ error`));
    const st = h.state();
    assert.equal(st.sessions[`chat:${chat}`], undefined, 'the deleted chat has no agent session to resume');
    assert.equal((st.sessionCwd || {})[`chat:${chat}`], undefined);
    assert.deepEqual(inflightIds(h), []);
    assert.equal(h.transcripts().chats[chat], undefined, 'no transcript comes back for the deleted chat');
  });
});

test('deleting a chat drops its queued message, which never runs', async () => {
  await withGame({ config: { maxParallel: 1 } }, async h => {
    await h.client.connect();
    const firstChat = h.client.activeChat().id;
    const first = h.client.lastSeq() + 1;
    h.client.send('first [[hang]]');
    await h.client.waitFor(() => inflightIds(h).includes(first), { label: 'the first run in flight' });
    h.client.runLua('ClaudeWoW.NewChat("Two")');
    const doomedChat = h.client.activeChat().id;
    const queuedId = h.client.lastSeq() + 1;
    h.client.send('second, never to run');
    await h.bridge.waitForLine(new RegExp(`#${queuedId}@\\S+ queued \\(1 running\\)`));

    h.client.runLua(`ClaudeWoW.DeleteChat(${JSON.stringify(doomedChat)})`);
    await h.bridge.waitForLine(new RegExp(`#${queuedId}@\\S+ dropped: its chat was deleted before it started`));
    await h.client.waitFor(() => !(h.state().queued || []).some(j => j.id === queuedId), { label: 'the queue entry gone from state.json' });

    h.client.runLua(`ClaudeWoW.SwitchChat(${JSON.stringify(firstChat)})`);
    h.client.slash('/claude cancel');
    await h.bridge.waitForLine(new RegExp(`#${first}@\\S+ error`));
    await pause(1000);
    assert.doesNotMatch(h.bridge.output, new RegExp(`#${queuedId}@\\S+ \\(`), 'the dropped message never starts');
    assert.equal(h.agentCalls().length, 1);
    assert.equal(h.transcripts().chats[doomedChat], undefined);
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
