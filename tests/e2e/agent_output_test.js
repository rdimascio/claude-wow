'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const V = require('../../bridge/vision');
const { SPLIT_UTF8_TEXT } = require('../../dev/fake-claude');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('agentoutput');
const withGame = gameRunner(ROOT);
const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;
const OPEN_FILE = 0o644;
const OPEN_DIR = 0o755;

const modeOf = file => fs.statSync(file).mode & 0o777;
const keptMessages = (h, chat) => ((h.transcripts().chats || {})[chat] || { messages: [] }).messages;

test('an agent reply and its error output keep characters whose bytes arrive in two reads', async () => {
  await withGame({}, async h => {
    await h.client.say('[[split-unicode]]');
    const chat = h.client.activeChat().id;
    const reply = keptMessages(h, chat).find(m => m.role === 'assistant');
    assert.ok(reply && reply.text.includes(SPLIT_UTF8_TEXT), `the reply is whole: ${reply && reply.text}`);
    await h.client.say('[[split-stderr]]');
    const failure = keptMessages(h, chat).find(m => m.role === 'system');
    assert.ok(failure && failure.text.includes(SPLIT_UTF8_TEXT), `the error output is whole: ${failure && failure.text}`);
  });
});

test('state, transcripts, the log and run scratch files are private to the user, and older open ones are made private', { skip: process.platform === 'win32' }, async () => {
  let tmp = '';
  const beforeLaunch = sb => {
    tmp = path.join(sb.home, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    fs.chmodSync(tmp, OPEN_DIR);
    for (const file of [sb.state, sb.transcripts, sb.bridgeLog]) {
      if (!fs.existsSync(file)) fs.writeFileSync(file, file.endsWith('.json') ? '{}' : '');
      fs.chmodSync(file, OPEN_FILE);
    }
  };
  await withGame({ beforeLaunch }, async h => {
    await h.client.connect();
    h.client.runLua('ClaudeWoW.Send("what do you see [[hang]]", nil, { vision = true })');
    await h.client.waitFor(() => h.agentCalls().some(c => c.images === 1), { label: 'the vision run to start' });
    const pngs = fs.readdirSync(tmp).filter(V.isVisionFile).map(name => path.join(tmp, name));
    assert.ok(pngs.length >= 1, 'the run\'s screenshot is in tmp');
    for (const png of pngs) assert.equal(modeOf(png), PRIVATE_FILE, `${path.basename(png)} is private`);
    assert.equal(modeOf(tmp), PRIVATE_DIR, 'tmp is private');
    for (const file of [h.sb.state, h.sb.transcripts, h.sb.bridgeLog]) assert.equal(modeOf(file), PRIVATE_FILE, `${path.basename(file)} is private`);
    h.client.slash('/claude cancel');
    await h.bridge.waitForLine(/cancelled from the game; ending it/);
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
