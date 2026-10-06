'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const AC = require('../bridge/agentcontract');
const MC = require('../bridge/mcpconfig');
const P = require('../bridge/protocol');
const R = require('../bridge/runtime');
const FIX = require('../dev/contract-mcp');

const scratch = name => fs.mkdtempSync(path.join(os.tmpdir(), `claude-wow-contract-${name}-`));
const CLAUDE_ROWS = { C1: 'pass', C2: 'pass', C2u: 'unchecked', C3: 'pass', C4: 'pass' };

function claudeInit(tools, servers = [{ name: AC.PROBE_SERVER, status: 'connected', source: 'dynamic' }]) {
  return { type: 'system', subtype: 'init', session_id: 's', tools: ['Bash', 'Read', ...tools], mcp_servers: servers };
}

test('parseVersion takes the first x.y.z of what a CLI prints for --version', () => {
  assert.equal(AC.parseVersion('2.1.290 (Claude Code)\n'), '2.1.290');
  assert.equal(AC.parseVersion('codex-cli 0.160.1'), '0.160.1');
  assert.equal(AC.parseVersion('v1.2.3-beta.1 build'), '1.2.3-beta.1');
  assert.equal(AC.parseVersion('{"type":"result","result":"pong"}'), '');
  assert.equal(AC.parseVersion(undefined), '');
});

test('binaryOf finds the file a run starts: a script after its node, a bare name on the PATH, nothing for a missing command', () => {
  const dir = scratch('which');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '');
  const env = { PATH: ['/nowhere', dir].join(path.delimiter) };
  assert.equal(AC.binaryOf({ file: 'claude', args: [], found: true }, { env, platform: 'linux' }), bin);
  assert.equal(AC.binaryOf({ file: process.execPath, args: [bin], found: true }, { env }), bin);
  assert.equal(AC.binaryOf({ file: 'claude', args: [], found: false }, { env }), '');
  assert.equal(AC.binaryOf({ file: 'gone', args: [], found: true }, { env }), '');
  assert.equal(AC.which('', { env }), '');
  assert.equal(AC.which(path.join(dir, 'nope'), { env }), '');
  fs.writeFileSync(path.join(dir, 'codex.cmd'), '');
  assert.equal(AC.which('codex', { env, platform: 'win32' }), path.join(dir, 'codex.cmd'));
  assert.equal(AC.which(path.relative(process.cwd(), bin), { env }), bin);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readVersion runs the command with --version, and kills one that hangs', async () => {
  const dir = scratch('version');
  const ok = path.join(dir, 'ok.js');
  fs.writeFileSync(ok, "if (process.argv.includes('--version')) console.log('2.1.290 (Claude Code)');");
  assert.equal(await AC.readVersion({ file: process.execPath, args: [ok] }), '2.1.290');
  const hang = path.join(dir, 'hang.js');
  fs.writeFileSync(hang, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  const kids = [];
  const t0 = Date.now();
  assert.equal(await AC.readVersion({ file: process.execPath, args: [hang] }, { timeoutMs: 300, onChild: c => kids.push(c) }), '');
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(kids.length, 1);
  assert.equal(await AC.readVersion({ file: path.join(dir, 'missing') }), '');
  assert.equal(
    await AC.readVersion(
      { file: 'x' },
      {
        spawn: () => {
          throw new Error('no');
        },
      },
    ),
    '',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

const ID = { mtimeMs: 1000, ctimeMs: 1001, ino: 77, size: 5000 };

function trackerWorld(contract, versionOf = () => Promise.resolve('2.1.290')) {
  const dir = scratch('tracker');
  const file = path.join(dir, AC.FILE_NAME);
  if (contract) fs.writeFileSync(file, JSON.stringify(contract));
  const stats = { '/real/claude': { ...ID } };
  const calls = [];
  const logs = [];
  const tracker = AC.createTracker({
    file,
    log: l => logs.push(l),
    realpath: p => (p === '/bin/claude' ? '/real/claude' : p),
    stat: p => {
      if (!(p in stats)) throw new Error('ENOENT');
      return stats[p];
    },
    version: cmd => {
      calls.push(cmd.file);
      return versionOf(calls.length);
    },
    which: { exists: p => p === '/bin/claude' },
  });
  return { dir, file, stats, calls, logs, tracker };
}

const cmdClaude = { file: '/bin/claude', args: [], found: true };
const entryFor = (rows, extra = {}) => ({ realpath: '/real/claude', ...ID, version: '2.1.290', rows, ...extra });

test('the tracker matches an entry on realpath, mtime, ctime, inode and size; an npm update that keeps the path and mtime is not checked', async () => {
  const w = trackerWorld({ claude: entryFor({ ...CLAUDE_ROWS, C2: 'fail' }) });
  const first = w.tracker.status('claude', cmdClaude);
  assert.equal(first.matched, true);
  assert.equal(first.checked, true);
  assert.equal(first.version, '2.1.290', 'the entry names the version while --version runs');
  assert.equal(first.rows.C2, 'fail');
  await new Promise(setImmediate);
  w.tracker.status('claude', cmdClaude);
  assert.deepEqual(w.calls, ['/bin/claude'], '--version runs once per binary identity');
  assert.deepEqual(w.logs, []);
  for (const [k, v] of [
    ['ctimeMs', 2002],
    ['ino', 78],
    ['size', 5001],
    ['mtimeMs', 999],
  ]) {
    w.stats['/real/claude'] = { ...ID, [k]: v };
    const replaced = w.tracker.status('claude', cmdClaude);
    assert.equal(replaced.matched, false, `${k} changed`);
    assert.deepEqual(replaced.rows, {});
    assert.equal(AC.refusal(replaced, { off: true }), '');
  }
  assert.equal(w.calls.length, 5, 'each replaced binary is asked for its version again');
  assert.equal(w.logs.length, 4);
  assert.match(w.logs[0], /^contract: Claude Code at \/real\/claude is not checked .*run claude-wow agents check\. Only a measured fail turns anything off\.$/);
  w.tracker.status('claude', cmdClaude);
  assert.equal(w.logs.length, 4, 'said once per binary');
  assert.deepEqual(w.tracker.children(), []);
  fs.rmSync(w.dir, { recursive: true, force: true });
});

test('the tracker recomputes when --version answers: another version, or no version at all, is not a match', async () => {
  const other = trackerWorld({ claude: entryFor({ ...CLAUDE_ROWS, C2: 'fail' }) }, () => Promise.resolve('2.1.291'));
  assert.equal(other.tracker.status('claude', cmdClaude).matched, true, 'pending: the full identity decides');
  await new Promise(setImmediate);
  const now = other.tracker.current().claude;
  assert.equal(now.matched, false);
  assert.equal(now.version, '2.1.291');
  assert.deepEqual(AC.slotField({ claude: now }).claude, { version: '2.1.291', checked: false, off: true, reason: '' });
  const unknown = trackerWorld({ claude: entryFor({ ...CLAUDE_ROWS, C2: 'fail' }) }, () => Promise.resolve(''));
  unknown.tracker.status('claude', cmdClaude);
  await new Promise(setImmediate);
  assert.equal(unknown.tracker.status('claude', cmdClaude).matched, false);
  const rejected = trackerWorld({ claude: entryFor(CLAUDE_ROWS) }, () => Promise.reject(new Error('x')));
  rejected.tracker.status('claude', cmdClaude);
  await new Promise(setImmediate);
  assert.equal(rejected.tracker.status('claude', cmdClaude).matched, false);
  const blank = trackerWorld({ claude: entryFor(CLAUDE_ROWS, { version: '' }) });
  assert.equal(blank.tracker.status('claude', cmdClaude).matched, false, 'an entry with no version never matches');
  for (const w of [other, unknown, rejected, blank]) fs.rmSync(w.dir, { recursive: true, force: true });
});

test('current() reads agent-contract.json again, so a check written while the bridge runs reaches the slot field', async () => {
  const w = trackerWorld(null);
  assert.equal(w.tracker.status('claude', cmdClaude).checked, false);
  await new Promise(setImmediate);
  fs.writeFileSync(w.file, JSON.stringify({ claude: entryFor({ ...CLAUDE_ROWS, C1: 'fail' }) }));
  const field = AC.slotField(w.tracker.current());
  assert.equal(field.claude.checked, true);
  assert.equal(field.claude.off, false);
  assert.match(field.claude.reason, /failed C1/);
  fs.writeFileSync(w.file, JSON.stringify({ claude: entryFor({ C1: 'pass', C2: 'unchecked' }) }));
  const partial = w.tracker.current().claude;
  assert.equal(partial.matched, true);
  assert.equal(partial.checked, false, 'a gating row that measured nothing leaves the CLI not checked');
  fs.rmSync(w.dir, { recursive: true, force: true });
});

test('the tracker ignores other agents, a command it cannot find or stat, and a broken contract file', async () => {
  const w = trackerWorld({ claude: entryFor(CLAUDE_ROWS) });
  assert.equal(w.tracker.status('grok', cmdClaude), null);
  assert.equal(w.tracker.status('claude', { file: '/bin/other', args: [], found: true }), null);
  assert.equal(w.tracker.status('claude', { ...cmdClaude, found: false }), null);
  delete w.stats['/real/claude'];
  assert.equal(w.tracker.status('claude', cmdClaude), null);
  w.stats['/real/claude'] = { ...ID };
  fs.writeFileSync(w.file, '[1, 2]');
  assert.equal(w.tracker.status('claude', cmdClaude).matched, false);
  fs.writeFileSync(w.file, '{ nope');
  assert.equal(w.tracker.status('claude', cmdClaude).matched, false);
  assert.equal(AC.sameIdentity({ realpath: '/real/claude', ...ID, ino: '77' }, AC.identityOf('/real/claude', ID)), false);
  assert.equal(AC.sameIdentity(null, AC.identityOf('/real/claude', ID)), false);
  fs.rmSync(w.dir, { recursive: true, force: true });
});

const status = (agent, rows, extra = {}) => ({ agent, version: '1.0.0', matched: true, checked: true, rows, ...extra });

test('a C2 fail gives the slot field { claude: { off: false, reason } } and refuses a run that turns a server off; nothing is refused unmatched', () => {
  const failed = status('claude', { ...CLAUDE_ROWS, C2: 'fail' });
  const field = AC.slotField({ claude: failed, grok: failed, codex: null });
  assert.deepEqual(Object.keys(field), ['claude']);
  assert.equal(field.claude.off, false);
  assert.equal(field.claude.checked, true);
  assert.equal(field.claude.version, '1.0.0');
  assert.match(
    field.claude.reason,
    /^Claude Code 1\.0\.0 failed C2 in claude-wow agents check, .*use \/claude mcp default, or update Claude Code and run claude-wow agents check again\.$/,
  );
  assert.equal(AC.refusal(failed, { off: true }), field.claude.reason);
  assert.equal(AC.refusal(failed, { off: false, secrets: true }), '', 'a run that turns nothing off is not refused');
  assert.match(AC.offReason(status('claude', { ...CLAUDE_ROWS, C1: 'fail', C2: 'fail' })), /failed C1 and C2/);
  const partial = status('claude', { C1: 'unchecked', C2: 'fail' }, { checked: false });
  assert.match(AC.refusal(partial, { off: true }), /failed C2/, 'a measured fail counts even when another gating row measured nothing');
  const unmatched = { agent: 'claude', version: '1.0.0', matched: false, checked: false, rows: { C2: 'fail' } };
  assert.equal(AC.refusal(unmatched, { off: true }), '', 'fail closed only on a measured fail of this binary');
  assert.deepEqual(AC.slotField({ claude: unmatched }), { claude: { version: '1.0.0', checked: false, off: true, reason: '' } });
  assert.equal(AC.refusal(status('claude', CLAUDE_ROWS), { off: true }), '');
  assert.equal(AC.refusal(null, { off: true }), '');
});

test('Codex: an X2a fail refuses a run that turns a server off, an X2b fail refuses a run that passes a secret', () => {
  const x2a = status('codex', { X1: 'pass', X2a: 'fail', X2b: 'pass' });
  assert.match(AC.refusal(x2a, { off: true }), /^Codex 1\.0\.0 failed X2a in claude-wow agents check/);
  assert.equal(AC.refusal(x2a, { secrets: true }), '');
  const x2b = status('codex', { X1: 'pass', X2a: 'pass', X2b: 'fail' });
  assert.match(AC.refusal(x2b, { secrets: true }), /^Codex 1\.0\.0 failed X2b in claude-wow agents check, so its shell may see an MCP server's secret\./);
  assert.equal(AC.refusal(x2b, { off: true }), '');
  assert.equal(AC.slotField({ codex: x2b }).codex.off, true, 'X2b does not grey the menu');
});

test('the slot file carries the contract field for the addon, and an empty one when nothing is known', () => {
  const lua = P.luaTable('ClaudeWoW_SlotData', [], {
    contract: {
      claude: { version: '2.1.290', checked: true, off: false, reason: 'say "no"' },
      codex: { version: '', checked: false, off: true, reason: '' },
      'Bad id': {},
      x: null,
    },
  });
  assert.match(
    lua,
    /^\tcontract = \{ claude = \{ version = "2\.1\.290", checked = true, off = false, reason = "say \\"no\\"" \}, codex = \{ version = "", checked = false, off = true, reason = "" \} \},$/m,
  );
  assert.match(P.luaTable('X', [], { contract: {} }), /^\tcontract = \{ {2}\},$/m);
  assert.doesNotMatch(P.luaTable('X', [], {}), /contract/);
});

test('judgeClaude: every row from the init events, and the failures each one names', () => {
  const nonces = { arg: 'arg_1', env: 'env_1' };
  const good = ['mcp__a_b_c__alpha', 'mcp__a_b_c__beta', 'mcp__a_b_c__arg_1', 'mcp__a_b_c__env_1'];
  const run = (...events) => ({ events, stderr: '' });
  const ok = AC.judgeClaude(run(claudeInit(good)), run(claudeInit([])), nonces);
  assert.deepEqual(ok.rows, CLAUDE_ROWS);
  assert.deepEqual(ok.notes, []);

  const other = ['mcp__a_b__c__alpha', 'mcp__a_b__c__beta', 'mcp__a_b__c__arg_1', 'mcp__a_b__c__${CONTRACT_PROBE_ENV}'];
  const bad = AC.judgeClaude(run(claudeInit(other, [{ name: 'a.b c', status: 'connected' }])), run(claudeInit(['mcp__a_b__c__alpha'])), nonces);
  assert.deepEqual(bad.rows, { C1: 'fail', C2: 'fail', C2u: 'unchecked', C3: 'fail', C4: 'fail' });
  assert.equal(bad.notes.length, 4);
  assert.match(bad.notes[3], /these tools stayed: mcp__a_b__c__alpha/);

  const none = AC.judgeClaude({ events: [], stderr: 'boom', timedOut: true }, null, nonces);
  assert.ok(Object.values(none.rows).every(r => r === 'unchecked'));
  assert.match(none.notes[0], /no system\/init event before the time limit: boom/);

  const down = AC.judgeClaude(run(claudeInit([], [{ name: 'a.b c', status: 'failed', source: 'dynamic' }])), null, nonces);
  assert.equal(down.rows.C4, 'pass');
  assert.equal(down.rows.C1, 'unchecked');
  assert.match(down.notes[0], /its status: failed/);

  const noSecond = AC.judgeClaude(run(claudeInit(good)), run(), nonces);
  assert.equal(noSecond.rows.C2, 'unchecked');
  const failedSecond = AC.judgeClaude(run(claudeInit(good)), run(claudeInit([], [{ name: 'a.b c', status: 'failed', source: 'dynamic' }])), nonces);
  assert.equal(failedSecond.rows.C2, 'unchecked', 'a server that did not start proves nothing about the deny rule');
});

test('probeClaude: two runs stopped at init, the second with the deny rule, against a --mcp-config server whose args and env use ${VAR}', async () => {
  const dir = scratch('probe-claude');
  const runs = [];
  const run = async (file, args, opts) => {
    const config = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
    runs.push({ file, args, opts, config });
    assert.equal(opts.stopWhen({ type: 'system', subtype: 'init' }), true);
    assert.equal(opts.stopWhen({ type: 'result' }), false);
    const tools = args.includes('--disallowedTools')
      ? []
      : ['mcp__a_b_c__alpha', 'mcp__a_b_c__beta', `mcp__a_b_c__${opts.env.CONTRACT_PROBE_ARG}`, `mcp__a_b_c__${opts.env.CONTRACT_PROBE_ENV}`];
    return { events: [claudeInit(tools)], stderr: '' };
  };
  const r = await AC.probeClaude({
    cmd: { file: 'node', args: ['claude.js'] },
    run,
    fixture: { command: 'fix', args: ['contract-mcp'] },
    env: { CLAUDECODE: '1', KEEP: 'x' },
    dir,
  });
  assert.deepEqual(r.rows, CLAUDE_ROWS);
  assert.match(r.cost, /^none reported/);
  assert.equal(runs.length, 2);
  const [a, b] = runs;
  assert.equal(a.file, 'node');
  assert.equal(a.args[0], 'claude.js');
  for (const flag of ['--strict-mcp-config', '--no-session-persistence', '--verbose']) assert.ok(a.args.includes(flag), flag);
  assert.equal(a.args[a.args.indexOf('--model') + 1], 'haiku');
  assert.equal(a.args[a.args.indexOf('--max-budget-usd') + 1], '0.05');
  assert.equal(a.args[a.args.indexOf('--allowedTools') + 1], 'mcp__a_b_c__alpha');
  assert.ok(!a.args.includes('--disallowedTools'));
  assert.deepEqual(b.args.slice(-2), ['--disallowedTools', 'mcp__a_b_c']);
  assert.deepEqual(a.config.mcpServers['a.b c'], {
    type: 'stdio',
    command: 'fix',
    args: ['contract-mcp', 'alpha', 'beta', '${CONTRACT_PROBE_ARG}'],
    env: { CONTRACT_MCP_TOOL: '${CONTRACT_PROBE_ENV}' },
  });
  assert.equal(a.opts.env.CLAUDECODE, undefined, 'the claude env, as the bridge runs it');
  assert.equal(a.opts.env.KEEP, 'x');
  assert.match(a.opts.env.CONTRACT_PROBE_ARG, /^arg_[0-9a-f]{10}$/);
  assert.equal(a.opts.input, 'Reply with the single word ok.');

  const noInit = [];
  const r2 = await AC.probeClaude({
    cmd: { file: 'claude' },
    run: async (file, args) => {
      noInit.push(args);
      return { events: [{ type: 'result', total_cost_usd: 0.0123 }], stderr: '' };
    },
    fixture: { command: 'fix', args: [] },
    dir,
  });
  assert.equal(noInit.length, 1, 'no second run without an init event');
  assert.equal(r2.cost, '$0.0123 reported by Claude Code');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('judgeClaude: C2 passes only when the fixture server connected in the deny run and no tool leaked', () => {
  const nonces = { arg: 'arg_1', env: 'env_1' };
  const good = ['mcp__a_b_c__alpha', 'mcp__a_b_c__beta', 'mcp__a_b_c__arg_1', 'mcp__a_b_c__env_1'];
  const run = (...events) => ({ events, stderr: '' });
  for (const servers of [[{ name: 'a.b c', status: 'pending', source: 'dynamic' }], [{ name: 'a.b c', status: 'needs-auth', source: 'dynamic' }], []]) {
    const r = AC.judgeClaude(run(claudeInit(good)), run(claudeInit([], servers)), nonces);
    assert.equal(r.rows.C2, 'unchecked', JSON.stringify(servers));
    assert.match(r.notes.at(-1), /in the second run, so its missing tools prove nothing/);
  }
  assert.equal(AC.judgeClaude(run(claudeInit(good)), run(claudeInit([])), nonces).rows.C2, 'pass');
});

function codexEvents({ call, shell, shells, extra = [], usage = { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } }) {
  const items = [];
  if (call) items.push({ id: 'i0', type: 'mcp_tool_call', server: 'contract', tool: 'ping', ...call });
  for (const [k, sh] of (shells || (shell ? [shell] : [])).entries())
    items.push({ id: `s${k}`, type: 'command_execution', command: "/bin/zsh -lc 'printenv CONTRACT_MCP_ECHO'", ...sh });
  items.push(...extra);
  return [
    { type: 'thread.started', thread_id: 't' },
    ...items.map(item => ({ type: 'item.completed', item })),
    ...(usage ? [{ type: 'turn.completed', usage }] : []),
  ];
}

const UNSET_EXIT = { status: 'failed', exit_code: 1, aggregated_output: '' };

test('judgeCodexCall: X1 from the MCP call, X2b from what the server and every shell command saw', () => {
  const secret = 'secret_1';
  const result = { content: [{ type: 'text', text: `ping echo=${secret}` }] };
  const pass = AC.judgeCodexCall({ events: codexEvents({ call: { status: 'completed', result }, shell: UNSET_EXIT }) }, secret);
  assert.deepEqual(pass.rows, { X1: 'pass', X2b: 'pass' }, 'printenv of a hidden variable exits 1 with no output: that is the pass');
  const declined = AC.judgeCodexCall(
    { events: codexEvents({ call: { status: 'completed', result }, shell: { status: 'declined', exit_code: null, aggregated_output: '' } }) },
    secret,
  );
  assert.deepEqual(declined.rows, { X1: 'pass', X2b: 'unchecked' }, 'a shell command that never ran proves nothing');
  const retry = AC.judgeCodexCall(
    {
      events: codexEvents({
        call: { status: 'completed', result },
        shells: [UNSET_EXIT, { status: 'completed', exit_code: 0, aggregated_output: `${secret}\n` }],
      }),
    },
    secret,
  );
  assert.deepEqual(retry.rows, { X1: 'pass', X2b: 'fail' }, 'a later attempt that prints the secret wins');
  const leak = AC.judgeCodexCall({ events: codexEvents({ shell: { status: 'completed', exit_code: 0, aggregated_output: `${secret}\n` } }) }, secret);
  assert.deepEqual(leak.rows, { X1: 'unchecked', X2b: 'fail' }, 'measured on Codex 0.160.1: the shell printed the excluded name');
  assert.match(leak.notes.join(' '), /the shell printed CONTRACT_MCP_ECHO although shell_environment_policy\.exclude names it/);
  const noEnv = AC.judgeCodexCall(
    { events: codexEvents({ call: { status: 'completed', result: { content: [{ text: 'ping echo=' }] } }, shell: UNSET_EXIT }) },
    secret,
  );
  assert.deepEqual(noEnv.rows, { X1: 'pass', X2b: 'fail' });
  const refused = AC.judgeCodexCall(
    {
      events: codexEvents({ call: { status: 'failed', error: { message: 'MCP tool call requires approval, but approval policy is never' } } }),
      timedOut: false,
    },
    secret,
  );
  assert.equal(refused.rows.X1, 'fail');
  assert.match(refused.notes[0], /requires approval/);
  const late = AC.judgeCodexCall({ events: [], timedOut: true }, secret);
  assert.match(late.notes[0], /no call to the contract server before the time limit/);
});

test('judgeCodexList: X2a from codex mcp list --json, with the -c server as the control', () => {
  const list = rows => ({ stdout: JSON.stringify(rows), stderr: '' });
  assert.deepEqual(
    AC.judgeCodexList(
      list([
        { name: 'contract', enabled: true },
        { name: 'contract_off', enabled: false },
        { name: 'mine', enabled: false },
      ]),
      ['mine'],
    ),
    { X2a: 'pass', notes: [] },
  );
  const stayed = AC.judgeCodexList(
    list([
      { name: 'contract', enabled: true },
      { name: 'contract_off', enabled: false },
      { name: 'mine', enabled: true },
    ]),
    ['mine'],
  );
  assert.equal(stayed.X2a, 'fail');
  assert.match(stayed.notes[0], /did not turn off: mine/);
  assert.equal(AC.judgeCodexList(list([{ name: 'contract_off', enabled: false }]), []).X2a, 'unchecked');
  const junk = AC.judgeCodexList({ stdout: 'not json', stderr: 'error: unknown command' }, []);
  assert.equal(junk.X2a, 'unchecked');
  assert.match(junk.notes[0], /printed no list: error: unknown command/);
});

function codexRun(execEvents) {
  const runs = [];
  const run = async (file, args, opts) => {
    runs.push({ file, args, opts });
    if (args.includes('list'))
      return {
        events: [],
        stdout: JSON.stringify([
          { name: 'contract', enabled: true },
          { name: 'contract_off', enabled: false },
          { name: 'mine', enabled: false },
        ]),
      };
    return { events: execEvents(opts.env.CONTRACT_MCP_ECHO) };
  };
  return { runs, run };
}

test('probeCodex: the -c slice the bridge emits, one free mcp list and one exec run, with the secret only in the env', async () => {
  const dir = scratch('probe-codex');
  const { runs, run } = codexRun(secret =>
    codexEvents({ call: { status: 'completed', result: { content: [{ type: 'text', text: `ping echo=${secret}` }] } }, shell: UNSET_EXIT }),
  );
  const r = await AC.probeCodex({
    cmd: { file: 'codex', args: [] },
    run,
    fixture: { command: 'fix', args: ['contract-mcp'] },
    env: { A: '1' },
    dir,
    own: ['mine'],
  });
  assert.deepEqual(r.rows, { X1: 'pass', X2a: 'pass', X2b: 'pass' });
  assert.equal(r.cost, '10 input tokens (4 cached), 2 output tokens on gpt-6-luna; Codex reports no price');
  const [list, exec] = runs;
  const server = { type: 'stdio', command: 'fix', args: ['contract-mcp', 'ping'] };
  const defined = MC.codexArgs([
    { name: 'contract', server, envVars: ['CONTRACT_MCP_ECHO'], enabledTools: null },
    { name: 'contract_off', server, envVars: [], enabledTools: null },
  ]);
  const off = ['-c', 'mcp_servers.contract_off.enabled=false', '-c', 'mcp_servers.mine.enabled=false'];
  assert.deepEqual(list.args, [...defined, ...off, 'mcp', 'list', '--json']);
  assert.deepEqual(exec.args.slice(0, defined.length + off.length + 1), [...defined, ...off, 'exec']);
  assert.ok(defined.includes('shell_environment_policy.exclude=["CONTRACT_MCP_ECHO"]'));
  assert.equal(exec.args[exec.args.indexOf('-m') + 1], 'gpt-6-luna');
  assert.equal(exec.args.at(-1), '-');
  assert.equal(list.opts.env.CONTRACT_MCP_ECHO, undefined, 'the free list run never sees the secret');
  assert.match(exec.opts.env.CONTRACT_MCP_ECHO, /^secret_[0-9a-f]{10}$/);
  assert.ok(!exec.args.join(' ').includes(exec.opts.env.CONTRACT_MCP_ECHO), 'the secret is never on argv');
  assert.match(exec.opts.input, /mcp__contract__ping/);

  const offCall = codexRun(secret =>
    codexEvents({
      call: { status: 'completed', result: { content: [{ type: 'text', text: `ping echo=${secret}` }] } },
      shell: UNSET_EXIT,
      extra: [{ id: 'o', type: 'mcp_tool_call', server: 'contract_off', tool: 'ping', status: 'completed' }],
    }),
  );
  const called = await AC.probeCodex({ cmd: { file: 'codex' }, run: offCall.run, fixture: { command: 'f', args: [] }, dir, own: ['mine'] });
  assert.equal(called.rows.X2a, 'fail', 'mcp list says off, but the run called it');
  assert.match(called.notes.join(' '), /Codex called the contract_off server/);

  const quiet = await AC.probeCodex({
    cmd: { file: 'codex' },
    run: async () => ({ events: [], stdout: '' }),
    fixture: { command: 'f', args: [] },
    dir,
    own: [],
  });
  assert.equal(quiet.cost, 'no usage reported');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('spawnRun reads JSON lines, stops the child on the first matching event, and stops one that runs past its time', async () => {
  const dir = scratch('spawnrun');
  const script = path.join(dir, 'agent.js');
  fs.writeFileSync(
    script,
    "let s = ''; process.stdin.on('data', d => (s += d)).on('end', () => { console.log(JSON.stringify({ type: 'echo', s })); console.log('not json'); console.log('[1]'); console.log(JSON.stringify({ type: 'system', subtype: 'init' })); setInterval(() => {}, 1000); });",
  );
  const r = await AC.spawnRun(process.execPath, [script], { input: 'hi', stopWhen: ev => ev.subtype === 'init', env: process.env, cwd: dir });
  assert.equal(r.stopped, true);
  assert.equal(r.timedOut, false);
  assert.deepEqual(r.events, [
    { type: 'echo', s: 'hi' },
    { type: 'system', subtype: 'init' },
  ]);
  assert.match(r.stdout, /not json/);
  const slow = await AC.spawnRun(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200, env: process.env });
  assert.equal(slow.timedOut, true);
  const missing = await AC.spawnRun(path.join(dir, 'missing-binary'), [], { env: process.env });
  assert.equal(missing.events.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

function checkWorld(probes) {
  const dir = scratch('check');
  const home = { dir: path.join(dir, 'home'), config: path.join(dir, 'home', 'config.json') };
  fs.mkdirSync(home.dir, { recursive: true });
  fs.writeFileSync(home.config, JSON.stringify({ agents: { claude: { path: '/x/claude' } } }));
  fs.writeFileSync(path.join(home.dir, AC.FILE_NAME), JSON.stringify({ grok: { keep: true } }));
  const lines = [];
  const seenCfg = [];
  const deps = {
    home,
    tmpDir: dir,
    out: l => lines.push(l),
    env: { CLAUDECODE: '1' },
    signals: new (require('events').EventEmitter)(),
    resolveCommand: (id, cfg) => {
      seenCfg.push([id, cfg.path]);
      return id === 'claude' ? { file: '/x/claude', args: [], found: true } : { file: 'codex', args: [], found: false, note: 'install it' };
    },
    which: { exists: p => p === '/x/claude' },
    version: async () => '2.1.290',
    realpath: p => `/real${p}`,
    stat: () => ({ ...ID }),
    now: () => Date.parse('2026-10-05T12:00:00Z'),
    probes,
  };
  const written = () => JSON.parse(fs.readFileSync(path.join(home.dir, AC.FILE_NAME), 'utf8'));
  return { dir, home, lines, seenCfg, deps, written };
}

test('agents check: probes each found agent, prints every row and the cost, writes the identity and rows, and exits 1 on a fail', async () => {
  const w = checkWorld({
    claude: async ({ cmd, env, dir: tmp }) => {
      assert.equal(cmd.file, '/x/claude');
      assert.equal(env.CLAUDECODE, undefined);
      assert.ok(fs.existsSync(tmp));
      return { rows: { ...CLAUDE_ROWS, C2: 'fail' }, notes: ['n1'], cost: 'none reported' };
    },
  });
  assert.equal(await AC.check(['check'], w.deps), 1);
  assert.deepEqual(w.seenCfg, [
    ['claude', '/x/claude'],
    ['codex', undefined],
  ]);
  assert.equal(w.lines[0], 'claude: Claude Code 2.1.290 at /real/x/claude');
  assert.match(w.lines[2], /^ {2}C2 {3}fail {6}--disallowedTools/);
  assert.ok(w.lines.includes('  note: n1'));
  assert.ok(w.lines.includes('  cost: none reported'));
  assert.ok(w.lines.includes('codex: not found (install it); skipped'));
  assert.ok(w.lines.includes(`wrote ${path.join(w.home.dir, AC.FILE_NAME)}`));
  assert.match(w.lines.at(-1), /a failed row turns that behavior off/);
  assert.deepEqual(w.written().grok, { keep: true }, 'other entries are kept');
  assert.deepEqual(w.written().claude, {
    path: '/x/claude',
    realpath: '/real/x/claude',
    ...ID,
    version: '2.1.290',
    at: '2026-10-05T12:00:00.000Z',
    checked: true,
    rows: { ...CLAUDE_ROWS, C2: 'fail' },
    cost: 'none reported',
  });
  assert.deepEqual(fs.readdirSync(w.dir).sort(), ['home'], 'the scratch folder is removed');
  assert.equal(w.deps.signals.listenerCount('SIGINT'), 0);

  w.lines.length = 0;
  w.deps.probes.claude = async () => ({ rows: { ...CLAUDE_ROWS, C2: 'unchecked' }, notes: [], cost: 'c' });
  assert.equal(await AC.check(['check', '--agent', 'claude'], w.deps), 1, 'an inconclusive recheck keeps the measured fail');
  assert.equal(w.written().claude.rows.C2, 'fail');
  assert.ok(w.lines.includes('  note: kept the earlier fail of C2 for this same binary; only a measured pass clears it'));
  assert.ok(!w.lines.some(l => l.startsWith('codex')));

  w.deps.stat = () => ({ ...ID, ctimeMs: 5 });
  w.lines.length = 0;
  assert.equal(await AC.check(['check', '--agent', 'claude'], w.deps), 3, 'another binary: the old fail is not carried over');
  assert.equal(w.written().claude.rows.C2, 'unchecked');
  assert.equal(w.written().claude.checked, false);
  assert.ok(w.lines.includes('  not checked: C2 measured nothing; run it again'));

  w.deps.probes.claude = async () => ({ rows: CLAUDE_ROWS, notes: [], cost: 'c' });
  w.deps.version = async () => '';
  w.lines.length = 0;
  assert.equal(await AC.check(['check', '--agent', 'claude'], w.deps), 3);
  assert.ok(w.lines.includes('  not checked: the version is unknown; run it again'));
  w.deps.version = async () => '2.1.290';
  assert.equal(await AC.check(['check', '--agent', 'claude'], w.deps), 0);
  assert.equal(w.written().claude.checked, true);
  fs.rmSync(w.dir, { recursive: true, force: true });
});

test('agents check: help, a missing or unknown --agent and an unknown option never resolve or probe an agent', async () => {
  const w = checkWorld({
    claude: async () => {
      throw new Error('must not probe');
    },
  });
  w.deps.resolveCommand = () => {
    throw new Error('must not resolve');
  };
  for (const [argv, code, said] of [
    [['check', '--help'], 0, null],
    [['check', '-h'], 0, null],
    [['--help'], 0, null],
    [[], 2, null],
    [['check', '--agent'], 2, '--agent needs one of claude, codex'],
    [['check', '--agent', 'grok'], 2, '--agent needs one of claude, codex, not "grok"'],
    [['check', '--fast'], 2, 'unknown option "--fast"'],
  ]) {
    w.lines.length = 0;
    assert.equal(await AC.check(argv, w.deps), code, argv.join(' '));
    if (said) assert.equal(w.lines[0], said);
    assert.match(w.lines.at(-1), /^claude-wow agents check/);
  }
  fs.rmSync(w.dir, { recursive: true, force: true });
});

test('agents check: SIGINT kills the running probe child, skips the rest and exits 130 without writing', async () => {
  const w = checkWorld({});
  w.deps.resolveCommand = id => ({ file: '/x/claude', args: [], found: true, id });
  w.deps.run = AC.spawnRun;
  let pid = 0;
  const probed = [];
  w.deps.probes = {
    claude: async ({ run }) => {
      probed.push('claude');
      const p = run(process.execPath, ['-e', "console.log(JSON.stringify({ type: 'up', pid: process.pid })); setInterval(() => {}, 1000)"], {
        env: process.env,
        stopWhen: ev => {
          if (ev.type === 'up') {
            pid = ev.pid;
            setImmediate(() => w.deps.signals.emit('SIGINT'));
          }
          return false;
        },
      });
      const r = await p;
      return { rows: { ...CLAUDE_ROWS }, notes: [], cost: String(r.code) };
    },
    codex: async () => {
      probed.push('codex');
      return { rows: {}, notes: [], cost: '' };
    },
  };
  const t0 = Date.now();
  assert.equal(await AC.check(['check'], w.deps), 130);
  assert.ok(Date.now() - t0 < 10000);
  assert.deepEqual(probed, ['claude'], 'the next agent is not probed');
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the probe child is gone');
  assert.equal(w.lines.at(-1), 'interrupted: the probe runs were stopped');
  assert.deepEqual(Object.keys(w.written()), ['grok'], 'nothing is written for an interrupted probe');
  assert.equal(w.deps.signals.listenerCount('SIGTERM'), 0);
  fs.rmSync(w.dir, { recursive: true, force: true });
});

test('the contract-mcp fixture answers initialize, lists the tools it was told plus the env one, echoes one env value and writes its mark', async () => {
  const dir = scratch('fixture');
  const mark = path.join(dir, 'm');
  const [file, args] = R.scriptCommand('contract-mcp', ['--mark', mark, 'ping', 'a.b']);
  assert.equal(args[0], path.join(R.ROOT, 'dev', 'contract-mcp.js'));
  const child = spawn(file, args, { env: { ...process.env, [FIX.TOOL_ENV]: 'from env', [FIX.ECHO_ENV]: 'v1' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = [];
  let buf = '';
  const got = new Promise(resolve =>
    child.stdout.on('data', d => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) replies.push(JSON.parse(l));
      if (replies.length >= 6) resolve();
    }),
  );
  const send = msg => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  send({ id: 3, method: 'tools/call', params: { name: 'ping' } });
  send({ id: 4, method: 'tools/call', params: { name: 'nope' } });
  send({ id: 5, method: 'nope' });
  send({ id: 6, method: 'ping' });
  child.stdin.write('not json\n');
  await got;
  child.stdin.end();
  await new Promise(r => child.on('close', r));
  assert.equal(replies[0].result.protocolVersion, '2024-11-05');
  assert.deepEqual(
    replies[1].result.tools.map(t => t.name),
    ['ping', 'a_b', 'from_env'],
  );
  assert.deepEqual(replies[2].result.content, [{ type: 'text', text: 'ping echo=v1' }]);
  assert.equal(replies[3].result.isError, true);
  assert.equal(replies[4].error.code, -32601);
  assert.deepEqual(replies[5].result, {});
  assert.ok(fs.existsSync(mark));
  fs.rmSync(dir, { recursive: true, force: true });
});
