'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('threads');
const withGame = gameRunner(ROOT);
const withThreads =
  ({ thread }) =>
  async sb => {
    const cfg = JSON.parse(fs.readFileSync(sb.config, 'utf8'));
    cfg.plugins['claude-code'] = { ...cfg.plugins['claude-code'], ...(thread ? { threads: [sb.project] } : {}) };
    fs.writeFileSync(sb.config, JSON.stringify(cfg, null, 2));
  };

async function twoTurnsAcrossARulesChange(h) {
  await h.client.say('first turn with game context');
  const first = h.agentCalls().at(-1);
  assert.equal(first.resume, null, 'the first turn starts a session');
  assert.match(first.prompt, /In-game situation/);
  h.client.slash('/claude config context off');
  await h.client.say('second turn without game context');
  const second = h.agentCalls().at(-1);
  assert.doesNotMatch(second.prompt, /In-game situation/, 'the game context turned off, which changes the system prompt rules');
  assert.match(h.bridge.output, /system prompt rules changed/);
  return { first, second };
}

test('a chat in a threads folder keeps its Claude session when the system prompt rules change', async () => {
  await withGame({ beforeLaunch: withThreads({ thread: true }) }, async h => {
    const { first, second } = await twoTurnsAcrossARulesChange(h);
    assert.equal(second.resume, first.session, 'the thread resumes the same session');
    assert.match(h.bridge.output, /thread chat, the session is kept/);
  });
});

test('a chat outside the threads folders still starts a new session when the system prompt rules change', async () => {
  await withGame({ beforeLaunch: withThreads({ thread: false }) }, async h => {
    const { first, second } = await twoTurnsAcrossARulesChange(h);
    assert.equal(second.resume, null, 'a new session');
    assert.notEqual(second.session, first.session);
  });
});
