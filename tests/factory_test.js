'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../bridge/factory');
const GM = require('../bridge/goalsmcp');
const LP = require('../bridge/liveproto');
const PR = require('../bridge/procs');
const PL = require('../bridge/plugins');

const FAKE = path.join(__dirname, '..', 'dev', 'fake-claude.js');
const POSIX = process.platform !== 'win32';

const until = async (cond, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = cond();
    if (v) return v;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
};

const conf = (extra = {}) => F.settings({ factory: { enabled: true, ...extra } });

function rig(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-factory-'));
  const work = path.join(dir, 'repo');
  const fakeState = path.join(dir, 'fake');
  fs.mkdirSync(work);
  const logs = [];
  const done = [];
  const spawned = [];
  const factory = F.createFactory({
    dir: path.join(dir, 'home', 'factory'),
    log: l => logs.push(l),
    command: () => (opts.missing ? { found: false, note: 'not here' } : { file: process.execPath, args: [FAKE], found: true }),
    baseConfig: () => ({ permissionMode: 'acceptEdits', allowedTools: ['WebSearch'], deniedTools: [], effort: 'max', model: 'opus[1m]' }),
    env: () => ({ ...process.env, CLAUDE_WOW_FAKE_STATE: fakeState }),
    onDone: (run, ctx) => done.push({ run, ctx }),
    spawn: (...a) => { const c = PR.spawnChild(...a); spawned.push(c); return c; },
    ...(opts.factory || {}),
  });
  const calls = () => {
    try { return fs.readFileSync(path.join(fakeState, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
  };
  const ctx = (c = conf()) => ({ conf: c, cwd: work, label: '#7', key: 'chat-1', job: { id: 7 } });
  return { dir, work, logs, done, spawned, factory, calls, ctx, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const argAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('settings: off unless enabled; the default allowlist is the factory skills; per-skill models; bad names are dropped', () => {
  assert.deepEqual(F.settings({}), { enabled: false });
  assert.deepEqual(F.settings({ factory: { enabled: 'yes' } }), { enabled: false });
  const d = conf();
  assert.deepEqual(d.skills, ['every-ai-lead', 'babysit-prs', 'babysit-pr', 'merge-train', 'implementation-engineer', 'adversarial-review', 'factory-intake', 'fresh-eyes', 'review-prs']);
  assert.equal(d.model, 'opus');
  assert.equal(d.maxRunning, 2);
  const c = conf({ skills: ['babysit-pr', 'Bad Name', '--rm', 'fresh-eyes', 'babysit-pr'], model: 'sonnet', models: { 'fresh-eyes': { model: 'claude-fable-5-1', effort: 'high' }, 'babysit-pr': 'opus', 'not-listed': 'haiku' } });
  assert.deepEqual(c.skills, ['babysit-pr', 'fresh-eyes']);
  assert.deepEqual(F.modelFor(c, 'fresh-eyes'), { model: 'claude-fable-5-1', effort: 'high' });
  assert.deepEqual(F.modelFor(c, 'babysit-pr'), { model: 'opus', effort: '' });
  assert.equal(c.models['not-listed'], undefined);
  const rules = F.dispatcherRules(c);
  assert.match(rules, /Never edit files, run commands or write code yourself/);
  assert.match(rules, /Skills you may dispatch: babysit-pr, fresh-eyes\./);
  assert.deepEqual(F.toolSchemas(c.skills)[0].inputSchema.properties.skill.enum, ['babysit-pr', 'fresh-eyes']);
  for (const t of ['Edit', 'Write', 'Bash', 'Skill', 'Agent']) assert.ok(F.DISPATCHER_DENIED.includes(t), t);
  assert.deepEqual([...F.RUN_RULES], ['mcp__wowfactory__factory_dispatch', 'mcp__wowfactory__factory_status']);
});

test('the coding plugin is a dispatcher only when factory.enabled is true', () => {
  const code = require('../bridge/plugins/claude-code');
  const p = PL.createRegistry().register(code);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-factory-plug-'));
  const runs = [];
  let options = {};
  const core = { log() {}, tag: j => '#' + j.id, defaultCwd: base, options: () => options, sessionFolder: () => '', fail() {}, runAgent: (job, o) => runs.push(o) };
  p.handle({ id: 1, cwd: '', text: 'hi' }, core);
  assert.equal(runs[0].factory, undefined);
  assert.equal(runs[0].tools, undefined, 'without the factory the prompt is what it was');
  assert.equal(runs[0].deniedTools, undefined);
  options = { factory: { enabled: true, skills: ['babysit-pr'] } };
  p.handle({ id: 2, cwd: '', text: 'babysit 12' }, core);
  assert.deepEqual(runs[1].factory.skills, ['babysit-pr']);
  assert.match(runs[1].tools, /dispatcher into the software factory/);
  assert.deepEqual(runs[1].deniedTools, [...F.DISPATCHER_DENIED]);
  assert.equal(runs[1].cwd, base);
  fs.rmSync(base, { recursive: true, force: true });
});

test('a dispatch runs the skill as its own claude -p run: prompt on stdin, the skill model, the result cost, summary and PR URLs', async () => {
  const r = rig();
  try {
    const c = conf({ models: { 'babysit-pr': { model: 'claude-opus-5-5', effort: 'high' } }, allowedTools: ['Bash(gh:*)'] });
    const res = r.factory.dispatch({ skill: '/babysit-pr', args: '12\n[[reply Opened https://github.com/a/b/pull/12 and it is green]]' }, r.ctx(c));
    assert.equal(res.ok, true, res.text);
    const id = /Started factory run ([0-9a-f]{8})/.exec(res.text)[1];
    assert.equal(r.factory.children().length, 1);
    const run = await until(() => r.factory.runs().find(x => x.id === id && x.status !== 'running'));
    assert.equal(run.status, 'done', JSON.stringify(run));
    assert.ok(run.costUsd > 0, 'the cost comes from the result event');
    assert.deepEqual(run.prUrls, ['https://github.com/a/b/pull/12']);
    assert.match(run.summary, /Opened https:\/\/github.com\/a\/b\/pull\/12/);
    assert.equal(r.factory.children().length, 0);
    const call = r.calls().at(-1);
    assert.equal(call.prompt, '/babysit-pr 12 [[reply Opened https://github.com/a/b/pull/12 and it is green]]', 'one line, on stdin');
    assert.ok(!call.argv.some(a => a.includes('babysit-pr')), 'the prompt is never in argv');
    assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(r.work));
    assert.equal(argAfter(call.argv, '--model'), 'claude-opus-5-5');
    assert.equal(argAfter(call.argv, '--effort'), 'high');
    assert.equal(argAfter(call.argv, '--permission-mode'), 'acceptEdits');
    assert.ok(call.argv.includes('Bash(gh:*)') && call.argv.includes('WebSearch'));
    assert.ok(!call.argv.includes('--mcp-config'), 'a factory run gets no bridge tools');
    assert.equal(argAfter(call.argv, '--append-system-prompt'), F.RUN_SYSTEM);
    assert.equal(r.done.length, 1, 'the bridge is told once');
    assert.equal(r.done[0].ctx.key, 'chat-1');
    const status = r.factory.status({ runId: id });
    assert.match(status.text, new RegExp(`^/babysit-pr 12 .*: done after \\d+s, \\$\\d+\\.\\d\\d\\. Factory run ${id}, model claude-opus-5-5\\.`));
    assert.match(r.factory.status({}).text, new RegExp(id));
    assert.match(fs.readFileSync(run.log, 'utf8'), /"type":"result"/, 'the log holds the run');
    assert.equal(fs.statSync(run.log).mode & 0o777, POSIX ? 0o600 : fs.statSync(run.log).mode & 0o777);
  } finally { r.cleanup(); }
});

test('the run summary is plain text for the game window: no Markdown marks, and a long one ends at a sentence', () => {
  const said = [
    '## Result',
    'I merged **2 of the 3** approved AI PRs into `internal`. See [the PR](https://github.com/a/b/pull/1).',
    '* **#18579** (batch of 9 fixes): **not merged.** Its `sensitive-read-audit.test.ts:65` check fails.',
    '- __#18610__: merged.',
  ].join('\n');
  assert.equal(F.summaryOf(said), [
    'Result',
    'I merged 2 of the 3 approved AI PRs into internal. See the PR https://github.com/a/b/pull/1.',
    '- #18579 (batch of 9 fixes): not merged. Its sensitive-read-audit.test.ts:65 check fails.',
    '- #18610: merged.',
  ].join('\n'));
  const long = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const cut = F.summaryOf(long);
  assert.ok(cut.length <= 4000, cut.length);
  assert.match(cut, /is here\.$/, 'a cut summary ends at a whole sentence, with no bare marker');
  assert.equal(F.summarize(long).cut, true);
  assert.equal(F.summarize(said).cut, false);
});

test('a run summary keeps paragraph breaks: one blank line between paragraphs, none at the ends', () => {
  const said = ['', '', 'First paragraph.', '', '', '', 'Second paragraph.', '- item', '', '   ', 'Third.', '', ''].join('\n');
  assert.equal(F.summaryOf(said), ['First paragraph.', '', 'Second paragraph.', '- item', '', 'Third.'].join('\n'));
});

test('a cut summary ends with one line that names the run log, from the line cap alone or the character cap', () => {
  const run = { id: 'abcd1234', skill: 'merge-train', args: '', model: 'opus', status: 'done', startedAt: 0, endedAt: 1000, log: '/home/u/.claude-wow/factory/logs/abcd1234.log', prUrls: [] };
  const lines = Array.from({ length: 45 }, (_, k) => `Step ${k} went well.`);
  const byLines = F.summarize(lines.join('\n'));
  assert.equal(byLines.cut, true, 'the line cap alone marks the summary cut');
  assert.ok(byLines.text.length < 4000);
  assert.equal(byLines.text.split('\n').length, 40);
  assert.ok(byLines.text.endsWith('Step 39 went well.'));
  const note = `Cut for chat. The full output is in ${run.log} on the bridge computer.`;
  const shown = F.describe({ ...run, summary: byLines.text, summaryCut: byLines.cut }, 1000);
  assert.equal(shown.split('\n').at(-1), note);
  assert.equal(shown.split(note).length, 2, 'the note is there once');
  const whole = F.summarize(lines.slice(0, 40).join('\n'));
  assert.equal(whole.cut, false, 'exactly 40 lines is not cut');
  assert.ok(!F.describe({ ...run, summary: whole.text, summaryCut: whole.cut }, 1000).includes('Cut for chat'));
  const blanksPastCap = F.summarize([...lines.slice(0, 40), '', ''].join('\n'));
  assert.equal(blanksPastCap.cut, false, 'trailing blank lines past the cap are not a cut');
  const long = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const byChars = F.summarize(long);
  assert.equal(byChars.cut, true, 'the character cap marks the summary cut');
  assert.match(F.describe({ ...run, summary: byChars.text, summaryCut: byChars.cut }, 1000), /is here\.\nCut for chat\. The full output is in \/home\/u\/\.claude-wow\/factory\/logs\/abcd1234\.log on the bridge computer\.$/);
});

test('refusals: a skill outside the allowlist, a skill-like injection, an off factory, a missing claude and too many runs start nothing', async () => {
  const r = rig();
  try {
    const c = conf({ skills: ['babysit-pr'], maxRunning: 1 });
    for (const skill of ['merge-train', 'babysit-pr extra', '', 'babysit-pr; rm -rf /', '../babysit-pr']) {
      const res = r.factory.dispatch({ skill, args: '1' }, r.ctx(c));
      assert.equal(res.ok, false, skill);
      assert.match(res.text, /is not a factory skill this bridge may run\. Allowed: babysit-pr\./);
    }
    assert.equal(r.factory.dispatch({ skill: 'babysit-pr' }, r.ctx(F.settings({}))).ok, false);
    assert.match(r.factory.dispatch({ skill: 'babysit-pr', args: 'x'.repeat(2001) }, r.ctx(c)).text, /limit is 2000/);
    assert.equal(r.spawned.length, 0, 'nothing was spawned for a refusal');
    assert.ok(r.logs.some(l => /refused skill "merge-train"/.test(l)));

    const first = r.factory.dispatch({ skill: 'babysit-pr', args: '[[sleep 2]]' }, r.ctx(c));
    assert.equal(first.ok, true, first.text);
    const second = r.factory.dispatch({ skill: 'babysit-pr', args: '2' }, r.ctx(c));
    assert.equal(second.ok, false);
    assert.match(second.text, /maxRunning/);
    assert.equal(r.spawned.length, 1);
    assert.match(r.factory.call('factory_nuke', {}, r.ctx(c)).text, /not a factory tool/);
    assert.match(r.factory.status({ runId: 'zzzz' }).text, /no factory run zzzz/);
    await until(() => r.factory.children().length === 0);
  } finally { r.cleanup(); }
  const m = rig({ missing: true });
  try {
    const res = m.factory.dispatch({ skill: 'babysit-pr' }, m.ctx());
    assert.equal(res.ok, false);
    assert.match(res.text, /not installed on the bridge PC: not here/);
  } finally { m.cleanup(); }
});

test('shutdown: stop() then killAll ends the run and everything under it, marks it killed and delivers nothing', { skip: !POSIX }, async () => {
  const r = rig();
  try {
    const res = r.factory.dispatch({ skill: 'babysit-pr', args: '[[hang]]' }, r.ctx());
    assert.equal(res.ok, true, res.text);
    const call = await until(() => r.calls().find(c => c.prompt.includes('[[hang]]')));
    const kids = r.factory.children();
    assert.equal(kids.length, 1);
    r.factory.stop();
    assert.equal(r.factory.dispatch({ skill: 'babysit-pr' }, r.ctx()).ok, false, 'no new run while the bridge stops');
    await new Promise(resolve => PR.killAll(kids, { graceMs: 2000 }, resolve));
    const run = await until(() => r.factory.runs().find(x => x.status !== 'running'));
    assert.equal(run.status, 'killed');
    assert.throws(() => process.kill(call.pid, 0), 'the claude process is gone');
    assert.equal(r.done.length, 0, 'a run killed by shutdown is not reported as a result');
  } finally { r.cleanup(); }
});

test('a run past timeoutMs is ended and reported failed with the reason', { skip: !POSIX }, async () => {
  const r = rig();
  try {
    const res = r.factory.dispatch({ skill: 'babysit-pr', args: '[[hang]]' }, r.ctx(conf({ timeoutMs: 400 })));
    assert.equal(res.ok, true);
    const run = await until(() => r.factory.runs().find(x => x.status !== 'running'), 20000);
    assert.equal(run.status, 'failed');
    assert.match(run.why, /timeoutMs/);
    assert.equal(r.done.length, 1);
  } finally { r.cleanup(); }
});

test('a run left running by a stopped bridge is marked lost by the next one, and the run list stays bounded', () => {
  const r = rig();
  try {
    const file = path.join(r.dir, 'home', 'factory', 'runs.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const runs = Array.from({ length: F.KEEP_RUNS + 5 }, (_, i) => ({ id: (0x10000000 + i).toString(16), status: i === F.KEEP_RUNS + 4 ? 'running' : 'done', startedAt: 1, endedAt: 2, log: path.join(r.dir, `${i}.log`), skill: 'babysit-pr', args: '', model: 'opus' }));
    fs.writeFileSync(file, JSON.stringify({ runs }));
    const passive = F.createFactory({ dir: path.dirname(file), adopt: false, command: () => ({}), baseConfig: () => ({}), env: () => ({}) });
    assert.equal(passive.runs().at(-1).status, 'running', 'a bridge without the lock leaves the record alone');
    const next = F.createFactory({ dir: path.dirname(file), command: () => ({}), baseConfig: () => ({}), env: () => ({}) });
    const all = next.runs();
    assert.equal(all.length, F.KEEP_RUNS);
    assert.equal(all.at(-1).status, 'lost');
    assert.match(next.status({ runId: all.at(-1).id }).text, /lost/);
  } finally { r.cleanup(); }
});

test('joined grants: a factory run hello reaches the factory grants with no character check; goal grants and their tools stay apart', async () => {
  const goalCalls = [];
  const factoryCalls = [];
  const goals = GM.createRunGrants({ call: async (tool) => { goalCalls.push(tool); return { ok: true, text: 'goal' }; }, character: () => 'Bone-Forever' });
  const factory = GM.createRunGrants({ call: async (tool, args, ctx) => { factoryCalls.push([tool, ctx]); return { ok: true, text: 'factory' }; }, character: null, tools: F.TOOL_NAMES, serverName: F.SERVER_NAME, toolsLabel: 'factory' });
  const joined = GM.joinGrants([goals, factory]);
  const hello = (g, nonce = 'n1') => ({ type: GM.HELLO, run: g.id, nonce, proof: LP.proof(g.token, 'client', nonce) });
  const conn = () => ({ destroy() {} });
  const fg = factory.grant('#3', { key: 'k' });
  const gg = goals.grant('#4');
  assert.equal(joined.hello({ ...hello(fg), proof: LP.proof(gg.token, 'client', 'n1') }, conn()).run, undefined, 'another grant\'s token opens nothing');
  const fr = joined.hello(hello(fg), conn());
  assert.ok(fr.run);
  assert.match(joined.hello(hello(fg, 'n2'), conn()).why, /already had its one connection/);
  assert.equal(joined.hello({ type: GM.HELLO, run: 'f'.repeat(32), nonce: 'n', proof: 'x' }, conn()).why, 'no valid run grant');
  const ok = await joined.onCall(fr.run, { call: 1, tool: 'factory_status', args: {} });
  assert.equal(ok.ok, true);
  assert.deepEqual(factoryCalls, [['factory_status', { key: 'k' }]]);
  const crossed = await joined.onCall(fr.run, { call: 2, tool: 'goal_list', args: {} });
  assert.equal(crossed.ok, false, 'a factory grant never reaches the goal store');
  const gr = joined.hello(hello(gg), conn());
  const crossedBack = await joined.onCall(gr.run, { call: 3, tool: 'factory_dispatch', args: {} });
  assert.equal(crossedBack.ok, false, 'a goal grant never reaches the factory');
  assert.deepEqual(goalCalls, []);
  factory.revoke(fg.id);
  assert.equal((await joined.onCall(fr.run, { call: 4, tool: 'factory_status', args: {} })).ok, false, 'an ended run is refused');
});

test('factory-mcp lists only the dispatch and status tools with the configured skills', async () => {
  const lines = [];
  const out = { write(s) { for (const l of s.split('\n').filter(Boolean)) lines.push(JSON.parse(l)); } };
  const opts = F.parseArgs(['--socket', '/s', '--run', 'a'.repeat(32), '--skills', 'babysit-pr,Bad Name,fresh-eyes']);
  assert.deepEqual(opts.skills, ['babysit-pr', 'fresh-eyes']);
  assert.throws(() => F.parseArgs(['--rm']), /unknown option/);
  const server = GM.createServer({ stdout: out, socket: '', runId: '', token: '', spec: F.spec(opts.skills) });
  server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'goal_list', arguments: {} } });
  server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'factory_status', arguments: {} } });
  await until(() => lines.length === 3);
  const byId = id => lines.find(l => l.id === id).result;
  assert.deepEqual(byId(1).tools.map(t => t.name), ['factory_dispatch', 'factory_status']);
  assert.deepEqual(byId(1).tools[0].inputSchema.properties.skill.enum, ['babysit-pr', 'fresh-eyes']);
  assert.equal(byId(2).isError, true);
  assert.match(byId(3).content[0].text, /wowfactory was started without a run grant/);
  const launch = F.launchConfig({ runId: 'b'.repeat(32), token: 't', socket: '/s', skills: ['babysit-pr'] }).server;
  assert.deepEqual(launch.args.slice(-6), ['--socket', '/s', '--run', 'b'.repeat(32), '--skills', 'babysit-pr']);
  assert.ok(launch.args.some(a => a.endsWith(path.join('bridge', 'factory.js'))));
  assert.ok(!launch.args.includes('t'), 'the token is only in the env');
});

test('a run summary keeps a full merge report, not just its first lines', () => {
  const report = ['I merged 2 of the 3 approved AI PRs into internal.', ...Array.from({ length: 12 }, (_, k) => `- #${18600 + k}: merged`), 'Before each merge, the two required checks passed.'].join('\n');
  const summary = F.summaryOf(report);
  assert.equal(summary, report, 'every line of a normal report is kept');
  const near = Array.from({ length: 39 }, (_, k) => `${k} ${'y'.repeat(95)} https://github.com/o/r/pull/${1000 + k}`);
  const cut = F.summaryOf(near.join('\n'));
  assert.ok(!cut.endsWith('...') && cut.length < near.join('\n').length, 'past 4,000 characters the summary stops at a boundary');
  assert.equal(F.summarize(near.join('\n')).cut, true);
  const kept = cut.split('\n');
  assert.ok(kept.every(l => near.includes(l)), 'every kept line is whole, so no URL is cut into another number');
  const flood = Array.from({ length: 100 }, (_, k) => `line ${k}`).join('\n');
  assert.equal(F.summaryOf(flood).split('\n').length, 40, 'a flood is still capped');
});
