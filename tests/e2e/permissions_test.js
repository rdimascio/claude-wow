'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner, sentId } = require('./helpers');

const ROOT = makeRoot('permissions');
const withGame = gameRunner(ROOT);

function outsideFolder(h) {
  const dir = path.join(h.sb.dir, 'scratch');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function answerTo(h, id, label) {
  return h.client.waitFor(
    () => {
      const c = h.client.activeChat();
      return c && !c.pendingId && (c.history || []).find(m => m.id === id && m.role !== 'user');
    },
    { timeoutMs: 60000, label },
  );
}

async function roll(h, choice) {
  await h.client.waitFor(() => h.client.luaValue('WoWGPTRoll.Armed() and "armed"') === 'armed', { label: 'the roll frame, armed' });
  const id = h.client.lastSeq() + 1;
  h.client.runLua(
    'function StaticPopup_Show(which, a, b, data) local d = { which = which, text = a, data = data, shown = true }; STUB.popup = d; return d end; STUB.popup = nil',
  );
  h.client.runLua(`WoWGPTRoll.Choose(${JSON.stringify(choice)})`);
  if (choice === 'need') {
    assert.equal(h.client.lastSeq() + 1, id, 'Need sends nothing before the confirm');
    assert.equal(h.client.luaValue('STUB.popup and STUB.popup.which'), 'WOWGPT_ALLOW_ALWAYS');
    h.client.runLua('StaticPopupDialogs.WOWGPT_ALLOW_ALWAYS.OnAccept(STUB.popup, STUB.popup.data)');
  }
  return answerTo(h, id, `the reply after ${choice}`);
}

const flagAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];
const configRules = h => JSON.parse(fs.readFileSync(h.sb.config, 'utf8')).agents.claude.allowedTools || [];
const keptRules = h => (h.state().grants || {}).claude || [];

async function slash(h, line) {
  await h.client.connect();
  h.client.slash(line);
  return answerTo(h, sentId(h.client), line);
}

const rollOpen = h => h.client.luaValue('WoWGPTRoll.Current() and "open" or "none"') === 'open';

test('Need keeps an offered rule for later runs in state.json, never in config.json', async () => {
  await withGame({}, async h => {
    const before = configRules(h);
    const first = await h.client.say('[[bash curl https://example.com]]');
    assert.deepEqual(first.denied, ['Bash(curl:*)']);
    const retry = await roll(h, 'need');
    assert.match(retry.text, /^ran \(turn 2\): curl/);
    assert.ok(h.agentCalls()[1].argv.includes('Bash(curl:*)'), 'the granted rule is on the retry command line');
    const later = await h.client.say('[[bash curl https://example.org]]');
    assert.match(later.text, /^ran \(turn 3\): curl/, 'the kept rule reaches a later message without a roll');
    assert.ok(h.agentCalls()[2].argv.includes('Bash(curl:*)'));
    assert.deepEqual(keptRules(h), ['Bash(curl:*)']);
    assert.deepEqual(configRules(h), before, 'config.json is not written');
    await h.bridge.waitForLine(/kept in state\.json: Bash\(curl:\*\)/);
  });
});

test('an allow= rule the bridge never offered in the chat runs once and is not kept', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    h.client.runLua('WoWGPT.Send("[[bash curl https://example.com]]", { "Bash(curl:*)" })');
    const forged = await answerTo(h, sentId(h.client), 'the reply to the record with allow=');
    assert.match(forged.text, /^ran \(turn 1\): curl/);
    assert.ok(h.agentCalls()[0].argv.includes('Bash(curl:*)'), 'the rule applies to that run');
    const next = await h.client.say('[[bash curl https://example.com]]');
    assert.deepEqual(next.denied, ['Bash(curl:*)'], 'the next run does not have it');
    assert.ok(!h.agentCalls()[1].argv.includes('Bash(curl:*)'));
    assert.deepEqual(keptRules(h), []);
    assert.ok(!configRules(h).includes('Bash(curl:*)'), 'config.json is not written');
    await h.bridge.waitForLine(/allowed for this run only \(claude\), not offered in this chat: Bash\(curl:\*\)/);
  });
});

test('a permission mode above acceptEdits from the game is ignored, a lower one is used', async () => {
  await withGame({}, async h => {
    const high = await slash(h, '/wowgpt -c --permission-mode bypassPermissions hello');
    assert.equal(flagAfter(h.agentCalls().at(-1).argv, '--permission-mode'), 'acceptEdits');
    assert.match(high.text, /permission mode bypassPermissions was not used/);
    await h.bridge.waitForLine(/permission mode bypassPermissions from the game ignored/);
    await slash(h, '/wowgpt -c --permission-mode plan hello again');
    assert.equal(flagAfter(h.agentCalls().at(-1).argv, '--permission-mode'), 'plan');
  });
});

test('gamePermissionModes in config.json lets a chat pick a mode above acceptEdits', async () => {
  await withGame({ config: { gamePermissionModes: ['bypassPermissions'] } }, async h => {
    const reply = await slash(h, '/wowgpt -c --permission-mode bypassPermissions hello');
    assert.equal(flagAfter(h.agentCalls().at(-1).argv, '--permission-mode'), 'bypassPermissions');
    assert.doesNotMatch(reply.text, /was not used/);
  });
});

test('a retry blocked again for what it was just granted stops the loop: no new roll, one plain line', async () => {
  const beforeLaunch = sb => {
    const cfg = JSON.parse(fs.readFileSync(sb.config, 'utf8'));
    cfg.plugins = { ...cfg.plugins, 'claude-code': { folders: [path.join(sb.dir, 'scratch')] } };
    fs.writeFileSync(sb.config, JSON.stringify(cfg, null, 2));
  };
  await withGame({ beforeLaunch }, async h => {
    const scratch = outsideFolder(h);
    const first = await h.client.say(`[[bash-stuck touch ${scratch}/demo.txt]]`);
    assert.deepEqual(first.denied, [`AddDir(${scratch})`]);
    const retry = await roll(h, 'need');
    assert.equal(retry.denied, undefined);
    assert.match(
      retry.text,
      new RegExp(`blocked again on Bash: touch \\S+ although ${scratch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is already one of this chat's folders`),
    );
    assert.equal(rollOpen(h), false);
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(h.agentCalls().length, 2, 'nothing else ran');
    await h.bridge.waitForLine(/not offered again/);
  });
});

test('without plugins.claude-code.folders, a folder outside the default folder is never offered in game and never reaches the agent', async () => {
  await withGame({}, async h => {
    const scratch = outsideFolder(h);
    const first = await h.client.say(`[[bash-stuck touch ${scratch}/demo.txt]]`);
    assert.equal(first.denied, undefined, 'no roll offers the outside folder');
    assert.ok(!String(first.text).includes(`AddDir(${scratch})`));
    assert.equal(rollOpen(h), false);
    assert.ok(!h.agentCalls()[0].argv.includes(scratch), 'the outside folder is not on the command line');
    await slash(h, `/wowgpt -c --add-dir ${scratch} hello`);
    assert.ok(!h.agentCalls().at(-1).argv.includes(scratch), 'a dirs= folder outside the default folder is left out');
    await h.bridge.waitForLine(/extra folders left out/);
  });
});
