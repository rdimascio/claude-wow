'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { REPO } = require('../../dev/sandbox');
const SS = require('../../bridge/sessions');
const { luaQuote } = require('../../dev/wow/client');
const { makeRoot, gameRunner, sentId } = require('./helpers');

const ROOT = makeRoot('pluginadopt');
const withGame = gameRunner(ROOT);
const BRIDGE = path.join(REPO, 'bridge', 'bridge.js');
const INJECT_KEY = ':default';

const TERMINAL = 'feedc0de-0000-4000-8000-00000000000a';

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
  assert.equal(SS.sessionPluginOf(state, id), plugin, 'the --inject run recorded its plugin');
  seedProjectSession(sb, id, folder);
  return id;
}

function seedProjectSession(sb, id, folder) {
  const store = path.join(sb.user, '.claude', 'projects', SS.projectSlug(folder));
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, `${id}.jsonl`), JSON.stringify({ type: 'user', cwd: folder, sessionId: id }) + '\n');
}

function seedHistory(sb, id, folder) {
  const line = { display: 'plan my route', timestamp: Date.now(), project: folder, sessionId: id };
  fs.appendFileSync(path.join(sb.user, '.claude', 'history.jsonl'), JSON.stringify(line) + '\n');
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

async function send(h, text) {
  h.client.send(text);
  return answerTo(h, sentId(h.client), text);
}

function assertAskRun(call, folder, resume) {
  assert.equal(call.resume, resume, 'the run resumed the ask session');
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(folder), 'in the ask folder');
  assert.ok(call.argv.includes('--plugin-dir'), 'as an ask run, with the plugin');
}

async function pickFromList(h, id) {
  const row = await h.client.waitFor(
    () => {
      h.client.slash('/claude -r more');
      const last = (h.client.activeChat().history || []).at(-1);
      return ((last && last.picker) || []).find(r => r.entry && r.entry.id === id);
    },
    { timeoutMs: 20000, everyMs: 500, label: `session ${id} in the picker` },
  );
  h.client.runLua(
    `(function() local c; for _, x in ipairs(ClaudeWoWDB.chats) do if x.id == ClaudeWoWDB.activeChat then c = x end end; local m = c.history[#c.history]; for _, r in ipairs(m.picker) do if r.entry and r.entry.id == ${luaQuote(id)} then ClaudeWoW.PickRow(r) return end end end)()`,
  );
  await h.client.waitFor(() => h.client.activeChat().resumeId === id, { label: 'the picked session attached' });
  return row.entry;
}

test('/claude -r on an ask session an --inject run made resumes it as an ask run, with the plugin, and the next message keeps it', async () => {
  let id = '';
  await withGame({ config: config('resume'), beforeLaunch: sb => (id = injectSession(sb, 'ask', askFolder('resume'))) }, async h => {
    await h.client.connect();
    const r = await slash(h, `/claude -r ${id.slice(0, 8)} carry on [[reply carried on]]`);
    assert.equal(r.text, 'carried on');
    assertAskRun(h.agentCalls().at(-1), askFolder('resume'), id);
    assert.equal(h.client.activeChat().plugin, 'ask', 'the chat carries the plugin of the session it holds');
    assert.equal(h.client.activeChat().cwd, '', 'an ask chat has no coding folder');
    const again = await send(h, 'and then [[reply then the docks]]');
    assert.equal(again.text, 'then the docks');
    assertAskRun(h.agentCalls().at(-1), askFolder('resume'), id);
    assert.equal(h.state().sessions[`chat:${h.client.activeChat().id}`], id);
  });
});

test('a second --inject on the same slot leaves the first session its plugin, so /claude -r still resumes it as an ask run', async () => {
  let ask = '';
  let code = '';
  const beforeLaunch = sb => {
    ask = injectSession(sb, 'ask', askFolder('twice'));
    code = injectSession(sb, 'claude-code', sb.project);
  };
  await withGame({ config: config('twice'), beforeLaunch }, async h => {
    assert.notEqual(code, ask, 'the second --inject made a new session on the same slot');
    assert.equal(h.state().sessions[INJECT_KEY], code);
    await h.client.connect();
    const r = await slash(h, `/claude -r ${ask.slice(0, 8)} carry on [[reply carried on]]`);
    assert.equal(r.text, 'carried on');
    assertAskRun(h.agentCalls().at(-1), askFolder('twice'), ask);
  });
});

test('@ask on a terminal session the bridge has no record of starts a new ask session, and the chat stays an ask chat', async () => {
  await withGame({ config: config('terminal'), beforeLaunch: sb => seedProjectSession(sb, TERMINAL, sb.project) }, async h => {
    await h.client.connect();
    const r = await slash(h, `/claude -r ${TERMINAL.slice(0, 8)} @ask where do I train [[reply in the city]]`);
    assert.equal(r.text, 'in the city');
    const first = h.agentCalls().at(-1);
    assert.equal(first.resume, null, 'a session with no record is a coding session, never resumed as an ask run');
    assert.equal(fs.realpathSync(first.cwd), fs.realpathSync(askFolder('terminal')));
    assert.match(fs.readFileSync(h.sb.bridgeLog, 'utf8'), /plugin changed \(claude-code -> ask\): new session/);
    assert.equal(h.client.activeChat().plugin, 'ask');
    const again = await send(h, 'and after that [[reply the docks]]');
    assert.equal(again.text, 'the docks');
    assertAskRun(h.agentCalls().at(-1), askFolder('terminal'), first.session);
  });
});

test('an ask session picked from the Claude Code history list attaches as an ask chat and resumes the ask session, twice', async () => {
  let id = '';
  const beforeLaunch = sb => {
    id = injectSession(sb, 'ask', askFolder('picker'));
    seedHistory(sb, id, askFolder('picker'));
  };
  await withGame({ config: config('picker'), beforeLaunch }, async h => {
    await h.client.connect();
    const entry = await pickFromList(h, id);
    assert.equal(entry.plugin, 'ask', 'the list names the plugin that made the session');
    assert.equal(h.client.activeChat().plugin, 'ask');
    const r = await send(h, 'carry on [[reply carried on]]');
    assert.equal(r.text, 'carried on');
    assertAskRun(h.agentCalls().at(-1), askFolder('picker'), id);
    const again = await send(h, 'and then [[reply then the docks]]');
    assert.equal(again.text, 'then the docks');
    assertAskRun(h.agentCalls().at(-1), askFolder('picker'), id);
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
    const state = h.state();
    assert.equal(SS.sessionPluginOf(state, state.sessions[`chat:${h.client.activeChat().id}`]), 'ask');
  });
});

test('slot plugin records from an older bridge are migrated once, so a later restart never re-reads a stale slot record', async () => {
  const LEGACY = 'feedc0de-0000-4000-8000-00000000000b';
  let fresh = '';
  const beforeLaunch = sb => {
    fs.writeFileSync(sb.state, JSON.stringify({ lastId: 0, handled: {}, sessions: { [INJECT_KEY]: LEGACY }, sessionPlugin: { [INJECT_KEY]: 'ask' } }));
    fresh = injectSession(sb, 'claude-code', sb.project);
    const state = JSON.parse(fs.readFileSync(sb.state, 'utf8'));
    assert.equal(SS.sessionPluginOf(state, LEGACY), 'ask', 'the first start migrated the slot record');
    assert.equal(state.slotPluginsAdopted, true);
    state.sessionPlugin = { [INJECT_KEY]: 'ask' };
    delete state.sessionPluginById[fresh];
    fs.writeFileSync(sb.state, JSON.stringify(state));
  };
  await withGame({ config: config('migrate'), beforeLaunch }, async h => {
    await h.client.connect();
    const state = h.state();
    assert.equal(state.sessions[INJECT_KEY], fresh);
    assert.equal(SS.sessionPluginOf(state, fresh), '', 'the restart did not migrate the stale slot record again');
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
