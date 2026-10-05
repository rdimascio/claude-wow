'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DEV = require('../bridge/plugins/dev');
const FB = require('../bridge/feedback');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-dev-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeCore(t, over = {}) {
  const home = tmpDir(t);
  const calls = { replies: [], fails: [], progress: [], beats: 0, notes: [], logs: [], claimed: 0, children: [] };
  const core = {
    log: line => calls.logs.push(line),
    tag: job => `#${job.id}`,
    options: () => over.options || {},
    reply: (job, text) => calls.replies.push(text),
    fail: (job, text) => calls.fails.push(text),
    progress: (job, text) => calls.progress.push(text),
    beat: () => {
      calls.beats++;
    },
    accept: () => {},
    resolveCwd: () => over.cwd || home,
    clientOf: () => over.client || null,
    feedback: FB.createStore(home, { now: () => Date.parse('2026-10-05T08:00:00Z') }),
    lastRun: () => over.lastRun || null,
    lastTurn: (job, replyId) => (over.lastTurn ? over.lastTurn(replyId) : null),
    setDevNote: (job, text) => calls.notes.push(text),
    claimRun: () => {
      calls.claimed++;
      return true;
    },
    runChild: (job, child) => calls.children.push(child),
    get logFile() {
      return over.logFile || path.join(home, 'bridge.log');
    },
  };
  return { core, calls, home };
}

function scriptedRun(table) {
  const seen = [];
  const run = async (file, args, opts) => {
    seen.push({ file, args, opts });
    const key = [file, ...args].join(' ');
    for (const [prefix, answer] of table) if (key.startsWith(prefix)) return { code: 0, out: '', err: '', timedOut: false, ...answer };
    return { code: 1, out: '', err: `unscripted: ${key}`, timedOut: false };
  };
  run.seen = seen;
  return run;
}

const job = (text, extra = {}) => ({ id: 7, chat: 'c1', text, cwd: '', ...extra });

test('parseArgs takes the first word as the command and defaults to help', () => {
  assert.deepEqual(DEV.parseArgs(''), { command: 'help', args: [], rest: '' });
  assert.deepEqual(DEV.parseArgs('  LOG 50 error  '), { command: 'log', args: ['50', 'error'], rest: '50 error' });
});

test('splitAddonErrors cuts the addon block off the command text', () => {
  assert.deepEqual(DEV.splitAddonErrors('the map is blank\n--- addon errors ---\nx2 ClaudeWoW.lua:9: boom'), {
    rest: 'the map is blank',
    addon: 'x2 ClaudeWoW.lua:9: boom',
  });
  assert.deepEqual(DEV.splitAddonErrors('plain'), { rest: 'plain', addon: '' });
});

test('branchLine reads git status --branch headers', () => {
  assert.equal(DEV.branchLine('## main...origin/main [ahead 2, behind 1]'), 'branch main, tracking origin/main, ahead 2, behind 1');
  assert.equal(DEV.branchLine('## feat/x'), 'branch feat/x, no upstream');
  assert.equal(DEV.branchLine('## No commits yet on main'), 'branch main (no commits yet)');
  assert.equal(DEV.branchLine('garbage'), '');
});

test('checksLine counts passed, failed and pending checks and names the failures', () => {
  assert.equal(DEV.checksLine([]), 'no checks');
  assert.equal(
    DEV.checksLine([
      { name: 'test', conclusion: 'SUCCESS' },
      { name: 'e2e', conclusion: 'FAILURE' },
      { name: 'lint', status: 'IN_PROGRESS' },
    ]),
    '1 failed, 1 pending, 1 passed (e2e)',
  );
});

test('testCommand prefers plugins.dev.testCommand, else the package test script, else nothing', t => {
  const dir = tmpDir(t);
  assert.equal(DEV.testCommand(dir, {}, []), null);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.deepEqual(DEV.testCommand(dir, {}, ['tests/a_test.js']), {
    file: 'npm',
    args: ['test', '--', 'tests/a_test.js'],
    label: 'npm test -- tests/a_test.js',
  });
  assert.deepEqual(DEV.testCommand(dir, { testCommand: ['node', '--test'] }, ['x']), { file: 'node', args: ['--test', 'x'], label: 'node --test x' });
  assert.equal(DEV.testCommand(dir, { testCommand: 'make check' }, ['a']).shell, 'make check');
});

test('platformCommand passes player args to a shell command as positional parameters, never inside the script', () => {
  const p = DEV.platformCommand({ shell: 'make check', extra: ['a;rm -rf /'] }, 'darwin');
  assert.deepEqual(p, { file: '/bin/sh', args: ['-c', 'make check "$@"', 'sh', 'a;rm -rf /'] });
  assert.deepEqual(DEV.platformCommand({ file: 'npm', args: ['test'] }, 'win32'), { file: 'cmd.exe', args: ['/d', '/s', '/c', 'npm test'] });
  assert.deepEqual(DEV.platformCommand({ file: 'node', args: ['--test'] }, 'win32'), { file: 'node', args: ['--test'] });
});

test('test refuses arguments with shell characters', async t => {
  const { core, calls, home } = fakeCore(t);
  fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  const run = scriptedRun([]);
  for (const bad of ['a;b', 'a|b', '$(x)', 'a&b', '%PATH%', '`x`', 'a>b']) {
    await DEV.handleDev(job(`test ${bad}`), core, { run });
    assert.match(calls.replies.pop(), /characters the test command does not take/, bad);
  }
  assert.equal(run.seen.length, 0);
});

test('testSummary pulls the node --test totals and the failing tests', () => {
  const s = DEV.testSummary('ok 1 - a\nnot ok 2 - b fails\n# tests 2\n# pass 1\n# fail 1\n# duration_ms 12\n');
  assert.deepEqual(s.totals, ['tests 2', 'pass 1', 'fail 1', 'duration_ms 12']);
  assert.deepEqual(s.failing, ['not ok 2 - b fails']);
});

test('luaErrors finds [E][Lua] entries in General.log with their stack lines', () => {
  const log = [
    '10/1 21:00:00.000  [N][Lua] LimitedLuaResources: Reset Timer',
    '10/1 21:00:01.000  [E][Lua] Lua Error: Interface/AddOns/ClaudeWoW/ClaudeWoW.lua:12: boom',
    '[string "@Interface/AddOns/ClaudeWoW/ClaudeWoW.lua"]:12: in function <x>',
    '10/1 21:00:02.000  [N][Console] next',
  ].join('\n');
  const found = DEV.luaErrors(log);
  assert.equal(found.length, 1);
  assert.match(found[0], /boom\n.*in function/);
});

test('capText cuts long replies on a line break and says how much it cut', () => {
  const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
  const cut = DEV.capText(long, 1000);
  assert.ok(cut.length <= 1000);
  assert.match(cut, /more characters cut\)$/);
});

test('status reports the branch, changed files, commits and the PR checks', async t => {
  const { core, calls } = fakeCore(t);
  const run = scriptedRun([
    ['git rev-parse', { out: '/repo/claude-wow\n' }],
    ['git status', { out: '## feat/x...origin/feat/x [ahead 1]\n M bridge/bridge.js\n?? new.js\n' }],
    ['git log', { out: 'abc123 fix it (2 hours ago)\n' }],
    [
      'gh pr view',
      {
        out: JSON.stringify({
          number: 12,
          title: 'fix it',
          url: 'https://github.com/o/r/pull/12',
          state: 'OPEN',
          isDraft: true,
          statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }],
        }),
      },
    ],
  ]);
  await DEV.handleDev(job('status'), core, { run });
  const text = calls.replies[0];
  assert.match(text, /^claude-wow: branch feat\/x, tracking origin\/feat\/x, ahead 1/);
  assert.match(text, /2 changed files/);
  assert.match(text, /abc123 fix it/);
  assert.match(text, /PR #12 draft: fix it\nhttps:\/\/github.com\/o\/r\/pull\/12\nchecks: 1 failed \(test\)/);
  assert.match(calls.notes[0], /^\[Output of "\/claude dev status"/);
});

test('status outside a repository and without git says so', async t => {
  const { core, calls } = fakeCore(t);
  await DEV.handleDev(job('status'), core, { run: scriptedRun([['git rev-parse', { code: 128 }]]) });
  assert.match(calls.replies.pop(), /is not in a git repository/);
  await DEV.handleDev(job('status'), core, { run: scriptedRun([['git rev-parse', { code: -1, missing: true }]]) });
  assert.match(calls.replies.pop(), /git is not installed/);
});

test('status with no PR, no gh, or a gh failure', async t => {
  const { core, calls } = fakeCore(t);
  const base = [
    ['git rev-parse', { out: '/r\n' }],
    ['git status', { out: '## main\n' }],
    ['git log', { out: '' }],
  ];
  await DEV.handleDev(job('status'), core, { run: scriptedRun([...base, ['gh', { code: 1, err: 'no pull requests found for branch "main"' }]]) });
  assert.match(calls.replies.pop(), /PR: none for this branch/);
  await DEV.handleDev(job('status'), core, { run: scriptedRun([...base, ['gh', { code: -1, missing: true }]]) });
  assert.match(calls.replies.pop(), /gh is not installed/);
  await DEV.handleDev(job('status'), core, { run: scriptedRun([...base, ['gh', { code: 1, err: 'HTTP 401' }]]) });
  assert.match(calls.replies.pop(), /PR: HTTP 401/);
});

test('diff shows the stat, untracked files and the diff, and cuts a long one', async t => {
  const { core, calls } = fakeCore(t);
  const big = 'diff --git a/x b/x\n' + Array.from({ length: 2000 }, (_, i) => `+line ${i}`).join('\n');
  await DEV.handleDev(job('diff'), core, {
    run: scriptedRun([
      ['git rev-parse', { out: '/r\n' }],
      ['git diff HEAD --stat', { out: ' x | 2000 +\n' }],
      ['git diff HEAD', { out: big }],
      ['git ls-files', { out: 'new.js\n' }],
    ]),
  });
  const text = calls.replies.pop();
  assert.ok(text.length <= 6000);
  assert.match(text, /untracked: new.js/);
  assert.match(text, /```diff\n/);
  assert.match(text, /The diff is cut/);
});

test('diff with a path scopes every git call and reports no changes', async t => {
  const { core, calls } = fakeCore(t);
  const run = scriptedRun([
    ['git rev-parse', { out: '/r\n' }],
    ['git diff', { out: '' }],
    ['git ls-files', { out: '' }],
  ]);
  await DEV.handleDev(job('diff bridge/x.js'), core, { run });
  assert.equal(calls.replies.pop(), 'No uncommitted changes in bridge/x.js.');
  for (const s of run.seen.filter(s => s.args[0] !== 'rev-parse')) assert.deepEqual(s.args.slice(-2), ['--', 'bridge/x.js']);
});

test('log shows the end of bridge.log, filtered and capped', async t => {
  const { core, calls, home } = fakeCore(t);
  const file = path.join(home, 'bridge.log');
  fs.writeFileSync(file, Array.from({ length: 300 }, (_, i) => `[t] #${i} ${i % 2 ? 'error' : 'done'}`).join('\n') + '\n');
  await DEV.handleDev(job('log 5 ERROR'), core, {});
  const text = calls.replies.pop();
  assert.match(text, /last 5 lines with "error"/);
  assert.match(text, /#299 error/);
  assert.doesNotMatch(text, /done/);
  await DEV.handleDev(job('log 999'), core, {});
  assert.match(calls.replies.pop(), /last 200 lines/);
  await DEV.handleDev(job('log nothing-like-this'), core, {});
  assert.match(calls.replies.pop(), /No line with "nothing-like-this"/);
});

test('run shows the last run trace and the resume command', async t => {
  const now = Date.parse('2026-10-05T08:00:00Z');
  const { core, calls } = fakeCore(t, {
    lastRun: {
      at: now - 60000,
      ms: 42000,
      status: 'error',
      code: 1,
      agent: 'claude',
      model: 'opus',
      cwd: '/r',
      session: 's-1',
      resumed: true,
      steps: 30,
      tools: ['Read a.js', 'Bash npm test'],
      denied: ['Bash(rm:*)'],
      stderr: 'boom',
      turns: 3,
      ctx: 12000,
      cost: 0.5,
    },
  });
  await DEV.handleDev(job('run'), core, { now: () => now });
  const text = calls.replies.pop();
  assert.match(text, /claude opus in \/r/);
  assert.match(text, /error, exit 1, 42 s long, ended 60 s ago/);
  assert.match(text, /session s-1 \(resumed\)/);
  assert.match(text, /~\$0.50 API so far/);
  assert.match(text, /denied: Bash\(rm:\*\)/);
  assert.match(text, /last steps \(30 in all\)/);
  assert.match(text, /cd "\/r" && claude --resume s-1/);
  const { core: empty, calls: c2 } = fakeCore(t);
  await DEV.handleDev(job('run'), empty, {});
  assert.match(c2.replies.pop(), /No agent run in this chat/);
});

test('test runs the command in the chat folder, beats while it runs, and summarises a failure', async t => {
  const { core, calls, home } = fakeCore(t);
  fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const run = async (file, args, opts) => {
    opts.onTick();
    return { code: 1, out: 'not ok 3 - bridge works\n# tests 3\n# pass 2\n# fail 1\n', err: '', timedOut: false };
  };
  await DEV.handleDev(job('test'), core, { run });
  const text = calls.replies.pop();
  assert.match(text, /npm test: failed \(exit 1\)/);
  assert.match(text, /tests 3, pass 2, fail 1/);
  assert.match(text, /not ok 3 - bridge works/);
  assert.equal(calls.beats, 1);
  assert.ok(calls.progress.length >= 2);
});

test('test with no test command says how to set one', async t => {
  const { core, calls } = fakeCore(t);
  await DEV.handleDev(job('test'), core, { run: scriptedRun([]) });
  assert.match(calls.replies.pop(), /plugins.dev.testCommand/);
});

test('errors reads General.log and the addon block', async t => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'Logs'));
  fs.writeFileSync(path.join(dir, 'Logs', 'General.log'), '10/1 21:00:01.000  [E][Lua] Lua Error: Interface/AddOns/ClaudeWoW/Map.lua:3: nil\n');
  const { core, calls } = fakeCore(t, { client: { dir } });
  await DEV.handleDev(job('errors\n--- addon errors ---\nx2 ClaudeWoW/Window.lua:5: oops'), core, {});
  const text = calls.replies.pop();
  assert.match(text, /1 Lua error in General.log/);
  assert.match(text, /Map.lua:3: nil/);
  assert.match(text, /From the addon, this UI session:\n```\nx2 ClaudeWoW\/Window.lua:5: oops/);
});

test('wrong stores the last reply with its prompt and note; bug stores the addon state', async t => {
  const turn = { id: 5, plugin: 'claude-code', agent: 'claude', session: 's-9', prompt: 'why is the map blank', reply: 'Because of X.' };
  const { core, calls } = fakeCore(t, { lastTurn: () => turn });
  await DEV.handleDev(job('wrong it is Y, not X', { name: 'Map bug' }), core, {});
  assert.match(calls.replies.pop(), /Marked as wrong: #1\. It is in/);
  await DEV.handleDev(job('bug the toast never hides\n--- addon errors ---\naddon 0.5.0'), core, {});
  assert.match(calls.replies.pop(), /Bug #2 saved/);
  const items = core.feedback.list();
  assert.equal(items.length, 2);
  assert.deepEqual(
    { kind: items[0].kind, note: items[0].note, reply: items[0].reply, prompt: items[0].prompt, session: items[0].session, chatName: items[0].chatName },
    { kind: 'wrong', note: 'it is Y, not X', reply: 'Because of X.', prompt: 'why is the map blank', session: 's-9', chatName: 'Map bug' },
  );
  assert.equal(items[1].addon, 'addon 0.5.0');
  assert.equal(calls.notes.length, 0);
});

test('wrong takes a reply id only with #, so a note may start with a number', async t => {
  const asked = [];
  const { core, calls } = fakeCore(t, {
    lastTurn: id => {
      asked.push(id);
      return id === null ? { id: 9, prompt: 'p', reply: 'r' } : null;
    },
  });
  await DEV.handleDev(job('wrong #3 bad answer'), core, {});
  assert.equal(calls.replies.pop(), 'There is no reply in this chat to mark.');
  await DEV.handleDev(job('wrong 2 quests are missing'), core, {});
  assert.deepEqual(asked, [3, null]);
  assert.equal(core.feedback.list()[0].note, '2 quests are missing');
});

test('a dev job claims the chat, hands each child to the core, and a cancel ends it with no note', async t => {
  const { core, calls } = fakeCore(t);
  const j = job('status');
  const fakeChild = { pid: 1 };
  const run = async (file, args, opts) => {
    opts.onSpawn(fakeChild);
    j.cancelled = true;
    return { code: 0, out: '/r\n', err: '', timedOut: false };
  };
  await DEV.handleDev(j, core, { run: (f, a, o) => run(f, a, o) });
  assert.equal(calls.claimed, 1);
  assert.deepEqual(calls.children, [fakeChild]);
  assert.deepEqual(calls.fails, ['Cancelled from the game.']);
  assert.deepEqual(calls.replies, []);
  assert.deepEqual(calls.notes, []);
});

test('the dev plugin is sessionless, so the bridge never adopts a session for it', () => {
  assert.equal(DEV.sessionless, true);
});

test('feedback lists open items, fix hands one to the agent, close closes it', async t => {
  const { core, calls } = fakeCore(t, { lastTurn: () => ({ id: 1, prompt: 'p', reply: 'r' }) });
  await DEV.handleDev(job('wrong first'), core, {});
  await DEV.handleDev(job('wrong second'), core, {});
  calls.replies.length = 0;
  await DEV.handleDev(job('feedback'), core, {});
  assert.match(calls.replies.pop(), /^2 open items:\n#1 wrong.*first\n#2 wrong.*second/);
  await DEV.handleDev(job('feedback fix 2'), core, {});
  assert.match(calls.replies.pop(), /#2 wrong[\s\S]*note: second[\s\S]*gets this report with your next message/);
  assert.match(calls.notes.pop(), /^\[Feedback item #2 /);
  await DEV.handleDev(job('feedback close 1 done in #120'), core, {});
  assert.equal(calls.replies.pop(), 'Closed #1.');
  assert.equal(core.feedback.get(1).closedWhy, 'done in #120');
  await DEV.handleDev(job('feedback'), core, {});
  assert.match(calls.replies.pop(), /^1 open item:/);
  await DEV.handleDev(job('feedback fix 99'), core, {});
  assert.match(calls.replies.pop(), /No feedback item 99/);
});

test('an unknown command answers with the help, a thrown error fails the message', async t => {
  const { core, calls } = fakeCore(t);
  await DEV.handleDev(job('frobnicate'), core, {});
  assert.match(calls.replies.pop(), /^Unknown dev command "frobnicate"\.\nDev tools/);
  await DEV.handleDev(job('status'), core, {
    run: async () => {
      throw new Error('kaput');
    },
  });
  assert.equal(calls.fails.pop(), 'dev status failed: kaput');
});

test('the feedback store keeps at most ITEMS_MAX items and skips broken lines', t => {
  const dir = tmpDir(t);
  const store = FB.createStore(dir);
  fs.writeFileSync(store.file, 'not json\n{"n":"x"}\n');
  for (let i = 0; i < FB.ITEMS_MAX + 3; i++) store.add({ kind: 'wrong', note: `n${i}` });
  const items = store.list();
  assert.equal(items.length, FB.ITEMS_MAX);
  assert.equal(items[items.length - 1].n, FB.ITEMS_MAX + 3);
  assert.equal(store.add({ kind: 'other', note: 'x'.repeat(5000) }).note.length, 1000);
  assert.equal(store.list().pop().kind, 'wrong');
});

test('runCommand collects output, reports a missing program and stops a slow one', async () => {
  const ok = await DEV.runCommand(process.execPath, ['-e', 'process.stdout.write("hi"); process.stderr.write("err"); process.exit(3)']);
  assert.deepEqual({ code: ok.code, out: ok.out, err: ok.err, timedOut: ok.timedOut }, { code: 3, out: 'hi', err: 'err', timedOut: false });
  const missing = await DEV.runCommand('definitely-not-a-program-cw', []);
  assert.equal(missing.missing, true);
  const slow = await DEV.runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 200 });
  assert.equal(slow.timedOut, true);
});
