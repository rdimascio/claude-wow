'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const HO = require('../bridge/handoff');
const SS = require('../bridge/sessions');
const P = require('../bridge/protocol');

const ID = n => `0000000${n}-0000-4000-8000-00000000000${n}`;

function tmpDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-handoff-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

function repoWithWorktree(root) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'one');
  const wt = path.join(root, 'repo-wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  git(other, 'init', '-q', '-b', 'main');
  return { repo, wt, other };
}

function pidFile(claudeDir, pid, fields) {
  fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'sessions', `${pid}.json`), JSON.stringify({ pid, kind: 'interactive', ...fields }));
}

function transcript(claudeDir, id, cwd, events) {
  const dir = path.join(claudeDir, 'projects', SS.projectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

const allAlive = { alive: () => true, startOf: () => null };

test('repoKey is the same for a repository and its worktrees, and differs for another repository', t => {
  const { repo, wt, other } = repoWithWorktree(tmpDir(t));
  assert.equal(HO.repoKey(repo), HO.repoKey(wt));
  assert.equal(HO.repoKey(path.join(repo, '.')), HO.repoKey(repo));
  assert.notEqual(HO.repoKey(repo), HO.repoKey(other));
});

test('runningSessions keeps live interactive sessions and drops dead, reused, print-mode and malformed ones', t => {
  const claude = tmpDir(t);
  pidFile(claude, 101, { sessionId: ID(1), cwd: '/r', procStart: 'Mon Oct  5 07:18:58 2026', startedAt: 2 });
  pidFile(claude, 102, { sessionId: ID(2), cwd: '/r', startedAt: 1 });
  pidFile(claude, 103, { sessionId: ID(3), cwd: '/r', kind: 'print' });
  pidFile(claude, 104, { sessionId: 'not-an-id', cwd: '/r' });
  pidFile(claude, 105, { sessionId: ID(5), cwd: '/r', procStart: 'Sun Oct  4 01:00:00 2026' });
  pidFile(claude, 106, { sessionId: ID(6), cwd: '/r' });
  fs.writeFileSync(path.join(claude, 'sessions', '107.json'), '{broken');
  fs.writeFileSync(path.join(claude, 'sessions', '108.abc.key'), 'x');
  const deps = { alive: pid => pid !== 106, startOf: pid => (pid === 105 ? 'Mon Oct  5 09:00:00 2026' : 'Mon Oct 5 07:18:58 2026') };
  assert.deepEqual(HO.runningSessions(claude, deps).map(s => s.pid), [102, 101]);
});

test('sameProcess trusts the pid when the start time cannot be read', () => {
  assert.equal(HO.sameProcess({ pid: 1, procStart: 'x' }, { alive: () => true, startOf: () => null }), true);
  assert.equal(HO.sameProcess({ pid: 1, procStart: 'x' }, { alive: () => false, startOf: () => 'x' }), false);
});

test('lastExchange takes the last real prompt and the answer after it, skipping meta, tool results and side chains', t => {
  const claude = tmpDir(t);
  transcript(claude, ID(1), '/r', [
    { type: 'user', message: { content: 'fix the map pins' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at Map.lua.' }] } },
    { type: 'user', isMeta: true, message: { content: 'meta' } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } },
    { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub agent' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed in PR 12.\nCI is green.' }] } },
  ]);
  assert.deepEqual(HO.lastExchange(SS.sessionFileFor(claude, ID(1), '/r')), { asked: 'fix the map pins', answered: 'Fixed in PR 12. CI is green.' });
  assert.deepEqual(HO.lastExchange(path.join(claude, 'missing.jsonl')), { asked: '', answered: '' });
});

test('buildHandoff picks the sessions of one repository and its worktrees, with titles, branches and recaps', t => {
  const root = tmpDir(t);
  const { repo, wt, other } = repoWithWorktree(root);
  const claude = path.join(root, 'claude');
  pidFile(claude, 201, { sessionId: ID(1), cwd: repo, startedAt: 1 });
  pidFile(claude, 202, { sessionId: ID(2), cwd: wt, startedAt: 2 });
  pidFile(claude, 203, { sessionId: ID(3), cwd: other, startedAt: 3 });
  transcript(claude, ID(2), wt, [{ type: 'ai-title', aiTitle: 'Worktree fix' }, { type: 'user', message: { content: 'go' } }, { type: 'assistant', message: { content: 'done' } }]);
  const h = HO.buildHandoff({ claudeDir: claude, folder: wt, selfId: ID(1), now: 5, deps: allAlive });
  assert.equal(h.at, 5);
  assert.deepEqual(h.sessions.map(s => [s.id, s.self, s.branch]), [[ID(1), true, 'main'], [ID(2), false, 'feat/x']]);
  assert.equal(h.sessions[1].title, 'Worktree fix');
  assert.equal(h.sessions[1].asked, 'go');
  assert.equal(h.sessions[1].answered, 'done');
});

test('readHandoff drops a stale or malformed file and bad entries', t => {
  const home = tmpDir(t);
  const now = Date.parse('2026-10-05T08:00:00Z');
  assert.equal(HO.readHandoff(home, now), null);
  HO.writeHandoff(home, { at: now - HO.FRESH_MS - 1, sessions: [{ id: ID(1), cwd: '/r' }] });
  assert.equal(HO.readHandoff(home, now), null);
  HO.writeHandoff(home, { at: now + HO.FRESH_MS + 1, sessions: [] });
  assert.equal(HO.readHandoff(home, now), null);
  HO.writeHandoff(home, { at: 'soon', sessions: [] });
  assert.equal(HO.readHandoff(home, now), null);
  fs.writeFileSync(path.join(home, HO.FILE_NAME), '{nope');
  assert.equal(HO.readHandoff(home, now), null);
  HO.writeHandoff(home, { at: now, sessions: [{ id: ID(1), cwd: '/r', title: 'x'.repeat(200) }, { id: 'bad', cwd: '/r' }, { id: ID(2) }, null] });
  const h = HO.readHandoff(home, now);
  assert.deepEqual(h.sessions.map(s => s.id), [ID(1)]);
  assert.equal(h.sessions[0].title.length, 60);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, HO.FILE_NAME)).mode & 0o777, 0o600);
});

test('withHandoff puts the handed-off sessions first, keeps what the bridge knows about them, and drops duplicates', () => {
  const entries = HO.slotEntries({ at: 1000, sessions: [{ id: ID(1), cwd: '/r', title: 'One', asked: 'a', answered: 'b', startedAt: 0 }, { id: ID(2), cwd: '/r', title: 'Two', asked: '', answered: '', startedAt: 2000 }] });
  assert.deepEqual(entries[0], { id: ID(1), name: 'One', title: 'One', cwd: '/r', agent: 'claude', branch: undefined, at: 1, handoff: true, recap: 'Last ask: a\nLast answer: b' });
  const merged = [{ id: ID(3), name: 'other' }, { id: ID(2), name: 'Two', running: true, live: false }];
  const out = HO.withHandoff(merged, entries);
  assert.deepEqual(out.map(s => s.id), [ID(1), ID(2), ID(3)]);
  assert.equal(out[1].running, true);
  assert.equal(out[1].handoff, true);
  assert.equal(HO.withHandoff(merged, []), merged);
});

test('the slot carries handoff and recap on a session row', () => {
  const lua = P.luaTable('ClaudeWoW_SlotData', [], { sessions: [{ id: ID(1), name: 'One', cwd: '/r', agent: 'claude', at: 1, handoff: true, recap: 'Last ask: "x"\nLast answer: y' }] });
  assert.match(lua, /handoff = true, recap = "Last ask: \\"x\\"\\nLast answer: y"/);
});

test('main saves the list, stops the other sessions with --stop, and never stops its own', async t => {
  const root = tmpDir(t);
  const { repo } = repoWithWorktree(root);
  const home = path.join(root, 'home');
  const claude = path.join(root, 'claude');
  pidFile(claude, 301, { sessionId: ID(1), cwd: repo });
  pidFile(claude, 302, { sessionId: ID(2), cwd: repo });
  pidFile(claude, 303, { sessionId: ID(3), cwd: repo });
  const killed = [];
  const gone = new Set();
  const deps = {
    alive: pid => !gone.has(pid), startOf: () => null,
    kill: (pid, sig) => { killed.push([pid, sig]); if (pid !== 303) gone.add(pid); },
    stopWaitMs: 300,
  };
  const out = [];
  const code = await HO.main([repo, '--stop'], { out: s => out.push(s), err: s => out.push(s), env: { CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: ID(1) }, cwd: root, home, deps });
  assert.deepEqual(killed, [[302, 'SIGTERM'], [303, 'SIGTERM']]);
  assert.equal(code, 1);
  const text = out.join('\n');
  assert.match(text, /3 running Claude Code sessions in this repository/);
  assert.match(text, /\[this session\]/);
  assert.match(text, /Stopped 1 of 2 sessions\./);
  assert.match(text, /Still running \(pid 303\)/);
  assert.match(text, /This session was not stopped/);
  assert.equal(HO.readHandoff(home).sessions.length, 3);
});

test('main without --stop stops nothing; bad arguments exit 2', async t => {
  const root = tmpDir(t);
  const { repo } = repoWithWorktree(root);
  const claude = path.join(root, 'claude');
  pidFile(claude, 401, { sessionId: ID(1), cwd: repo });
  const killed = [];
  const out = [];
  const opts = { out: s => out.push(s), err: s => out.push(s), env: { CLAUDE_CONFIG_DIR: claude }, cwd: repo, home: path.join(root, 'home'), deps: { alive: () => true, startOf: () => null, kill: pid => killed.push(pid) } };
  assert.equal(await HO.main([], opts), 0);
  assert.deepEqual(killed, []);
  assert.match(out.join('\n'), /Quit these sessions \(or run this again with --stop\)/);
  assert.equal(await HO.main(['--force'], opts), 2);
  assert.equal(await HO.main(['a', 'b'], opts), 2);
  assert.equal(await HO.main([path.join(root, 'nope')], opts), 2);
  assert.equal(await HO.main(['--help'], opts), 0);
});
