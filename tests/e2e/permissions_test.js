'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('permissions');
const withGame = gameRunner(ROOT);

function outsideFolder(h) {
  const dir = path.join(h.sb.dir, 'scratch');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function answerTo(h, id, label) {
  return h.client.waitFor(
    () => {
      const c = h.client.activeChat();
      return c && !c.pendingId && (c.history || []).find(m => m.id === id && m.role !== 'user');
    },
    { timeoutMs: 60000, label },
  );
}

async function roll(h, choice) {
  await h.client.waitFor(() => h.client.luaValue('ClaudeWoWRoll.Armed() and "armed"') === 'armed', { label: 'the roll frame, armed' });
  const id = h.client.lastSeq() + 1;
  h.client.runLua(
    'function StaticPopup_Show(which, a, b, data) local d = { which = which, text = a, data = data, shown = true }; STUB.popup = d; return d end; STUB.popup = nil',
  );
  h.client.runLua(`ClaudeWoWRoll.Choose(${JSON.stringify(choice)})`);
  if (choice === 'need') {
    assert.equal(h.client.lastSeq() + 1, id, 'Need sends nothing before the confirm');
    assert.equal(h.client.luaValue('STUB.popup and STUB.popup.which'), 'CLAUDEWOW_ALLOW_ALWAYS');
    h.client.runLua('StaticPopupDialogs.CLAUDEWOW_ALLOW_ALWAYS.OnAccept(STUB.popup, STUB.popup.data)');
  }
  return answerTo(h, id, `the reply after ${choice}`);
}

const rollOpen = h => h.client.luaValue('ClaudeWoWRoll.Current() and "open" or "none"') === 'open';

test('Need on a missing rule reaches the very next run', async () => {
  await withGame({}, async h => {
    const first = await h.client.say('[[bash curl https://example.com]]');
    assert.deepEqual(first.denied, ['Bash(curl:*)']);
    const retry = await roll(h, 'need');
    assert.match(retry.text, /^ran \(turn 2\): curl/);
    const argv = h.agentCalls()[1].argv;
    assert.ok(argv.includes('Bash(curl:*)'), 'the granted rule is on the retry command line');
  });
});

test('a retry blocked again for what it was just granted stops the loop: no new roll, one plain line', async () => {
  await withGame({}, async h => {
    const scratch = outsideFolder(h);
    const first = await h.client.say(`[[bash-stuck touch ${scratch}/demo.txt]]`);
    assert.deepEqual(first.denied, [`AddDir(${scratch})`]);
    const retry = await roll(h, 'need');
    assert.equal(retry.denied, undefined);
    assert.match(
      retry.text,
      new RegExp(`blocked again on Bash: touch \\S+ although ${scratch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is already one of this chat's folders`),
    );
    assert.equal(rollOpen(h), false);
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(h.agentCalls().length, 2, 'nothing else ran');
    await h.bridge.waitForLine(/not offered again/);
  });
});
