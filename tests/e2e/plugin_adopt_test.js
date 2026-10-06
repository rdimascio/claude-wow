'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { REPO } = require('../../dev/sandbox');
const SS = require('../../bridge/sessions');
const { makeRoot, gameRunner, sentId } = require('./helpers');

const ROOT = makeRoot('pluginadopt');
const withGame = gameRunner(ROOT);
const BRIDGE = path.join(REPO, 'bridge', 'bridge.js');
const INJECT_KEY = ':default';

const askFolder = name => path.join(ROOT, `ask-${name}`);
const config = name => ({ plugins: { default: 'claude-code', ask: { cwd: askFolder(name), claudePlugin: true } } });

function injectSession(sb, plugin, folder) {
  const r = spawnSync(process.execPath, [BRIDGE, '--inject', 'plan my route [[reply planned]]', '--plugin', plugin], {
    cwd: REPO,
    env: sb.env,
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(r.status, 0, `--inject failed:\n${r.stdout}\n${r.stderr}`);
  const state = JSON.parse(fs.readFileSync(sb.state, 'utf8'));
  const id = state.sessions[INJECT_KEY];
  assert.ok(id, 'the --inject run left a session');
  assert.equal(state.sessionPlugin[INJECT_KEY], plugin, 'the --inject run recorded its plugin');
  const store = path.join(sb.user, '.claude', 'projects', SS.projectSlug(folder));
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, `${id}.jsonl`), JSON.stringify({ type: 'user', cwd: folder, sessionId: id }) + '\n');
  return id;
}

function answerTo(h, id, label) {
  return h.client.waitFor(
    () => {
      const c = h.client.activeChat();
      return c && !c.pendingId && (c.history || []).find(m => m.id === id && m.role === 'assistant');
    },
    { timeoutMs: 60000, label },
  );
}

async function slash(h, line) {
  h.client.slash(line);
  return answerTo(h, sentId(h.client), line);
}

test('/claude -r on an ask session an --inject run made resumes it as an ask run, with the plugin', async () => {
  let id = '';
  await withGame({ config: config('resume'), beforeLaunch: sb => (id = injectSession(sb, 'ask', askFolder('resume'))) }, async h => {
    await h.client.connect();
    const r = await slash(h, `/claude -r ${id.slice(0, 8)} carry on [[reply carried on]]`);
    assert.equal(r.text, 'carried on');
    const call = h.agentCalls().at(-1);
    assert.equal(call.resume, id, 'the run resumed the --inject session');
    assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(askFolder('resume')), 'in the ask folder');
    assert.ok(call.argv.includes('--plugin-dir'), 'as an ask run, with the plugin it started with');
    assert.equal(h.state().sessionPlugin[`chat:${h.client.activeChat().id}`], 'ask');
  });
});

test('/claude -r on a coding session from --inject, addressed to ask, starts a new ask session instead of resuming it', async () => {
  let id = '';
  await withGame({ config: config('switch'), beforeLaunch: sb => (id = injectSession(sb, 'claude-code', sb.project)) }, async h => {
    await h.client.connect();
    const r = await slash(h, `/claude -r ${id.slice(0, 8)} @ask where do I train [[reply in the city]]`);
    assert.equal(r.text, 'in the city');
    const call = h.agentCalls().at(-1);
    assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(askFolder('switch')), 'an ask run');
    assert.equal(call.resume, null, 'an ask run never resumes the coding session');
    assert.match(fs.readFileSync(h.sb.bridgeLog, 'utf8'), /plugin changed \(claude-code -> ask\): new session/);
    assert.equal(h.state().sessionPlugin[`chat:${h.client.activeChat().id}`], 'ask');
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
