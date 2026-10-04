'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SB = require('../../dev/sandbox');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('delivery-reload');
const withGame = gameRunner(ROOT);

test('a reply survives a /reload while the agent is still working', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    const id = h.client.lastSeq() + 1;
    h.client.send('slow one [[sleep 4]]');
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ \\(screenshot\\)`));
    h.client.reload();
    const reply = await h.client.waitFor(() => {
      const c = h.client.activeChat();
      return c && !c.pendingId && (c.history || []).find(m => m.id === id && m.role === 'assistant');
    }, { timeoutMs: 40000, label: 'the reply after the reload' });
    assert.match(reply.text, /slow one/);
  });
});

test('the reload path reads the Inbox.lua the bridge writes into ClaudeWoW_Runtime, and the shipped ClaudeWoW folder stays as shipped', async () => {
  await withGame({}, async h => {
    const r = await h.client.say('through the runtime folder');
    assert.match(r.text, /through the runtime folder/);
    h.client.reload();
    assert.equal(h.client.luaValue('C_AddOns.IsAddOnLoaded("ClaudeWoW_Runtime")'), 'true');
    assert.ok(Number(h.client.luaValue('ClaudeWoW_Inbox.now')) > 0, 'the bridge-written inbox, not the empty placeholder');
    const shipped = path.join(SB.REPO, 'addon', 'ClaudeWoW');
    assert.deepEqual(fs.readdirSync(path.join(h.sb.addons, 'ClaudeWoW')).sort(), fs.readdirSync(shipped).sort());
    assert.equal(fs.readFileSync(path.join(h.sb.addons, 'ClaudeWoW', 'Inbox.lua'), 'utf8'), fs.readFileSync(path.join(shipped, 'Inbox.lua'), 'utf8'));
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
