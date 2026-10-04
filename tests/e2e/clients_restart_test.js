'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const SIG = require('../../bridge/signals');
const CLI = require('../../bridge/clients');
const { makeRoot, gameRunner, TWO_CLIENTS: TWO, slotBodies, withEra } = require('./helpers');

const ROOT = makeRoot('clients-restart');
const withGame = gameRunner(ROOT);

test('a reply kept across a restart is published again only in the client it answers, and a new addon session in the other client keeps it', async () => {
  await withGame({ ...TWO, run: false }, async h => {
    const forever = h.sb.clients[0];
    await withEra(h, async (era, eraDirs) => {
      await era.say('kept for era');
      const eraKey = CLI.keyOf(eraDirs.client);
      const keptForEra = () => Object.values(h.state().replies || {}).filter(e => e.record && e.record.client === eraKey && /kept for era/.test(e.record.text));
      assert.equal(keptForEra().length, 1, 'the reply is kept in state.json with its client');
      const eraInbox = SIG.runtimeInbox(eraDirs.addons);
      const foreverInbox = SIG.runtimeInbox(forever.addons);
      await h.bridge.stop();
      fs.writeFileSync(eraInbox, '');
      h.bridge.start();
      await h.bridge.ready();
      await h.bridge.waitForLine(/republishing \d+ finished repl(y|ies) from before the restart/);
      await era.waitFor(() => /kept for era/.test(fs.readFileSync(eraInbox, 'utf8')), { timeoutMs: 20000, label: 'the kept reply in B\'s Inbox.lua again' });
      assert.doesNotMatch(fs.readFileSync(foreverInbox, 'utf8'), /kept for era/, 'client A never gets B\'s kept reply');
      for (const body of slotBodies(forever.addons)) assert.doesNotMatch(body, /kept for era/);
      h.client.start();
      await h.client.say('a new session in forever');
      assert.equal(keptForEra().length, 1, 'a new addon session in A leaves B\'s kept reply alone');
      assert.match(fs.readFileSync(eraInbox, 'utf8'), /kept for era/, 'and B still has it');
    });
  });
});
