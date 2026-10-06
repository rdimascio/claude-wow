'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeRoot, gameRunner, sentId } = require('./helpers');

const ROOT = makeRoot('visionqueue');
const withGame = gameRunner(ROOT);

const inflightIds = h => Object.values(h.state().inflight || {}).map(r => r.id);

test('a vision message waiting in the queue keeps its screenshot when newer screenshots pass vision.keep', async () => {
  await withGame({ config: { maxParallel: 1, vision: { keep: 1 } } }, async h => {
    await h.client.connect();
    const firstChat = h.client.activeChat().id;
    h.client.send('first [[hang]]');
    const first = sentId(h.client);
    await h.client.waitFor(() => inflightIds(h).includes(first), { label: 'the first run in flight' });

    h.client.runLua('ClaudeWoW.NewChat("Two")');
    h.client.runLua('ClaudeWoW.Send("look two", nil, { vision = true })');
    const second = sentId(h.client);
    await h.bridge.waitForLine(new RegExp(`#${second}@\\S+ queued \\(1 running\\)`));
    h.client.runLua('ClaudeWoW.NewChat("Three")');
    h.client.runLua('ClaudeWoW.Send("look three", nil, { vision = true })');
    const third = sentId(h.client);
    await h.bridge.waitForLine(new RegExp(`#${third}@\\S+ queued \\(1 running\\)`));
    h.client.runLua('ClaudeWoW.NewChat("Four")');
    h.client.runLua('ClaudeWoW.Send("look four", nil, { vision = true })');
    const fourth = sentId(h.client);
    await h.bridge.waitForLine(new RegExp(`#${fourth}@\\S+ queued \\(1 running\\)`));

    h.client.runLua(`ClaudeWoW.SwitchChat(${JSON.stringify(firstChat)})`);
    h.client.slash('/claude cancel');
    const run = await h.client.waitFor(() => h.agentCalls().find(c => c.prompt.includes('look two')), { label: 'the queued vision message to run' });
    assert.equal(run.images, 1, 'the queued message runs with its screenshot');
    assert.doesNotMatch(h.bridge.output, /vision: \S+ is gone/);
  });
});

test('vision messages that share one screenshot each keep their own copy when they outnumber vision.keep', async () => {
  await withGame({ config: { maxParallel: 1, vision: { keep: 1 } } }, async h => {
    await h.client.connect();
    const firstChat = h.client.activeChat().id;
    h.client.send('first [[hang]]');
    const first = sentId(h.client);
    await h.client.waitFor(() => inflightIds(h).includes(first), { label: 'the first run in flight' });

    h.client.runLua(
      'ClaudeWoW.NewChat("Two"); ClaudeWoW.Send("look two", nil, { vision = true }); ClaudeWoW.NewChat("Three"); ClaudeWoW.Send("look three", nil, { vision = true })',
    );
    const [second, third] = ['Two', 'Three'].map(name =>
      sentId(
        h.client,
        h.client.db().chats.find(c => c.name === name),
      ),
    );
    await h.bridge.waitForLine(new RegExp(`vision: \\S+ -> \\d+x\\d+ png, \\d+ KB, for #${second}, #${third}`));
    await h.bridge.waitForLine(new RegExp(`#${third}@\\S+ queued \\(1 running\\)`));

    h.client.runLua(`ClaudeWoW.SwitchChat(${JSON.stringify(firstChat)})`);
    h.client.slash('/claude cancel');
    const runs = await h.client.waitFor(
      () => {
        const calls = ['look two', 'look three'].map(text => h.agentCalls().find(c => c.prompt.includes(text)));
        return calls.every(Boolean) && calls;
      },
      { label: 'both queued vision messages to run' },
    );
    assert.deepEqual(
      runs.map(r => r.images),
      [1, 1],
      'each message of the shared screenshot runs with it',
    );
    assert.doesNotMatch(h.bridge.output, /vision: \S+ is gone/);
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
