'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const luaparse = require('luaparse');
const ACH = require('../bridge/achievements');
const P = require('../bridge/protocol');

const FRIDAY_NOON = new Date(2026, 8, 25, 12, 0, 0).getTime();
const TUESDAY_NOON = new Date(2026, 8, 29, 12, 0, 0).getTime();

const ran = (command, output = '', failed = false) => ({ command, output, failed });

test('test runners are recognised through prefixes, env vars and shell wrappers', () => {
  for (const cmd of [
    'npm test',
    'npm run test:unit',
    'yarn test --watch=false',
    'pnpm t',
    'bun test',
    'npx jest src',
    'npx vitest run',
    'pytest -q',
    'python -m pytest tests',
    'go test ./...',
    'cargo test',
    'node --test tests/a_test.js',
    'CI=1 npm test',
    'cd app && npm test',
    "bash -lc 'npm test'",
    './gradlew test',
    'bundle exec rspec',
    'make test',
    'deno test',
  ]) {
    assert.ok(ACH.isTestCommand(cmd), cmd);
  }
  for (const cmd of ['npm install', 'npm run build', 'git commit -m "npm test"', 'echo test', 'ls tests', 'node build.js']) {
    assert.equal(ACH.isTestCommand(cmd), false, cmd);
  }
});

test('a test verdict comes from the exit status first, then from the runner output', () => {
  assert.equal(ACH.testVerdict(ran('npm test', 'ok', false)), 'pass');
  assert.equal(ACH.testVerdict(ran('npm test', 'Exit code 1\nboom', true)), 'fail');
  assert.equal(ACH.testVerdict(ran('npm test', 'Exit code 1')), 'fail');
  assert.equal(ACH.testVerdict(ran('npx jest', 'Tests:       2 failed, 10 passed')), 'fail');
  assert.equal(ACH.testVerdict(ran('pytest', '===== 1 failed, 3 passed in 0.2s =====')), 'fail');
  assert.equal(ACH.testVerdict(ran('cargo test', 'test result: FAILED. 1 passed; 1 failed')), 'fail');
  assert.equal(ACH.testVerdict(ran('node --test', '# pass 12\n# fail 0')), 'pass');
  assert.equal(ACH.testVerdict(ran('node --test', '# pass 11\n# fail 1')), 'fail');
  assert.equal(ACH.testVerdict(ran('go test ./...', '--- FAIL: TestX (0.00s)')), 'fail');
  assert.equal(ACH.testVerdict(ran('npm test', 'Tests:       0 failed, 12 passed')), 'pass');
  assert.equal(ACH.testVerdict(ran('npm run build', 'FAIL')), '');
});

test('commits count only when git made one', () => {
  assert.equal(ACH.countCommits(ran('git commit -m "feat: x"', '[main 1a2b3c4] feat: x\n 1 file changed')), 1);
  assert.equal(ACH.countCommits(ran('git -C /repo commit -am fix', '')), 1);
  assert.equal(ACH.countCommits(ran('git add -A && git commit -m x && git push', 'Exit code 1\n[main abcdef1] x\nerror: failed to push', true)), 1);
  assert.equal(ACH.countCommits(ran('git commit -m x', 'nothing to commit, working tree clean', true)), 0);
  assert.equal(ACH.countCommits(ran('git commit --dry-run', '')), 0);
  assert.equal(ACH.countCommits(ran('git status', '')), 0);
  assert.equal(ACH.countCommits(ran('echo "git commit"', '')), 0);
});

test('pushes count only when git pushed something', () => {
  assert.equal(ACH.countPushes(ran('git push origin main', '   1a2b3c4..5d6e7f8  main -> main')), 1);
  assert.equal(ACH.countPushes(ran('git push -u origin feat', ' * [new branch]      feat -> feat')), 1);
  assert.equal(ACH.countPushes(ran('git push', 'Everything up-to-date')), 0);
  assert.equal(ACH.countPushes(ran('git push', 'Exit code 128\nfatal: no upstream', true)), 0);
  assert.equal(ACH.countPushes(ran('git push --dry-run', '')), 0);
  assert.equal(ACH.countPushes(ran('gh pr create', '')), 0);
});

test('--force is spotted in any command, and -f on a git push', () => {
  assert.ok(ACH.usesForce('git push --force origin main'));
  assert.ok(ACH.usesForce('git push --force-with-lease=main:abc origin main'));
  assert.ok(ACH.usesForce('git push -f'));
  assert.ok(ACH.usesForce('git push -uf origin x'));
  assert.ok(ACH.usesForce('npm install --force'));
  assert.equal(ACH.usesForce('rm -f build.log'), false);
  assert.equal(ACH.usesForce('git push origin main'), false);
  assert.equal(ACH.usesForce('echo --forceful'), false);
});

test('Claude stream-json and Codex items become commands with their results', () => {
  const claude = ACH.createRunLog('claude');
  claude.feed({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a' } },
      ],
    },
  });
  claude.feed({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'Exit code 1\n1 failing' }] }] },
  });
  claude.feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'git push' } }] } });
  assert.deepEqual(
    claude.commands().map(c => [c.command, c.failed]),
    [['npm test', true]],
    'a call without its result yet is not counted',
  );
  claude.feed(null);
  claude.feed({ type: 'user', message: { content: 'plain text' } });

  const codex = ACH.createRunLog('codex');
  codex.feed({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: "bash -lc 'cargo test'" } });
  codex.feed({
    type: 'item.completed',
    item: { id: 'c1', type: 'command_execution', command: "bash -lc 'cargo test'", aggregated_output: 'test result: ok', exit_code: 0, status: 'completed' },
  });
  assert.deepEqual(
    codex.commands().map(c => [c.command, c.output, c.failed]),
    [["bash -lc 'cargo test'", 'test result: ok', false]],
  );
  assert.equal(ACH.testVerdict(codex.commands()[0]), 'pass');

  const hermes = ACH.createRunLog('hermes');
  hermes.feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }] } });
  assert.deepEqual(hermes.commands(), []);
});

function luaUnescape(s) {
  return s.replace(/\\(\d{1,3}|.)/g, (_, e) => (/^\d/.test(e) ? String.fromCharCode(Number(e)) : e === 'n' ? '\n' : e));
}

function value(node) {
  if (node.type === 'TableConstructorExpression') {
    const out = {};
    const arr = [];
    for (const f of node.fields) {
      if (f.type === 'TableKeyString') out[f.key.name] = value(f.value);
      else arr.push(value(f.value));
    }
    return arr.length ? arr : out;
  }
  if (node.type === 'StringLiteral') return luaUnescape(node.raw.slice(1, -1));
  if (node.type === 'NumericLiteral') return node.value;
  return null;
}

test('the slot file carries recent toasts and the earned list, and reads back as Lua', () => {
  const state = {};
  ACH.evaluate(state, { chat: 'k', status: 'done', now: FRIDAY_NOON, commands: [ran('git push --force', ' + a1b2c3d...e4f5a6b main -> main')] });
  const src = P.luaTable('ClaudeWoW_SlotData', [], { now: FRIDAY_NOON, achievementsLua: ACH.luaAchievements(state) });
  const ast = luaparse.parse(src, { luaVersion: '5.1' });
  const slot = value(ast.body.find(n => n.type === 'AssignmentStatement').init[0]);
  const a = slot.achievements;
  assert.equal(a.seq, state.achievements.seq);
  assert.equal(a.total, ACH.CATALOG.length);
  assert.equal(a.recent.length, a.seq);
  assert.deepEqual(
    a.recent.map(r => r.seq),
    a.recent.map((_, i) => i + 1),
  );
  const leeroy = a.earned.find(e => e.id === 'leeroy');
  assert.equal(leeroy.title, 'Leeroy Jenkins');
  assert.equal(leeroy.icon, 'Interface\\Icons\\Ability_Warrior_Charge');
  assert.equal(leeroy.count, 1);
  assert.equal(
    a.points,
    a.earned.reduce((sum, e) => sum + e.points, 0),
  );
  assert.equal(P.luaTable('X', [], {}).includes('achievements'), false, 'nothing when the bridge sends none');
});

test('the recent list keeps only the last few toasts', () => {
  const state = {};
  for (let i = 0; i < 12; i++)
    ACH.evaluate(state, { chat: 'k', status: 'done', now: TUESDAY_NOON, commands: [ran('npm test', 'Exit code 1', true), ran('npm test', 'ok')] });
  assert.ok(state.achievements.recent.length <= 8);
  assert.equal(state.achievements.recent[state.achievements.recent.length - 1].seq, state.achievements.seq);
});
