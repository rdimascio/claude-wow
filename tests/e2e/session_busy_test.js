'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRoot, gameRunner, TWO_CLIENTS: TWO, withEra } = require('./helpers');

const ROOT = makeRoot('sessionbusy');
const withGame = gameRunner(ROOT);

function answerTo(client, id, label) {
  return client.waitFor(
    () => {
      const c = client.activeChat();
      return c && !c.pendingId && (c.history || []).find(m => m.id === id && m.role !== 'user');
    },
    { timeoutMs: 60000, label },
  );
}

test('a chat on another client attached to an agent session that is running waits for that run, then resumes the same session', async () => {
  await withGame({ ...TWO }, async h => {
    await h.client.say('start the work');
    const session = h.agentCalls().at(-1).session;
    assert.ok(session, 'the first chat has an agent session');

    await withEra(h, async era => {
      await era.connect();
      h.client.send('[[sleep 4]] keep going');
      await h.client.waitFor(() => h.agentCalls().find(c => c.prompt.includes('keep going')), { label: 'the long run to start' });

      const id = era.lastSeq() + 1;
      era.slash(`/claude -r ${session.slice(0, 8)} and from here`);
      await h.bridge.waitForLine(/queued \(its agent session is busy in another chat\)/, { timeoutMs: 20000 });
      await answerTo(era, id, 'the attached chat answer');
    });

    const calls = h.agentCalls();
    const long = calls.find(c => c.prompt.includes('keep going'));
    const attached = calls.find(c => c.prompt.includes('and from here'));
    assert.equal(attached.resume, session, 'the attached chat resumed the same agent session');
    assert.ok(attached.turn > long.turn, `the attached run came after the long one (turns ${long.turn}, ${attached.turn})`);
  });
});
