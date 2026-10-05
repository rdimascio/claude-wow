'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('delivery-chatlog');
const withGame = gameRunner(ROOT);

test('with capture.chatLog on, a message goes out through the chat log file and no screenshot is taken', async () => {
  await withGame({ capture: { chatLog: { enabled: true } } }, async h => {
    await h.bridge.waitForLine(/chat log transport: watching/);
    const r = await h.client.say('hello through the chat log');
    assert.match(r.text, /echo \(turn 1\): hello through the chat log/);
    assert.match(h.bridge.output, /strip #\d+ \(chat log, \d+ line\(s\)\): \d+ message\(s\)/);
    assert.match(h.bridge.output, /#\d+@\S+ \(chatlog\)/);
    assert.ok(!/\(screenshot WoWScrnShot/.test(h.bridge.output), 'no strip came from a screenshot');
    assert.deepEqual(h.screenshots(), []);
    assert.match(h.client.diag(), /chat log transport: on, lines of 900, filler 50000 bytes; \d+ frames, \d+ lines written, [1-9]\d* acknowledged first time, 0 only after the screenshot retry/);
    const slot = fs.readFileSync(path.join(h.sb.addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8');
    const session = /session token: (\w+)/.exec(h.client.diag())[1];
    const acked = [...slot.matchAll(/\{ session = "(\w+)", id = (\d+) \}/g)].filter(m => m[1] === session).map(m => Number(m[2]));
    assert.ok(acked.length >= 2, `the slot file lists the hello and the message as acknowledged (${acked.join(', ')})`);
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
