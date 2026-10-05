'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('presence');
const withGame = gameRunner(ROOT);

const beatsSeen = h => Number(h.client.luaValue('ClaudeWoW.Presence.State().beats'));

test('a client where a deleted launch-time file still reads present fails the self-test, keeps the light on the idle-poll windows, and tells the bridge pt=failed', async () => {
  await withGame({ presenceIntervalMs: 1000, client: { deletionVisible: false } }, async h => {
    await h.client.connect();
    await h.client.waitFor(() => h.client.luaValue('ClaudeWoW.Presence.State().test') === 'failed', { timeoutMs: 15000, label: 'the presence self-test to fail' });
    assert.equal(h.client.luaValue('ClaudeWoW.PresenceWorks()'), 'false');
    assert.equal(beatsSeen(h), 0);
    assert.match(h.client.diag(), /presence: slot polls only \(self-test failed: presence\/a\/\d{4}\.wav still reads present after the bridge deleted it\)/);
    const r = await h.client.say('after a failed self-test');
    assert.match(r.text, /after a failed self-test/);
    await h.bridge.waitForLine(/deleting a launch-time file does NOT read as missing/, { timeoutMs: 10000 });
    assert.equal(h.clientState().presenceTest.result, 'failed');
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
