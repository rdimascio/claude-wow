'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('delivery');
const withGame = gameRunner(ROOT);

test('every file the bridge writes into the game folder is 0777 like the rest of the install (Battle.net error 2113)', { skip: process.platform === 'win32' }, async () => {
  await withGame({}, async h => {
    await h.client.say('permissions');
    const addon = path.join(h.sb.addons, 'ClaudeWoW_Runtime');
    const presence = fs.readdirSync(path.join(addon, 'presence', 'b')).filter(n => n.endsWith('.wav'));
    assert.ok(fs.existsSync(path.join(addon, 'Inbox.lua')) && fs.existsSync(path.join(addon, 'ClaudeWoW_Runtime.toc')));
    assert.equal(presence.length, 2000, 'the presence rings are armed');
    const slotInboxes = fs.readdirSync(h.sb.addons).filter(n => /^ClaudeWoW_S\d{3}$/.test(n)).map(n => path.join(h.sb.addons, n, 'Inbox.lua'));
    assert.ok(slotInboxes.some(f => /echo/.test(fs.readFileSync(f, 'utf8'))), 'a slot carries the reply');
    const locked = [];
    const pending = [addon, ...slotInboxes];
    while (pending.length) {
      const current = pending.pop();
      const st = fs.statSync(current, { throwIfNoEntry: false });
      if (!st) continue;
      if ((st.mode & 0o777) !== 0o777) locked.push(`${current} ${(st.mode & 0o777).toString(8)}`);
      if (st.isDirectory()) for (const n of fs.readdirSync(current)) pending.push(path.join(current, n));
    }
    assert.deepEqual(locked, []);
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
