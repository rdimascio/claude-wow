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
  fs.writeFileSync(path.join(claudeDir, 'sessions', `${pid}.json`), JSON.stringify({ pid, kind: 'interactive', status: 'idle', procStart: 'Mon Oct  5 07:00:00 2026', ...fields }));
}

function transcript(claudeDir, id, cwd, events) {
  const dir = path.join(claudeDir, 'projects', SS.projectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

const START = 'Mon Oct 5 07:00:00 2026';
const allAlive = { alive: () => true, startOf: () => START };

test('repoKey is the same for a repository and its worktrees, and differs for another repository', t => {
  const { repo, wt, other } = repoWithWorktree(tmpDir(t));
  assert.equal(HO.repoKey(repo), HO.repoKey(wt));
  assert.equal(HO.repoKey(path.join(repo, '.')), HO.repoKey(repo));
  assert.notEqual(HO.repoKey(repo), HO.repoKey(other));
});

test('runningSessions keeps live interactive sessions and drops dead, reused, print-mode and malformed ones', t => {
  const claude = tmpDir(t);
  pidFile(claude, 101, { sessionId: ID(1), cwd: '/r', procStart: 'Mon Oct  5 07:18:58 2026', startedAt: 2 });
  pidFile(claude, 102, { sessionId: ID(2), cwd: '/r', startedAt: 1, procStart: undefined });
  pidFile(claude, 103, { sessionId: ID(3), cwd: '/r', kind: 'print' });
  pidFile(claude, 104, { sessionId: 'not-an-id', cwd: '/r' });
  pidFile(claude, 105, { sessionId: ID(5), cwd: '/r', procStart: 'Sun Oct  4 01:00:00 2026' });
  pidFile(claude, 106, { sessionId: ID(6), cwd: '/r' });
  fs.writeFileSync(path.join(claude, 'sessions', '107.json'), '{broken');
  fs.writeFileSync(path.join(claude, 'sessions', '108.abc.key'), 'x');
  const deps = { alive: pid => pid !== 106, startOf: pid => (pid === 105 ? 'Mon Oct  5 09:00:00 2026' : 'Mon Oct 5 07:18:58 2026') };
  const found = HO.runningSessions(claude, deps);
  assert.deepEqual(found.map(s => [s.pid, s.verified]), [[102, false], [101, true]]);
});

test('processState: same, unverified when the start time cannot be read, gone when dead or started at another time', () => {
  assert.equal(HO.processState({ pid: 1, procStart: START }, { alive: () => true, startOf: () => 'Mon Oct  5 07:00:01 2026' }), 'same');
  assert.equal(HO.processState({ pid: 1, procStart: START }, { alive: () => true, startOf: () => null }), 'unverified');
  assert.equal(HO.processState({ pid: 1, procStart: '' }, { alive: () => true, startOf: () => START }), 'unverified');
  assert.equal(HO.processState({ pid: 1, procStart: START }, { alive: () => false, startOf: () => START }), 'gone');
  assert.equal(HO.processState({ pid: 1, procStart: START }, { alive: () => true, startOf: () => 'Mon Oct 5 07:00:05 2026' }), 'gone');
});

test('ancestorsOf walks parents up to init', () => {
  const parents = { 50: 40, 40: 30, 30: 1 };
  assert.deepEqual(HO.ancestorsOf(50, { parentOf: p => parents[p] }), [50, 40, 30]);
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
  assert.equal(h.claudeDir, claude);
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

function mainSetup(t, sessions) {
  const root = tmpDir(t);
  const { repo } = repoWithWorktree(root);
  const claude = path.join(root, 'claude');
  for (const [pid, n, extra] of sessions) pidFile(claude, pid, { sessionId: ID(n), cwd: repo, ...extra });
  const killed = [];
  const gone = new Set();
  const out = [];
  const deps = {
    alive: pid => !gone.has(pid), startOf: () => START, selfPids: new Set(),
    kill: (pid, sig) => { killed.push([pid, sig]); gone.add(pid); },
    stopWaitMs: 300,
  };
  const opts = { out: s => out.push(s), err: s => out.push(s), env: { CLAUDE_CONFIG_DIR: claude }, cwd: repo, home: path.join(root, 'home'), deps, platform: 'darwin' };
  return { root, repo, claude, killed, gone, out, deps, opts };
}

test('--stop ends idle verified sessions only: never its own, a busy one, a shell one, or one whose start time is unknown', async t => {
  const m = mainSetup(t, [[301, 1], [302, 2], [303, 3, { status: 'busy' }], [304, 4, { status: 'shell' }], [305, 5, { procStart: undefined }]]);
  m.opts.env.CLAUDE_CODE_SESSION_ID = ID(1);
  const code = await HO.main(['--stop'], m.opts);
  assert.deepEqual(m.killed, [[302, 'SIGTERM']]);
  assert.equal(code, 1);
  const text = m.out.join('\n');
  assert.match(text, /5 Claude Code sessions in this repository/);
  assert.match(text, /\[this session\]/);
  assert.match(text, /Not stopped: .*pid 303\): it is busy; let it finish or use --force/);
  assert.match(text, /Not stopped: .*pid 304\): it is shell/);
  assert.match(text, /Not stopped: .*pid 305\): its start time could not be checked/);
  assert.match(text, /This session was not stopped/);
  assert.equal(HO.readHandoff(m.opts.home).sessions.length, 5);
});

test('--stop --force ends busy sessions too, and a parent process counts as this session', async t => {
  const m = mainSetup(t, [[401, 1, { status: 'busy' }], [402, 2]]);
  m.deps.selfPids = new Set([402]);
  assert.equal(await HO.main(['--stop', '--force'], m.opts), 0);
  assert.deepEqual(m.killed, [[401, 'SIGTERM']]);
});

test('--stop on Windows ends nothing and says why', async t => {
  const m = mainSetup(t, [[501, 1]]);
  m.opts.platform = 'win32';
  assert.equal(await HO.main(['--stop'], m.opts), 1);
  assert.deepEqual(m.killed, []);
  assert.match(m.out.join('\n'), /Windows: quit it in its terminal/);
});

test('a second run keeps the sessions the first one stopped', async t => {
  const m = mainSetup(t, [[601, 1], [602, 2, { status: 'busy' }]]);
  await HO.main(['--stop'], m.opts);
  assert.deepEqual(m.killed.map(k => k[0]), [601]);
  m.out.length = 0;
  fs.rmSync(path.join(m.claude, 'sessions', '601.json'));
  fs.writeFileSync(path.join(m.claude, 'sessions', '602.json'), JSON.stringify({ pid: 602, kind: 'interactive', status: 'idle', procStart: START, sessionId: ID(2), cwd: m.repo }));
  assert.equal(await HO.main(['--stop'], m.opts), 0);
  assert.deepEqual(m.killed.map(k => k[0]), [601, 602]);
  assert.deepEqual(HO.readHandoff(m.opts.home).sessions.map(s => s.id).sort(), [ID(1), ID(2)]);
  assert.match(m.out.join('\n'), /\(stopped earlier\)/);
});

test('mergeEarlier keeps only the same repository', () => {
  const fresh = { repo: '/a', sessions: [{ id: ID(1) }] };
  assert.deepEqual(HO.mergeEarlier(fresh, { repo: '/a', sessions: [{ id: ID(1) }, { id: ID(2) }] }).sessions.map(s => s.id), [ID(1), ID(2)]);
  assert.equal(HO.mergeEarlier(fresh, { repo: '/b', sessions: [{ id: ID(2) }] }), fresh);
  assert.equal(HO.mergeEarlier(fresh, null), fresh);
});

test('slotEntries marks a session whose process still runs, so the game does not open it', () => {
  const h = { at: 1000, sessions: [{ id: ID(1), cwd: '/r', pid: 7, procStart: START }, { id: ID(2), cwd: '/r', pid: 0 }] };
  const entries = HO.slotEntries(h, { running: s => HO.stillRunning(s, { alive: p => p === 7, startOf: () => START }) });
  assert.equal(entries[0].running, true);
  assert.equal(entries[1].running, undefined);
  assert.equal(HO.withHandoff([{ id: ID(1), running: false }], entries)[0].running, true);
});

test('main without --stop stops nothing; bad arguments exit 2', async t => {
  const m = mainSetup(t, [[701, 1]]);
  assert.equal(await HO.main([], m.opts), 0);
  assert.deepEqual(m.killed, []);
  assert.match(m.out.join('\n'), /Quit these sessions \(or run this again with --stop\)/);
  assert.equal(await HO.main(['--nope'], m.opts), 2);
  assert.equal(await HO.main(['a', 'b'], m.opts), 2);
  assert.equal(await HO.main([path.join(m.root, 'nope')], m.opts), 2);
  assert.equal(await HO.main(['--help'], m.opts), 0);
});

test('main reads claudeDir from the bridge config before CLAUDE_CONFIG_DIR', async t => {
  const m = mainSetup(t, [[801, 1]]);
  const other = path.join(m.root, 'other-claude');
  fs.mkdirSync(m.opts.home, { recursive: true });
  fs.writeFileSync(path.join(m.opts.home, 'config.json'), JSON.stringify({ claudeDir: other }));
  await HO.main([], m.opts);
  assert.equal(HO.readHandoff(m.opts.home).claudeDir, other);
  assert.match(m.out.join('\n'), /No running Claude Code session/);
});
