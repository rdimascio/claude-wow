'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SS = require('../bridge/sessions');

const A = '6624f327-7126-423e-a653-d7cf7a4e492b';
const B = 'f02436b8-8a5f-4c05-823e-bef25f88ff7b';
const C1 = 'abcd1111-0000-4000-8000-000000000001';
const C2 = 'abcd2222-0000-4000-8000-000000000002';

function fakeClaudeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wow-sessions-'));
  const put = (cwd, id, lines) => {
    const p = path.join(dir, 'projects', SS.projectSlug(cwd));
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  };
  put('/Users/me/wow-ai', A, [
    { type: 'user', cwd: '/Users/me/wow-ai', sessionId: A, message: { role: 'user', content: 'hi' } },
    { type: 'ai-title', aiTitle: 'Claude version check', sessionId: A },
  ]);
  put('/Users/me/proj', B, [
    { type: 'user', cwd: '/Users/me/proj', sessionId: B },
    { type: 'ai-title', aiTitle: 'Old title', sessionId: B },
    { type: 'custom-title', customTitle: 'Fix the build', sessionId: B },
  ]);
  put('/srv/one', C1, [{ type: 'user', cwd: '/srv/one', sessionId: C1 }]);
  put('/srv/two', C2, [{ type: 'user', cwd: '/srv/two', sessionId: C2 }]);
  const history = [
    { display: 'check the version', timestamp: 1000, project: '/Users/me/wow-ai', sessionId: A },
    { display: 'fix the build please', timestamp: 3000, project: '/Users/me/proj', sessionId: B },
    { display: '/clear', timestamp: 3500, project: '/Users/me/proj', sessionId: B },
    { display: 'first', timestamp: 2000, project: '/srv/one', sessionId: C1 },
    { display: 'no id here', timestamp: 4000, project: '/x', sessionId: 'not-a-session' },
  ];
  fs.writeFileSync(path.join(dir, 'history.jsonl'), history.map(l => JSON.stringify(l)).join('\n') + '\n{broken\n');
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.writeFileSync(path.join(dir, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: A, cwd: '/Users/me/wow-ai', name: 'wow-ai-90' }));
  return dir;
}

test('claudeDir: config.json wins, then CLAUDE_CONFIG_DIR, then ~/.claude', () => {
  assert.equal(SS.claudeDir({ CLAUDE_CONFIG_DIR: '/tmp/cc' }, '/opt/claude'), path.resolve('/opt/claude'));
  assert.equal(SS.claudeDir({ CLAUDE_CONFIG_DIR: '/tmp/cc' }), path.resolve('/tmp/cc'));
  assert.equal(SS.claudeDir({}), path.join(os.homedir(), '.claude'));
});

test('recent Claude Code sessions come from the prompt history, newest first, named by their title', () => {
  const dir = fakeClaudeDir();
  try {
    const list = SS.recentClaudeSessions(dir, { limit: 10 });
    assert.deepEqual(
      list.map(s => s.id),
      [B, C1, A],
    );
    assert.deepEqual(list[0], { id: B, name: 'Fix the build', cwd: '/Users/me/proj', agent: 'claude', at: 3 });
    assert.equal(list[1].name, 'first', 'no title: the first prompt');
    assert.equal(list[2].name, 'Claude version check');
    assert.deepEqual(
      SS.recentClaudeSessions(dir, { limit: 1 }).map(s => s.id),
      [B],
    );
    assert.deepEqual(SS.recentClaudeSessions(path.join(dir, 'missing')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an id or a prefix is found in the project folders with its folder; a running session is read from its pid file', () => {
  const dir = fakeClaudeDir();
  try {
    assert.deepEqual(
      SS.findClaudeSessions(dir, 'f024').map(s => [s.id, s.cwd, s.name]),
      [[B, '/Users/me/proj', 'Fix the build']],
    );
    assert.equal(SS.findClaudeSessions(dir, 'abcd').length, 2);
    assert.deepEqual(SS.findClaudeSessions(dir, 'ffff'), []);
    assert.deepEqual(SS.runningClaude(dir, 4242), { id: A, name: 'wow-ai-90', cwd: '/Users/me/wow-ai' });
    assert.equal(SS.runningClaude(dir, 1), null);
    assert.equal(SS.runningClaude(dir, 'x'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the bridge's own chat sessions, and one list: running first, then by age, each id once", () => {
  const state = {
    sessions: { 'chat:c1': B, 'chat:c2': 'thread-9', 'abc:default': 'old' },
    sessionCwd: { 'chat:c1': '/Users/me/proj' },
    sessionAgent: { 'chat:c2': 'codex' },
    sessionPluginById: { [B]: 'claude-code', 'thread-9': 'ask' },
  };
  const transcripts = { chats: { c1: { name: 'Build fixes', updated: 5000000 }, c2: { name: 'Quests', updated: 9000000 } } };
  const own = SS.ownSessions(state, transcripts);
  assert.deepEqual(own, [
    { id: B, chat: 'c1', name: 'Build fixes', cwd: '/Users/me/proj', agent: 'claude', plugin: 'claude-code', at: 5000 },
    { id: 'thread-9', chat: 'c2', name: 'Quests', cwd: '', agent: 'codex', plugin: 'ask', at: 9000 },
  ]);
  const live = [{ id: A, name: 'wow-ai', cwd: '/Users/me/wow-ai', agent: 'claude', at: 1 }];
  const claude = [
    { id: B, name: 'Fix the build', cwd: '/Users/me/proj', agent: 'claude', at: 99999 },
    { id: A, name: 'dup of live', at: 50000 },
    { id: C1, name: 'first', at: 2 },
  ];
  const merged = SS.mergeSessions({ live, own, claude, limit: 12 });
  assert.deepEqual(
    merged.map(s => [s.id, !!s.live, s.chat || '']),
    [
      [A, true, ''],
      ['thread-9', false, 'c2'],
      [B, false, 'c1'],
      [C1, false, ''],
    ],
  );
  assert.equal(SS.mergeSessions({ live, own, claude, limit: 2 }).length, 2);
});

test('a reference resolves by exact id, exact name, id prefix, then name prefix; an ambiguous one lists the matches', () => {
  const list = [
    { id: A, name: 'wow-ai' },
    { id: C1, name: 'First abcd', cwd: '/srv/one' },
    { id: C2, name: 'Second abcd', cwd: '/srv/two' },
  ];
  assert.deepEqual(
    SS.matchRef(list, A).map(s => s.id),
    [A],
  );
  assert.deepEqual(
    SS.matchRef(list, 'WOW-AI').map(s => s.id),
    [A],
  );
  assert.deepEqual(
    SS.matchRef(list, '6624').map(s => s.id),
    [A],
  );
  assert.deepEqual(
    SS.matchRef(list, '662').map(s => s.id),
    [],
    'an id prefix needs four characters',
  );
  assert.deepEqual(
    SS.matchRef(list, 'second').map(s => s.id),
    [C2],
  );
  assert.equal(SS.matchRef(list, 'abcd').length, 2);
  assert.deepEqual(SS.resolveResume('6624', { own: list }).session.id, A);
  const amb = SS.resolveResume('abcd', { own: list });
  assert.match(amb.error, /^"abcd" matches 2 sessions:\nabcd1111  First abcd  \/srv\/one\nabcd2222  Second abcd  \/srv\/two\nUse more of the id\.$/);
  assert.match(SS.resolveResume('zzzz', { own: list }).error, /No session matches "zzzz"\. \/claude -r lists the recent ones\./);
  let asked = '';
  const found = SS.resolveResume('f024', {
    own: list,
    find: ref => {
      asked = ref;
      return [{ id: B, name: 'Fix the build', cwd: '/Users/me/proj', agent: 'claude' }];
    },
  });
  assert.equal(asked, 'f024', "the Claude Code store is searched only when the bridge's own sessions have no match");
  assert.equal(found.session.cwd, '/Users/me/proj');
});

test('a session without a title is named by its first prompt, from the history or the transcript, never a command or a channel event', () => {
  const dir = fakeClaudeDir();
  try {
    const hist = path.join(dir, 'history.jsonl');
    fs.appendFileSync(hist, JSON.stringify({ display: 'a later prompt', timestamp: 2500, project: '/srv/one', sessionId: C1 }) + '\n');
    assert.equal(SS.recentClaudeSessions(dir).find(s => s.id === C1).name, 'first', 'the first prompt, not the latest');
    const p = path.join(dir, 'projects', SS.projectSlug('/srv/three'));
    fs.mkdirSync(p, { recursive: true });
    const id = 'abcd3333-0000-4000-8000-000000000003';
    fs.writeFileSync(
      path.join(p, `${id}.jsonl`),
      [
        { type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } },
        { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
        { type: 'user', message: { role: 'user', content: '<channel source="claude-wow" chat_id="x">hey</channel>' } },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '  Fix the   live session picker so the player can click a row and attach it without copying ids  ' }],
          },
        },
      ]
        .map(l => JSON.stringify(l))
        .join('\n') + '\n',
    );
    assert.equal(SS.firstPrompt(path.join(p, `${id}.jsonl`)), 'Fix the live session picker so the player can click a row...');
    assert.equal(SS.sessionLabel(dir, id, '/srv/three'), 'Fix the live session picker so the player can click a row...');
    assert.equal(SS.sessionLabel(dir, B, '/Users/me/proj'), 'Fix the build', 'a title wins over the first prompt');
    assert.equal(SS.sessionLabel(dir, 'ffffffff-0000-4000-8000-000000000000', ''), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('git branch of a session folder: a checkout, a subfolder, a worktree, a detached head, no repository', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wow-git-'));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'bridge', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/fix/live-session-picker\n');
    const wt = path.join(root, 'wt');
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/feature\n');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`);
    const detached = path.join(root, 'detached');
    fs.mkdirSync(path.join(detached, '.git'), { recursive: true });
    fs.writeFileSync(path.join(detached, '.git', 'HEAD'), 'b99347b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7\n');
    const none = path.join(root, 'none');
    fs.mkdirSync(none);
    assert.equal(SS.gitBranch(repo), 'fix/live-session-picker');
    assert.equal(SS.gitBranch(path.join(repo, 'bridge', 'plugins')), 'fix/live-session-picker');
    assert.equal(SS.gitBranch(wt), 'feature');
    assert.equal(SS.gitBranch(detached), 'b99347b');
    assert.equal(SS.gitBranch(none), '');
    assert.equal(SS.gitBranch(''), '');
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    assert.equal(SS.gitBranch(repo), 'fix/live-session-picker', 'cached for a while');
    assert.equal(SS.gitBranch(repo, Date.now() + 60000), 'main');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('merged list: listening sessions first, then running ones that cannot hear the game, each session once', () => {
  const live = [
    { id: B, name: 'wow-ai', cwd: '/w', at: 5, listening: false },
    { id: A, name: 'wow-ai', cwd: '/w', at: 1, listening: true },
    { id: B, name: 'wow-ai', cwd: '/w', at: 4, listening: false },
  ];
  const merged = SS.mergeSessions({
    live,
    own: [],
    claude: [
      { id: A, name: 'dup', at: 9 },
      { id: C1, name: 'old', at: 3 },
    ],
  });
  assert.deepEqual(
    merged.map(s => [s.id, s.live, !!s.running]),
    [
      [A, true, true],
      [B, false, true],
      [C1, undefined, false],
    ],
  );
});

test('the plugin that made a session is recorded by session id, so a slot that gets a new session keeps the old record', () => {
  const state = { sessions: {} };
  SS.noteSessionPlugin(state, 'first', 'ask');
  state.sessions[':default'] = 'first';
  SS.noteSessionPlugin(state, 'second', 'claude-code');
  state.sessions[':default'] = 'second';
  assert.equal(SS.sessionPluginOf(state, 'first'), 'ask', 'the slot moved on, the record did not');
  assert.equal(SS.sessionPluginOf(state, 'second'), 'claude-code');
  assert.equal(SS.sessionPluginOf(state, 'terminal'), '', 'a session the bridge never ran has no record');
  assert.equal(SS.madeByPlugin(state, 'terminal'), 'claude-code', 'and belongs to the coding plugin');
  assert.equal(SS.madeByPlugin(state, 'first'), 'ask');
  assert.equal(SS.sessionPluginOf(state, 'toString'), '', 'an inherited name is no record');
  assert.equal(SS.sessionPluginOf({}, 'first'), '');
  assert.equal(SS.sessionPluginOf({ sessionPluginById: { bad: 5 } }, 'bad'), '', 'a damaged record is no record');
  SS.noteSessionPlugin(state, '', 'ask');
  SS.noteSessionPlugin(state, 'x', '');
  assert.deepEqual(Object.keys(state.sessionPluginById), ['first', 'second'], 'no empty id or plugin is kept');
});

test('the per-id record keeps the newest sessions, a rewrite counts as new', () => {
  const state = {};
  for (const id of ['a', 'b', 'c']) SS.noteSessionPlugin(state, id, 'ask', 3);
  SS.noteSessionPlugin(state, 'a', 'roast', 3);
  SS.noteSessionPlugin(state, 'd', 'ask', 3);
  assert.deepEqual(state.sessionPluginById, { c: 'ask', a: 'roast', d: 'ask' });
});

test('the per-id record never evicts a session a slot still holds, so an idle ask chat keeps its plugin', () => {
  const state = { sessions: { 'chat:idle': 'live-ask' } };
  SS.noteSessionPlugin(state, 'live-ask', 'ask', 2);
  for (const id of ['b', 'c', 'd']) SS.noteSessionPlugin(state, id, 'claude-code', 2);
  assert.equal(SS.madeByPlugin(state, 'live-ask'), 'ask');
  assert.deepEqual(Object.keys(state.sessionPluginById), ['live-ask', 'd'], 'the oldest unused ids go instead');
});

test('slot records from an older bridge seed the per-id record once, and never overwrite it', () => {
  const state = {
    sessions: { ':default': 'inject-id', 'chat:a': 'chat-id', 'chat:b': 'legacy-id', 'chat:c': 'known-id' },
    sessionPlugin: { ':default': 'ask', 'chat:a': 'claude-code', 'chat:c': 'claude-code' },
    sessionPluginById: { 'known-id': 'ask' },
  };
  assert.equal(SS.adoptSlotPlugins(state), true);
  assert.deepEqual(state.sessionPluginById, { 'known-id': 'ask', 'inject-id': 'ask', 'chat-id': 'claude-code' });
  assert.equal(SS.adoptSlotPlugins(null), false);
});

test('the slot record migration runs once across restarts, so evicted ids never come back as newest', () => {
  const state = { sessions: { 'chat:a': 'old-id' }, sessionPlugin: { 'chat:a': 'ask' } };
  assert.equal(SS.adoptSlotPlugins(state), true);
  const restarted = JSON.parse(JSON.stringify(state));
  delete restarted.sessions['chat:a'];
  for (const id of ['n1', 'n2']) SS.noteSessionPlugin(restarted, id, 'claude-code', 2);
  assert.deepEqual(Object.keys(restarted.sessionPluginById), ['n1', 'n2']);
  restarted.sessions['chat:a'] = 'old-id';
  const again = JSON.parse(JSON.stringify(restarted));
  assert.equal(SS.adoptSlotPlugins(again), false);
  assert.deepEqual(again.sessionPluginById, { n1: 'claude-code', n2: 'claude-code' });
});
