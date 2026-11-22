'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeRoot, gameRunner } = require('./helpers');
const P = require('../../bridge/protocol');

const ROOT = makeRoot('startup-versions');
const withGame = gameRunner(ROOT);

test('a reload-mode session that never says hello is judged from its outbox and refused across a protocol mismatch', async () => {
  await withGame({ client: { afterAddonLoad: `WoWGPT.Version.PROTO = ${P.PROTO + 1}; WoWGPT.SayHello = function() end` } }, async h => {
    h.client.slash('/wowgpt config mode reload');
    h.client.send('through the outbox');
    await h.bridge.waitForLine(/refused: The companion app/, { timeoutMs: 30000 });
    const rec = await h.client.waitFor(() => Object.values(h.state().addons || {})[0], { timeoutMs: 10000, label: 'the versions saved in state.json' });
    assert.equal(rec.proto, P.PROTO + 1);
    assert.equal(rec.verdict, 'update-bridge');
    assert.equal(h.agentCalls().length, 0, 'the message never reached an agent');
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
