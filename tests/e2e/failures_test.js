'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeRoot, gameRunner, sessionCostByAgent, isAlive, H } = require('./helpers');

const ROOT = makeRoot('failures');
const withGame = gameRunner(ROOT);

test('an agent that reports a rate limit reaches the player with the reason', async () => {
  await withGame({}, async h => {
    const r = await h.client.say('go [[rate-limit]]');
    assert.equal(r.role, 'system');
    assert.match(r.text, /usage limit/i);
  });
});

test('an agent error with no text tells the player something useful', async () => {
  await withGame({}, async h => {
    const r = await h.client.say('go [[error]]');
    assert.equal(r.role, 'system');
    assert.match(r.text, /error_during_execution/);
  });
});

test('a run that passes timeoutMs is stopped and the player is told the limit', async () => {
  await withGame({ config: { timeoutMs: 3000 } }, async h => {
    const r = await h.client.say('forever [[hang]]', { timeoutMs: 30000 });
    assert.equal(r.role, 'system');
    assert.match(r.text, /stopped after 3 s, the limit set by timeoutMs/);
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
