'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const SIG = require('../../bridge/signals');
const { makeRoot, gameRunner, TWO_CLIENTS: TWO, slotBodies, withEra } = require('./helpers');

const ROOT = makeRoot('clients');
const withGame = gameRunner(ROOT);

test('each run gets the game context of the client its message came from, even when the other client spoke since', async () => {
  await withGame({ ...TWO, run: false }, async h => {
    await withEra(h, async era => {
      await era.connect();
      await h.bridge.waitForLine(/\(_classic_era_\) game context updated/, { timeoutMs: 20000 });
      h.client.start();
      await h.client.connect();
      await h.bridge.waitForLine(/\(_classic_beta_\) game context updated/, { timeoutMs: 20000 });
      const b = await era.say('and this one');
      h.client.slash('/claude config context on');
      const a = await h.client.say('which game am I in');
      assert.match(h.state().context.text, /1\.60\.1/, "client A reported last, so the shared context is A's");
      const calls = h.agentCalls();
      const promptOf = text => (calls.find(c => String(c.prompt || '').includes(text)) || {}).prompt || '';
      assert.match(promptOf('which game am I in'), /1\.60\.1/, "client A's run carries A's build");
      assert.doesNotMatch(promptOf('which game am I in'), /1\.15\.9/, 'and not the build of B, which spoke after A');
      assert.match(promptOf('and this one'), /1\.15\.9/);
      assert.doesNotMatch(promptOf('and this one'), /1\.60\.1/);
      assert.match(a.text, /which game/);
      assert.match(b.text, /this one/);
      era.slash('/claude config context off');
      await era.say('no context here');
      const bare = (h.agentCalls().find(c => String(c.prompt || '').includes('no context here')) || {}).prompt || '';
      assert.ok(bare, 'the run started');
      assert.doesNotMatch(bare, /1\.60\.1|1\.15\.9/, "a client that turned its context off never gets the other client's");
    });
  });
});

test("a reload-mode message from client B is read from B's SavedVariables and answered in B's Inbox.lua only", async () => {
  await withGame({ ...TWO, run: false }, async h => {
    const forever = h.sb.clients[0];
    await withEra(h, async (era, eraDirs) => {
      await era.connect();
      era.slash('/claude config mode reload');
      const id = era.lastSeq() + 1;
      era.send('by reload in era');
      era.reload();
      await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ \\(reload\\)`), { timeoutMs: 20000 });
      await era.waitFor(() => /by reload in era/.test(fs.readFileSync(SIG.runtimeInbox(eraDirs.addons), 'utf8')), {
        timeoutMs: 30000,
        label: "the reply in B's Inbox.lua",
      });
      assert.doesNotMatch(fs.readFileSync(SIG.runtimeInbox(forever.addons), 'utf8'), /by reload in era/);
      for (const body of slotBodies(forever.addons)) assert.doesNotMatch(body, /by reload in era/);
    });
  });
});
