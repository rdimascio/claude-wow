'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner, TWO_CLIENTS: TWO, withEra, chatById, sentId } = require('./helpers');

const ROOT = makeRoot('sessionbusy');
const withGame = gameRunner(ROOT);
const LONG_RUN_RELEASE = 'long-run-release';

function answerTo(client, chatId, id, text, label) {
  return client.waitFor(
    () => {
      const c = chatById(client, chatId);
      return c && !c.pendingId && (c.history || []).find(m => m.id === id && m.role === 'assistant' && m.text.includes(text));
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
      h.client.send(`[[hold ${LONG_RUN_RELEASE}]] keep going`);
      await h.client.waitFor(() => h.agentCalls().find(c => c.prompt.includes('keep going')), { label: 'the long run to start' });

      era.slash(`/claude -r ${session.slice(0, 8)} and from here`);
      const attached = era.activeChat();
      const id = sentId(era, attached);
      assert.ok(
        attached.history.find(m => m.id === id && m.text === 'and from here'),
        `#${id} carries the attached chat's text`,
      );

      await h.bridge.waitForLine(new RegExp(`#${id}@\\w+ queued \\(its agent session is busy in another chat\\)`), { timeoutMs: 20000 });
      fs.writeFileSync(path.join(h.sb.agentState, LONG_RUN_RELEASE), '');
      await answerTo(era, attached.id, id, 'and from here', 'the attached chat answer');
    });

    const calls = h.agentCalls();
    const long = calls.find(c => c.prompt.includes('keep going'));
    const attached = calls.find(c => c.prompt.includes('and from here'));
    assert.equal(attached.resume, session, 'the attached chat resumed the same agent session');
    assert.ok(attached.turn > long.turn, `the attached run came after the long one (turns ${long.turn}, ${attached.turn})`);
  });
});
