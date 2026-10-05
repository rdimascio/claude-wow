'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const SB = require('../../dev/sandbox');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('delivery-wrap');
const withGame = gameRunner(ROOT);

test('message ids past the slot count still get acked and answered without marking the signals unreliable', async () => {
  const slots = Array.from({ length: 200 }, (_, i) => i + 1);
  await withGame(
    {
      client: { speed: 8 },
      speed: 8,
      beforeLaunch: sb => {
        fs.writeFileSync(sb.saved, '\r\nClaudeWoWDB = {\r\n["lastSeq"] = 200,\r\n}\r\n');
        SB.spendSignals(sb, ['ack', 'sig'], slots);
      },
    },
    async h => {
      const r = await h.client.say('after the wrap [[sleep 20]]', { timeoutMs: 60000 });
      assert.match(r.text, /after the wrap/);
      const diag = h.client.diag();
      assert.match(diag, /marked unreliable this session: false/);
      assert.ok(!h.client.prints().some(p => /didn't see/i.test(p)), 'the addon never gave up on the message');
    },
  );
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
