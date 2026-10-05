'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('openurl');
const withGame = gameRunner(ROOT);
const PR = 'https://github.com/o/r/pull/7';
const ADDON_GAP_MS = 5200;

function launches(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

const SPY = `
E2E_COPIED, E2E_TOASTS = {}, {}
ClaudeWoW.ShowCopy = function(text) table.insert(E2E_COPIED, text) end
local plainAdd = UIErrorsFrame.AddMessage
UIErrorsFrame.AddMessage = function(self, text, ...)
  table.insert(E2E_TOASTS, text)
  if plainAdd then return plainAdd(self, text, ...) end
end
`;

const wait = ms => new Promise(r => setTimeout(r, ms));

test('a click on a reply link reaches the bridge, which opens exactly that link with no shell and runs no agent; a refusal comes back to the copy box; a record for chat B carrying chat A link opens nothing', async () => {
  fs.mkdirSync(ROOT, { recursive: true });
  const opened = path.join(ROOT, 'opened.jsonl');
  await withGame({ env: { CLAUDE_WOW_OPEN_LINKS_LOG: opened } }, async h => {
    const reply = await h.client.say(`[[reply The fix is in ${PR}.]]`);
    assert.match(reply.text, /pull\/7/);
    h.client.runLua(SPY);
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
    assert.equal(h.client.luaValue('#E2E_COPIED'), '0', 'an opened link shows no copy box');

    await wait(ADDON_GAP_MS);
    const planted = 'https://planted.example/x';
    h.client.runLua(`local c = ClaudeWoWDB.chats[1]; table.insert(c.history, { role = "assistant", t = time(), text = "see ${planted}" })`);
    const refusedMark = h.bridge.output.length;
    h.client.clickLink(`|Haddon:claudewow:url:${planted}|h[planted]|h`);
    await h.bridge.waitForLine(/open link refused \(not a link from a reply in this chat\): "https:\/\/planted\.example\/x"/, {
      from: refusedMark,
      timeoutMs: 45000,
    });
    await h.client.waitFor(() => h.client.luaValue('E2E_COPIED[1]') === planted, { timeoutMs: 45000, label: 'the refused link in the copy box' });
    assert.equal(h.client.luaValue('E2E_TOASTS[#E2E_TOASTS]'), 'Link not opened: not a link from a reply in this chat. Copy it from the box.');
    assert.equal(launches(opened).length, 1, 'the bridge opened nothing for a link only the game holds');

    const echoed = await h.client.say('@dev log planted');
    assert.ok(echoed.text.includes(planted), 'a plugin reply that echoes the link: ' + echoed.text.slice(0, 300));
    await wait(ADDON_GAP_MS);
    const echoMark = h.bridge.output.length;
    h.client.clickLink(`|Haddon:claudewow:url:${planted}|h[planted]|h`);
    await h.bridge.waitForLine(/open link refused \(not a link from a reply in this chat\): "https:\/\/planted\.example\/x"/, {
      from: echoMark,
      timeoutMs: 45000,
    });
    assert.equal(launches(opened).length, 1, 'a link a plugin reply echoed is not an agent link');

    h.client.runLua('ClaudeWoW.NewChat()');
    await h.client.say('[[reply nothing to link here]]');
    const chatB = h.client.luaValue('ClaudeWoWDB.activeChat');
    assert.notEqual(chatB, h.client.luaValue('ClaudeWoWDB.chats[1].id'));
    const forged = h.bridge.output.length;
    h.client.runLua(`ClaudeWoW.Send(${JSON.stringify(PR)}, nil, { kind = "url", verbatim = true })`);
    await h.bridge.waitForLine(/open link refused \(not a link from a reply in this chat\): "https:\/\/github\.com\/o\/r\/pull\/7"/, {
      from: forged,
      timeoutMs: 45000,
    });
    assert.equal(launches(opened).length, 1, "chat A's link on a record for chat B opened nothing");
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
