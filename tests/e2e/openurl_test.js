'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('openurl');
const withGame = gameRunner(ROOT);
const PR = 'https://github.com/o/r/pull/7';
const PLANTED = 'https://planted.example/x';
const WAITING_TOASTS = ['Still opening the last link', 'Wait a moment before the next link'];
const SEND_TIMEOUT_MS = 30000;
const RETRY_MS = 500;

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
const escape = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function lastSeq(h) {
  return Number(h.client.luaValue('ClaudeWoWDB.lastSeq'));
}

function lastToast(h) {
  return h.client.luaValue('E2E_TOASTS[#E2E_TOASTS]');
}

async function clickUntilSent(h, url) {
  const until = Date.now() + SEND_TIMEOUT_MS;
  for (;;) {
    const before = lastSeq(h);
    h.client.clickLink(`|Haddon:claudewow:url:${url}|h[link]|h`);
    const id = lastSeq(h);
    if (id > before) return id;
    const toast = lastToast(h);
    if (!WAITING_TOASTS.includes(toast) || Date.now() > until) {
      throw new Error(`the click on ${url} sent no record (toast ${JSON.stringify(toast)}, copy box ${h.client.luaValue('E2E_COPIED[#E2E_COPIED]')})`);
    }
    await wait(RETRY_MS);
  }
}

function openLine(h, id, rest) {
  return new RegExp(`#${id}@${escape(h.client.luaValue('ClaudeWoWDB.session'))}\\b.* ${rest}`);
}

const refused = (h, id, url) => openLine(h, id, escape(`open link refused (not a link from a reply in this chat): ${JSON.stringify(url)}`));

test('a click on a reply link reaches the bridge, which opens exactly that link with no shell and runs no agent; a refusal comes back to the copy box; a record for chat B carrying chat A link opens nothing', async () => {
  fs.mkdirSync(ROOT, { recursive: true });
  const opened = path.join(ROOT, 'opened.jsonl');
  await withGame({ env: { CLAUDE_WOW_OPEN_LINKS_LOG: opened } }, async h => {
    const reply = await h.client.say(`[[reply The fix is in ${PR}.]]`);
    assert.match(reply.text, /pull\/7/);
    h.client.runLua(SPY);
    const calls = h.agentCalls().length;
    const mark = h.bridge.output.length;
    const first = await clickUntilSent(h, PR);
    await h.bridge.waitForLine(openLine(h, first, escape(`open link: ${JSON.stringify(PR)}`)), { from: mark, timeoutMs: 45000 });
    const [launch, ...more] = launches(opened);
    assert.deepEqual(more, []);
    assert.deepEqual(launch.args.slice(-1), [PR]);
    assert.equal(launch.shell, false);
    assert.equal(h.agentCalls().length, calls, 'the record never reached an agent');
    assert.doesNotMatch(h.bridge.output.slice(mark), /runs claude/);
    assert.equal(h.client.luaValue('#E2E_COPIED'), '0', 'an opened link shows no copy box');

    h.client.runLua(`local c = ClaudeWoWDB.chats[1]; table.insert(c.history, { role = "assistant", t = time(), text = "see ${PLANTED}" })`);
    const refusedMark = h.bridge.output.length;
    const planted = await clickUntilSent(h, PLANTED);
    await h.bridge.waitForLine(refused(h, planted, PLANTED), { from: refusedMark, timeoutMs: 45000 });
    await h.client.waitFor(() => h.client.luaValue('E2E_COPIED[1]') === PLANTED, { timeoutMs: 45000, label: 'the refused link in the copy box' });
    assert.equal(lastToast(h), 'Link not opened: not a link from a reply in this chat. Copy it from the box.');
    assert.equal(launches(opened).length, 1, 'the bridge opened nothing for a link only the game holds');

    const echoed = await h.client.say('@dev log planted');
    assert.ok(echoed.text.includes(PLANTED), 'a plugin reply that echoes the link: ' + echoed.text.slice(0, 300));
    const echoMark = h.bridge.output.length;
    const again = await clickUntilSent(h, PLANTED);
    await h.bridge.waitForLine(refused(h, again, PLANTED), { from: echoMark, timeoutMs: 45000 });
    assert.equal(launches(opened).length, 1, 'a link a plugin reply echoed is not an agent link');

    h.client.runLua('ClaudeWoW.NewChat()');
    await h.client.say('[[reply nothing to link here]]');
    const chatB = h.client.luaValue('ClaudeWoWDB.activeChat');
    assert.notEqual(chatB, h.client.luaValue('ClaudeWoWDB.chats[1].id'));
    const forgedMark = h.bridge.output.length;
    const beforeForge = lastSeq(h);
    h.client.runLua(`ClaudeWoW.Send(${JSON.stringify(PR)}, nil, { kind = "url", verbatim = true })`);
    const forged = lastSeq(h);
    assert.ok(forged > beforeForge, 'the forged record went out');
    await h.bridge.waitForLine(refused(h, forged, PR), { from: forgedMark, timeoutMs: 45000 });
    assert.equal(launches(opened).length, 1, "chat A's link on a record for chat B opened nothing");
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
