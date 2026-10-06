'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SB = require('../../dev/sandbox');
const { encodePng } = require('../../dev/wow/client');
const { makeRoot, gameRunner, replyTo } = require('./helpers');

const ROOT = makeRoot('restart-shots');
const withGame = gameRunner(ROOT);

test('a strip screenshot shot while the bridge was stopped is decoded once by the next bridge, and a young player screenshot stays', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    await h.bridge.waitForLine(/hello from session/, { from: 0 });
    await h.bridge.stop();
    const before = new Set(h.screenshots());
    const id = h.client.lastSeq() + 1;
    h.client.send('sent while the bridge was down');
    const shot = await h.client.waitFor(() => h.screenshots().find(n => !before.has(n) && /^WoWScrnShot_.*\.png$/.test(n)), {
      label: 'the strip screenshot',
    });
    h.client.stop();
    const playerShot = 'WoWScrnShot_010199_000001.png';
    fs.writeFileSync(SB.assertSafe(path.join(h.sb.screenshots, playerShot)), encodePng(64, 64, Buffer.alloc(64 * 64 * 3, 90)));
    const from = h.bridge.output.length;
    h.bridge.start();
    await h.bridge.ready();
    await h.bridge.waitForLine(new RegExp(`strip #\\d+ \\(screenshot ${shot}`), { from });
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ done`), { from });
    await h.bridge.waitForLine(new RegExp(`screenshot: ${playerShot} .* holds no strip; left alone`), { from });
    const after = h.bridge.output.slice(from);
    assert.equal(after.split(`(screenshot ${shot}`).length - 1, 1, 'the leftover strip is decoded once');
    assert.ok(!/screenshot sweep \(startup/.test(after), 'the startup sweep deleted nothing unread');
    assert.ok(!h.screenshots().includes(shot), 'the strip file is deleted once read');
    assert.ok(h.screenshots().includes(playerShot), "the player's own screenshot stays");
    assert.equal(h.agentCalls().filter(c => JSON.stringify(c).includes('sent while the bridge was down')).length, 1, 'one agent run for the message');
    h.client.start();
    const reply = await h.client.waitFor(() => replyTo(h, id), { label: 'the reply in the game' });
    assert.match(reply.text, /sent while the bridge was down/);
  });
});
