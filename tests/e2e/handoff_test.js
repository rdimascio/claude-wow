'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner } = require('./helpers');
const SS = require('../../bridge/sessions');
const HO = require('../../bridge/handoff');

const ROOT = makeRoot('handoff');
const withGame = gameRunner(ROOT);

const A = 'b0b0a0a0-0000-4000-8000-000000000001';
const B = 'b0b0a0a0-0000-4000-8000-000000000002';

function seed(sb) {
  const dir = path.join(sb.user, '.claude', 'projects', SS.projectSlug(sb.project));
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, title] of [
    [A, 'Fix map pins'],
    [B, 'Cost cap'],
  ]) {
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      [
        { type: 'user', cwd: sb.project, sessionId: id },
        { type: 'ai-title', aiTitle: title, sessionId: id },
      ]
        .map(l => JSON.stringify(l))
        .join('\n') + '\n',
    );
    fs.writeFileSync(path.join(sb.agentState, `${id}.json`), JSON.stringify({ id, turns: 3, total: {}, created: Date.now() - 3600000 }));
  }
  HO.writeHandoff(sb.home, {
    at: Date.now(),
    repo: sb.project,
    folder: sb.project,
    sessions: [
      { id: A, cwd: sb.project, title: 'Fix map pins', asked: 'fix the pins', answered: 'PR 12 is open, CI pending.', startedAt: Date.now() - 7200000 },
      { id: B, cwd: sb.project, title: 'Cost cap', asked: '', answered: 'Deployed.', startedAt: Date.now() - 3600000 },
    ],
  });
}

test('/claude -r all turns a handoff list into one chat per session, and the first message there resumes that session', async () => {
  await withGame({ beforeLaunch: seed }, async h => {
    await h.client.connect();
    const before = h.client.db().chats.length;
    h.client.slash('/claude -r all');
    await h.client.waitFor(() => h.client.db().chats.length === before + 2, { label: 'two handoff chats' });
    const chats = h.client.db().chats.slice(before);
    const pins = chats.find(c => c.resumeId === A);
    assert.ok(pins, 'a chat for the first session');
    assert.ok(
      chats.find(c => c.resumeId === B),
      'a chat for the second session',
    );
    assert.ok(pins.history.some(m => /Last answer: PR 12 is open, CI pending\./.test(m.text)));
    h.client.slash(`/claude-wow chat ${h.client.db().chats.findIndex(c => c.id === pins.id) + 1}`);
    await h.client.waitFor(() => h.client.activeChat().id === pins.id, { label: 'switch to the pins chat' });
    const id = h.client.lastSeq() + 1;
    h.client.slash('/claude -c where were we');
    await h.client.waitFor(
      () => {
        const c = h.client.activeChat();
        return c && !c.pendingId && (c.history || []).find(m => m.id === id && m.role !== 'user');
      },
      { timeoutMs: 60000, label: 'the reply' },
    );
    const call = h.agentCalls().at(-1);
    assert.equal(call.argv[call.argv.indexOf('--resume') + 1], A);
    assert.equal(call.cwd, fs.realpathSync(h.sb.project));
  });
});

test('/claude -r all leaves a handed-off session closed while its process still runs', { skip: process.platform === 'win32' }, async () => {
  const { execFileSync } = require('child_process');
  const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  }).trim();
  const seedRunning = sb => {
    seed(sb);
    const h = JSON.parse(fs.readFileSync(path.join(sb.home, HO.FILE_NAME), 'utf8'));
    h.sessions[1] = { ...h.sessions[1], pid: process.pid, procStart };
    HO.writeHandoff(sb.home, h);
  };
  await withGame({ beforeLaunch: seedRunning }, async h => {
    await h.client.connect();
    const before = h.client.db().chats.length;
    h.client.slash('/claude -r all');
    await h.client.waitFor(() => h.client.db().chats.length === before + 1, { label: 'one handoff chat' });
    const chats = h.client.db().chats.slice(before);
    assert.equal(chats[0].resumeId, A);
    assert.ok(chats[0].history.some(m => /Still running in a terminal, so not opened .*Cost cap/.test(m.text)));
  });
});
