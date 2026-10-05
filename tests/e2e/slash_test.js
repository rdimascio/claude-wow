'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('slash');
const withGame = gameRunner(ROOT);
const POSIX = process.platform !== 'win32';

const withFactory = async sb => {
  const cfg = JSON.parse(fs.readFileSync(sb.config, 'utf8'));
  cfg.plugins['claude-code'] = { factory: { enabled: true, skills: ['babysit-pr', 'fresh-eyes'] } };
  fs.writeFileSync(sb.config, JSON.stringify(cfg, null, 2));
};

const runsOf = h => {
  try {
    return JSON.parse(fs.readFileSync(path.join(h.sb.home, 'factory', 'runs.json'), 'utf8')).runs;
  } catch {
    return [];
  }
};

test('/babysit-pr in a coding chat starts the factory run with no agent turn, /runs shows it, and its result comes back to the chat', async () => {
  await withGame({ beforeLaunch: withFactory }, async h => {
    const before = h.agentCalls().length;
    const started = await h.client.say('/babysit-pr 12');
    const id = (/^Started \/babysit-pr 12 as factory run ([0-9a-f]{8}) on opus\. /.exec(started.text) || [])[1];
    assert.ok(id, started.text);
    await h.bridge.waitForLine(new RegExp(`factory: run ${id} /babysit-pr done`), { timeoutMs: 30000 });
    const calls = h.agentCalls().slice(before);
    assert.deepEqual(
      calls.map(c => c.prompt),
      ['/babysit-pr 12'],
      'the only claude run is the skill itself, with the bare command on stdin: no dispatcher turn',
    );
    assert.equal(runsOf(h).find(r => r.id === id).status, 'done');

    const runs = await h.client.say(`/runs ${id}`);
    assert.match(runs.text, new RegExp(`^/babysit-pr 12: done after .*Factory run ${id}, model opus\\.`));
    assert.equal(h.agentCalls().length, before + 1, '/runs starts no run either');
    await h.client.waitFor(() => JSON.stringify(h.client.db()).includes(`Factory run ${id}, model`), {
      timeoutMs: 20000,
      label: 'the late result in the chat',
    });

    await h.client.say('/review-prs 3');
    assert.ok(h.agentCalls().at(-1).prompt.includes('/review-prs 3'), 'a skill not on the list goes to the dispatcher as a normal message');
  });
});

test('the skills reach the game as slash commands, and /stop ends a running skill as stopped', { skip: !POSIX }, async () => {
  await withGame({ beforeLaunch: withFactory }, async h => {
    await h.client.say('hello');
    await h.client.waitFor(() => h.client.luaValue('SLASH_CLAUDEWOW_SKILL_BABYSIT_PR1') === '/babysit-pr', {
      timeoutMs: 20000,
      label: 'the /babysit-pr game command',
    });
    assert.equal(h.client.luaValue('SLASH_CLAUDEWOW_SKILL_FRESH_EYES1'), '/fresh-eyes');
    assert.equal(h.client.luaValue('SLASH_CLAUDEWOW_SKILL_RUNS1'), '/runs');

    const id = h.client.lastSeq() + 1;
    h.client.runLua('SlashCmdList.CLAUDEWOW_SKILL_BABYSIT_PR("[[hang]]")');
    const started = await h.client.waitFor(
      () => {
        const c = h.client.activeChat();
        return c && !c.pendingId ? (c.history || []).find(m => m.id === id && m.role !== 'user') : null;
      },
      { timeoutMs: 30000, label: 'the reply to the game command' },
    );
    const runId = (/as factory run ([0-9a-f]{8})/.exec(started.text) || [])[1];
    assert.ok(runId, started.text);
    await h.client.waitFor(() => h.agentCalls().find(c => c.prompt === '/babysit-pr [[hang]]'), { label: 'the skill run to start' });

    const stopped = await h.client.say(`/stop ${runId}`);
    assert.match(stopped.text, new RegExp(`^Stopping factory run ${runId} \\(/babysit-pr\\)\\.`));
    await h.bridge.waitForLine(new RegExp(`factory: run ${runId} /babysit-pr stopped`), { timeoutMs: 30000 });
    assert.equal(runsOf(h).find(r => r.id === runId).why, 'It was stopped from the game.');
    const again = await h.client.say(`/stop ${runId}`);
    assert.match(again.text, /is not running; it is stopped\./);
  });
});
