'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('openurl');
const withGame = gameRunner(ROOT);
const PR = 'https://github.com/o/r/pull/7';

function launches(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

test('a click on a reply link reaches the bridge, which opens exactly that link with no shell and runs no agent; a forged record for any other link opens nothing', async () => {
  fs.mkdirSync(ROOT, { recursive: true });
  const opened = path.join(ROOT, 'opened.jsonl');
  await withGame({ env: { CLAUDE_WOW_OPEN_LINKS_LOG: opened } }, async h => {
    const reply = await h.client.say(`[[reply The fix is in ${PR}.]]`);
    assert.match(reply.text, /pull\/7/);
    const calls = h.agentCalls().length;
    const mark = h.bridge.output.length;
    h.client.clickLink(`|Haddon:claudewow:url:${PR}|h[PR #7]|h`);
    await h.bridge.waitForLine(/open link: "https:\/\/github\.com\/o\/r\/pull\/7"/, { from: mark, timeoutMs: 45000 });
    const [launch, ...more] = launches(opened);
    assert.deepEqual(more, []);
    assert.deepEqual(launch.args.slice(-1), [PR]);
    assert.equal(launch.shell, false);
    assert.equal(h.agentCalls().length, calls, 'the record never reached an agent');
    assert.doesNotMatch(h.bridge.output.slice(mark), /runs claude/);

    await h.client.say('look at https://evil.example/x [[reply ok]]');
    const forged = h.bridge.output.length;
    h.client.runLua('ClaudeWoW.Send("https://evil.example/x", nil, { kind = "url", verbatim = true })');
    await h.bridge.waitForLine(/open link refused \(not a link from a reply in this chat\): "https:\/\/evil\.example\/x"/, { from: forged, timeoutMs: 45000 });
    assert.equal(launches(opened).length, 1, 'nothing else was opened');
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
