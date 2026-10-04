'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('gamedata-tokens');
const withGame = gameRunner(ROOT);

test('a reply keeps a spell token the player linked earlier in the chat and shows an unlinked one as plain text, with a log line', async () => {
  await withGame({ plugin: 'ask' }, async h => {
    await h.client.say('is this good [Frostbolt]\n\n--- Linked from the game ---\n[Frostbolt] spell 116 [[reply ok]]');
    const r = await h.client.say('and now [[reply cast {spell:116} not {spell:12294}, buy {item:999999}]]');
    assert.equal(r.text, 'cast {spell:116} not spell 12294 (unverified), buy {item:999999}');
    await h.bridge.waitForLine(/reply tokens: 1 spell token\(s\) not linked in this chat, shown as plain text: spell:12294$/m, { from: 0 });
  });
});

test('progress shown while the agent works gets the same spell check as the reply', async () => {
  await withGame({ plugin: 'ask' }, async h => {
    await h.client.connect();
    const id = h.client.lastSeq() + 1;
    h.client.send('think first [[think use {spell:12294} now]] [[tools 1]] [[sleep 6]] [[reply done]]');
    const progress = await h.client.waitFor(() => {
      const c = h.client.activeChat();
      return c && c.pendingId === id && typeof c.progress === 'string' && c.progress.includes('12294') && c.progress;
    }, { timeoutMs: 30000, label: 'the working bubble with the agent text' });
    assert.match(progress, /use spell 12294 \(unverified\) now/);
    assert.doesNotMatch(progress, /\{spell:12294\}/);
  });
});
