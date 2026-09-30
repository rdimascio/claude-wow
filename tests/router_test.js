'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RT = require('../bridge/router');
const F = require('./fixtures/router_input');

const KEY = 'ts-live-SECRET-0123456789';
const REGISTRY = RT.registryFor(F.projects);

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `router-${label}-`));
}

function answerBody(overrides = {}) {
  return {
    model: 'jev-1.13.0',
    answers: {
      route: { type: 'choice', choice: 'code', probabilities: { lore: 0.01, web: 0.01, code: 0.93, live: 0.02, game: 0.01, chat: 0.02 }, confidence: 0.88 },
      'lore.kind': { type: 'choice', choice: 'other', probabilities: { quest: 0.01, item: 0.01, npc: 0.01, zone: 0.01, 'class-spell': 0.01, profession: 0.01, other: 0.94 }, confidence: 0.9 },
      needs_fresh: { type: 'noul', noul: 0.04 },
      risky_edit: { type: 'noul', noul: 0.71 },
      'code.project': { type: 'choice', choice: 'wow-ai', probabilities: { 'wow-ai': 0.97, ellie: 0.01, none: 0.02 }, confidence: 0.95 },
      ...overrides,
    },
    usage: { input_tokens: 900, output_tokens: 60 },
  };
}

function okFetch(body, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => body };
  };
}

function statusFetch(status) {
  return async () => ({ ok: false, status, json: async () => ({ detail: 'nope' }) });
}

function hangingFetch() {
  return (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
}

test('the request matches the golden JSON: model, state and every question', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'router_request.json'), 'utf8'));
  assert.deepEqual(RT.buildRequest({ ...F.input, registry: REGISTRY }), golden);
});

test('the request has the six routes, the lore kinds, both nouls and the project choice with none', () => {
  const req = RT.buildRequest({ ...F.input, registry: REGISTRY });
  assert.equal(req.model, 'jev-latest');
  assert.deepEqual(Object.keys(req.questions.route.criteria), ['lore', 'web', 'code', 'live', 'game', 'chat']);
  assert.equal(req.questions.needs_fresh.type, 'noul');
  assert.equal(req.questions.risky_edit.type, 'noul');
  assert.deepEqual(Object.keys(req.questions['code.project'].criteria), ['wow-ai', 'ellie', 'none']);
  assert.ok(Object.values(req.questions.route.criteria).every(d => d.length > 40), 'each route has a clear description');
});

test('with no projects the request has no project question', () => {
  const req = RT.buildRequest({ ...F.input, registry: [] });
  assert.equal(req.questions['code.project'], undefined);
  assert.deepEqual(req.state.projects, []);
});

test('project names that repeat, or clash with none, get unique option keys', () => {
  const reg = RT.registryFor([
    { name: 'api', path: '/a/work/api', lastCommit: '2026-01-02' },
    { name: 'api', path: '/a/play/api', lastCommit: '2026-01-01' },
    { name: 'none', path: '/a/none', lastCommit: '2026-01-03' },
  ]);
  const keys = reg.map(p => p.key);
  assert.equal(new Set(keys).size, 3);
  assert.ok(!keys.includes('none'));
  assert.deepEqual(keys, ['none (a)', 'api', 'api (play)']);
});

test('the registry keeps the most recent projects up to the limit', () => {
  const many = Array.from({ length: RT.PROJECT_LIMIT + 5 }, (_, i) => ({ name: `p${i}`, path: `/p/${i}`, lastCommit: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }));
  const reg = RT.registryFor(many);
  assert.equal(reg.length, RT.PROJECT_LIMIT);
  assert.equal(reg[0].name, `p${RT.PROJECT_LIMIT + 4}`);
});

test('a full response parses into route, probabilities, confidence, project and nouls', () => {
  const r = RT.parseResponse(answerBody(), REGISTRY);
  assert.equal(r.route, 'code');
  assert.equal(r.confidence, 0.88);
  assert.equal(r.probabilities.code, 0.93);
  assert.deepEqual(r.project, { name: 'wow-ai', path: '/u/wow-ai', probability: 0.97 });
  assert.equal(r.loreKind, 'other');
  assert.equal(r.needsFresh, 0.04);
  assert.equal(r.riskyEdit, 0.71);
  assert.equal(r.model, 'jev-1.13.0');
});

test('a response picking none has no project path', () => {
  const r = RT.parseResponse(answerBody({ 'code.project': { type: 'choice', choice: 'none', probabilities: { 'wow-ai': 0.1, ellie: 0.1, none: 0.8 }, confidence: 0.6 } }), REGISTRY);
  assert.deepEqual(r.project, { name: 'none', path: '', probability: 0.8 });
});

test('responses with a missing, unknown or malformed route are rejected', () => {
  assert.equal(RT.parseResponse(null, REGISTRY), null);
  assert.equal(RT.parseResponse({}, REGISTRY), null);
  assert.equal(RT.parseResponse(answerBody({ route: undefined }), REGISTRY), null);
  assert.equal(RT.parseResponse(answerBody({ route: { type: 'choice', choice: 'music', probabilities: {}, confidence: 1 } }), REGISTRY), null);
  assert.equal(RT.parseResponse(answerBody({ route: { type: 'choice', choice: 'code', probabilities: { code: 'x' }, confidence: 1 } }), REGISTRY), null);
  assert.equal(RT.parseResponse(answerBody({ route: { type: 'noul', noul: 0.5 } }), REGISTRY), null);
});

test('a bad secondary answer drops that field only', () => {
  const r = RT.parseResponse(answerBody({ needs_fresh: { type: 'noul', noul: 'high' }, 'code.project': { type: 'choice', choice: 'zzz', probabilities: {}, confidence: 1 } }), REGISTRY);
  assert.equal(r.route, 'code');
  assert.equal(r.needsFresh, null);
  assert.equal(r.project, null);
});

test('classify posts once to the endpoint with the bearer key and returns the parsed answer', async () => {
  const calls = [];
  let t = 1000;
  const r = await RT.classify({ ...F.input, registry: REGISTRY }, { key: KEY, fetchImpl: okFetch(answerBody(), calls), now: () => (t += 150) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), RT.buildRequest({ ...F.input, registry: REGISTRY }));
  assert.equal(r.route, 'code');
  assert.equal(r.fallback, '');
  assert.equal(r.latencyMs, 150);
});

for (const status of [401, 422, 429, 529, 500]) {
  test(`HTTP ${status} falls back to chat with the reason`, async () => {
    const r = await RT.classify({ ...F.input, registry: REGISTRY }, { key: KEY, fetchImpl: statusFetch(status) });
    assert.equal(r.route, 'chat');
    assert.equal(r.fallback, `http-${status}`);
    assert.equal(r.confidence, null);
  });
}

test('a call slower than the timeout is aborted and falls back to chat', async () => {
  const started = Date.now();
  const r = await RT.classify({ ...F.input, registry: REGISTRY }, { key: KEY, fetchImpl: hangingFetch(), timeoutMs: 40 });
  assert.equal(r.route, 'chat');
  assert.equal(r.fallback, 'timeout');
  assert.ok(Date.now() - started < 1000);
});

test('the default timeout is 800 ms', () => {
  assert.equal(RT.TIMEOUT_MS, 800);
});

test('a network error, a bad JSON body, an invalid answer, no key and no fetch all fall back without throwing', async () => {
  const input = { ...F.input, registry: REGISTRY };
  const network = await RT.classify(input, { key: KEY, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(network.fallback, 'network');
  const badJson = await RT.classify(input, { key: KEY, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }) });
  assert.equal(badJson.fallback, 'network');
  const invalid = await RT.classify(input, { key: KEY, fetchImpl: okFetch({ answers: {} }) });
  assert.equal(invalid.fallback, 'invalid-response');
  const noKey = await RT.classify(input, { key: '', fetchImpl: okFetch(answerBody()) });
  assert.equal(noKey.fallback, 'no-key');
  const noFetch = await RT.classify(input, { key: KEY, fetchImpl: null });
  assert.equal(noFetch.fallback, 'no-fetch');
  for (const r of [network, badJson, invalid, noKey, noFetch]) assert.equal(r.route, 'chat');
});

test('policy: thresholds pick run, run with a notice, or chat; risky edits start the code agent in default mode', () => {
  const base = { route: 'code', fallback: '', riskyEdit: 0.1 };
  assert.deepEqual(RT.decide({ ...base, confidence: 0.9 }), { action: 'run', route: 'code', why: '', permissionMode: 'acceptEdits' });
  assert.equal(RT.decide({ ...base, confidence: 0.85 }).action, 'run');
  assert.equal(RT.decide({ ...base, confidence: 0.7 }).action, 'run-notice');
  assert.equal(RT.decide({ ...base, confidence: 0.6 }).action, 'run-notice');
  assert.deepEqual(RT.decide({ ...base, confidence: 0.59 }), { action: 'chat', route: 'chat', why: 'low-confidence' });
  assert.equal(RT.decide({ ...base, confidence: 0.9, riskyEdit: 0.5 }).permissionMode, 'default');
  assert.equal(RT.decide({ route: 'lore', fallback: '', confidence: 0.99 }).permissionMode, undefined);
  assert.deepEqual(RT.decide({ route: 'chat', fallback: 'timeout' }), { action: 'chat', route: 'chat', why: 'timeout' });
});

test('explicit input bypasses the router: -r, a live session, CLI flags, --agent, chat settings, an address, a folder, a config command', () => {
  const bare = { id: 1, chat: 'c', text: 'hello', cwd: '' };
  assert.equal(RT.explicitReason(bare, { plugin: 'ask', why: 'default' }), '');
  assert.equal(RT.explicitReason({ ...bare, resume: 'abcd1234' }), 'resume');
  assert.equal(RT.explicitReason({ ...bare, liveTarget: 'work' }), 'live');
  assert.equal(RT.explicitReason({ ...bare, cli: true }), 'cli-flags');
  assert.equal(RT.explicitReason({ ...bare, agent: 'codex' }), 'agent');
  assert.equal(RT.explicitReason({ ...bare, kind: 'roast' }), 'kind');
  assert.equal(RT.explicitReason({ ...bare, model: 'opus' }), 'chat-settings');
  assert.equal(RT.explicitReason({ ...bare, addDirs: ['/x'] }), 'chat-settings');
  assert.equal(RT.explicitReason(bare, { plugin: 'ask', why: 'addressed' }), 'addressed');
  assert.equal(RT.explicitReason({ ...bare, plugin: 'live' }, { plugin: 'live', why: 'bound' }), 'live');
  assert.equal(RT.explicitReason({ ...bare, plugin: 'claude-code' }, { plugin: 'claude-code', why: 'bound' }), '', 'a plugin pin without a folder is not a folder binding');
  assert.equal(RT.explicitReason({ ...bare, cwd: 'realms' }), 'folder');
  assert.equal(RT.explicitReason({ ...bare, text: '/claude config vision on' }), 'config-command');
  assert.equal(RT.explicitReason({ ...bare, text: '/claude-wow config' }), 'config-command');
  assert.equal(RT.explicitReason({ ...bare, text: 'how do I configure my ui' }), '');
});

test('mode: shadow by default with a key, off without one, execute is reserved and runs as shadow', () => {
  assert.equal(RT.resolveMode({}, true).mode, 'shadow');
  assert.equal(RT.resolveMode({}, false).mode, 'off');
  assert.equal(RT.resolveMode({ mode: 'off' }, true).mode, 'off');
  const ex = RT.resolveMode({ mode: 'execute' }, true);
  assert.equal(ex.mode, 'shadow');
  assert.equal(ex.requested, 'execute');
  assert.match(ex.reason, /reserved/);
  assert.equal(RT.resolveMode({ mode: 'bogus' }, true).mode, 'shadow');
});

test('the key: TYPESAFE_API_KEY wins, then the Keychain item, which router.keychain can change', async () => {
  const calls = [];
  const run = (cmd, args, opts, cb) => { calls.push([cmd, ...args]); cb(null, `${KEY}\n`, ''); };
  const env = await RT.readKey({ env: { TYPESAFE_API_KEY: ` ${KEY} ` }, platform: 'darwin', run });
  assert.deepEqual(env, { key: KEY, source: 'TYPESAFE_API_KEY' });
  assert.equal(calls.length, 0);
  const kc = await RT.readKey({ env: {}, platform: 'darwin', run });
  assert.deepEqual(kc, { key: KEY, source: 'keychain org.ellie.assistant/decision.typesafe' });
  assert.deepEqual(calls[0], ['security', 'find-generic-password', '-s', 'org.ellie.assistant', '-a', 'decision.typesafe', '-w']);
  await RT.readKey({ env: {}, platform: 'darwin', run, routerCfg: { keychain: 'claude-wow/typesafe' } });
  assert.deepEqual(calls[1].slice(2, 6), ['-s', 'claude-wow', '-a', 'typesafe']);
  await RT.readKey({ env: {}, platform: 'darwin', run, routerCfg: { keychain: { service: 'svc', account: 'acct' } } });
  assert.deepEqual(calls[2].slice(2, 6), ['-s', 'svc', '-a', 'acct']);
});

test('Keychain failures come back as a reason, never as a throw or the key', async () => {
  const fail = (err, stderr = '') => (cmd, args, opts, cb) => cb(err, '', stderr);
  const missing = await RT.readKey({ env: {}, platform: 'darwin', run: fail(Object.assign(new Error('x'), { code: 44 })) });
  assert.match(missing.error, /not found/);
  const killed = await RT.readKey({ env: {}, platform: 'darwin', run: fail(Object.assign(new Error('x'), { killed: true })) });
  assert.match(killed.error, /timed out/);
  const other = await RT.readKey({ env: {}, platform: 'darwin', run: fail(Object.assign(new Error('x'), { code: 51 }), 'security: SecKeychainSearchCopyNext: User interaction is not allowed.\n') });
  assert.match(other.error, /User interaction is not allowed/);
  const thrown = await RT.readKey({ env: {}, platform: 'darwin', run: () => { throw Object.assign(new Error('spawn'), { code: 'ENOENT' }); } });
  assert.match(thrown.error, /not found/);
  const linux = await RT.readKey({ env: {}, platform: 'linux', run: () => assert.fail('no security on linux') });
  assert.match(linux.error, /TYPESAFE_API_KEY/);
  for (const r of [missing, killed, other, thrown, linux]) assert.equal(r.key, '');
});

function makeRouter(dir, opts = {}) {
  const lines = [];
  const router = RT.createRouter({
    config: opts.config || {},
    env: { TYPESAFE_API_KEY: KEY },
    platform: 'darwin',
    logFile: path.join(dir, 'router.jsonl'),
    log: (...parts) => lines.push(parts.join(' ')),
    fetchImpl: opts.fetchImpl || okFetch(answerBody()),
    loadProjects: () => F.projects,
    ...opts.extra,
  });
  return { router, lines, file: path.join(dir, 'router.jsonl') };
}

test('shadow mode writes one JSON line per routed message with the decision and the path actually taken', async () => {
  const dir = tmpDir('shadow');
  const { router, file } = makeRouter(dir);
  await router.init();
  assert.equal(router.mode, 'shadow');
  const job = { id: 7, chat: 'chat1', text: 'fix the failing test in wow-ai', cwd: '' };
  await router.observe(job, { context: 'Zone: Durotar', taken: { plugin: 'ask', why: 'default' } });
  const rows = RT.readLog(file);
  assert.equal(rows.length, 1);
  const e = rows[0];
  assert.equal(e.chat, 'chat1');
  assert.equal(e.id, 7);
  assert.equal(e.msg.hash, RT.hashText(job.text));
  assert.equal(e.msg.head, job.text);
  assert.equal(e.route, 'code');
  assert.equal(e.confidence, 0.88);
  assert.equal(e.probabilities.code, 0.93);
  assert.equal(e.project, 'wow-ai');
  assert.equal(e.projectProbability, 0.97);
  assert.equal(e.needsFresh, 0.04);
  assert.equal(e.riskyEdit, 0.71);
  assert.equal(e.decision, 'run');
  assert.equal(e.permissionMode, 'default');
  assert.equal(e.fallback, null);
  assert.ok(Number.isFinite(e.latencyMs));
  assert.deepEqual(e.taken, { plugin: 'ask', why: 'default' });
  assert.equal(e.mode, 'shadow');
  assert.ok(!Number.isNaN(Date.parse(e.t)));
});

test('the log keeps only the first 80 characters of the message', async () => {
  const dir = tmpDir('head');
  const { router, file } = makeRouter(dir);
  await router.init();
  const text = 'x'.repeat(200);
  await router.observe({ id: 1, chat: 'c', text, cwd: '' }, { taken: { plugin: 'ask', why: 'default' } });
  const e = RT.readLog(file)[0];
  assert.equal(e.msg.head.length, 80);
  assert.equal(e.msg.hash.length, 16);
});

test('the router remembers the previous route per chat and sends it with the next message', async () => {
  const dir = tmpDir('prev');
  const calls = [];
  const { router } = makeRouter(dir, { fetchImpl: okFetch(answerBody(), calls) });
  await router.init();
  await router.observe({ id: 1, chat: 'c', text: 'a', cwd: '' }, { taken: { plugin: 'ask', why: 'default' }, folder: '/u/wow-ai' });
  await router.observe({ id: 2, chat: 'c', text: 'b', cwd: '' }, { taken: { plugin: 'ask', why: 'default' } });
  const second = JSON.parse(calls[1].init.body);
  assert.deepEqual(second.state.previous, { route: 'code', folder: '/u/wow-ai' });
});

test('explicit input makes no call and writes no line', async () => {
  const dir = tmpDir('explicit');
  const calls = [];
  const { router, file } = makeRouter(dir, { fetchImpl: okFetch(answerBody(), calls) });
  await router.init();
  const r = await router.observe({ id: 1, chat: 'c', text: 'go', cwd: '', resume: 'abcd1234' }, { taken: { plugin: 'claude-code', why: 'bound' } });
  assert.deepEqual(r, { skipped: 'resume' });
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(file), false);
});

test('a fallback is logged with its reason and a chat decision', async () => {
  const dir = tmpDir('fallback');
  const { router, file } = makeRouter(dir, { fetchImpl: statusFetch(429) });
  await router.init();
  await router.observe({ id: 1, chat: 'c', text: 'hi', cwd: '' }, { taken: { plugin: 'ask', why: 'default' } });
  const e = RT.readLog(file)[0];
  assert.equal(e.route, 'chat');
  assert.equal(e.fallback, 'http-429');
  assert.equal(e.decision, 'chat');
});

test('router.mode execute is logged as shadow with a note', async () => {
  const dir = tmpDir('execute');
  const { router, file, lines } = makeRouter(dir, { config: { mode: 'execute' } });
  await router.init();
  assert.equal(router.mode, 'shadow');
  assert.ok(lines.some(l => /execute is reserved/.test(l)));
  await router.observe({ id: 1, chat: 'c', text: 'hi', cwd: '' }, { taken: { plugin: 'ask', why: 'default' } });
  assert.match(RT.readLog(file)[0].note, /execute is reserved; logged as shadow/);
});

test('no key: the router is off, says so in one line, and never calls out', async () => {
  const dir = tmpDir('nokey');
  const lines = [];
  const calls = [];
  const router = RT.createRouter({ config: {}, env: {}, platform: 'darwin', logFile: path.join(dir, 'router.jsonl'), log: l => lines.push(l), fetchImpl: okFetch(answerBody(), calls), run: (cmd, args, opts, cb) => cb(Object.assign(new Error('x'), { code: 44 }), '', '') });
  await router.init();
  assert.equal(router.mode, 'off');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /router: off, no TypeSafe key/);
  assert.equal(await router.observe({ id: 1, chat: 'c', text: 'hi', cwd: '' }, {}), null);
  assert.equal(calls.length, 0);
});

test('router.mode off never reads the Keychain', async () => {
  const router = RT.createRouter({ config: { mode: 'off' }, env: {}, platform: 'darwin', run: () => assert.fail('the Keychain was read'), log: () => {} });
  await router.init();
  assert.equal(router.mode, 'off');
});

test('a broken job or log folder never throws into the message path', async () => {
  const dir = tmpDir('broken');
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  const { router, lines } = makeRouter(dir, { extra: { logFile: path.join(blocker, 'router.jsonl') } });
  await router.init();
  const r = await router.observe({ id: 1, chat: 'c', text: 'hi', cwd: '' }, { taken: { plugin: 'ask', why: 'default' } });
  assert.ok(r && r.entry);
  assert.ok(lines.some(l => /cannot write/.test(l)));
  assert.deepEqual(await router.observe(null, {}), { skipped: 'no-job' });
});

test('the key never appears in the shadow log, the bridge log or a result', async () => {
  const dir = tmpDir('secret');
  const { router, file, lines } = makeRouter(dir);
  await router.init();
  const ok = await router.observe({ id: 1, chat: 'c', text: 'fix it', cwd: '' }, { taken: { plugin: 'ask', why: 'default' } });
  const bad = RT.createRouter({ config: {}, env: { TYPESAFE_API_KEY: KEY }, platform: 'darwin', logFile: file, log: l => lines.push(l), fetchImpl: statusFetch(401) });
  await bad.init();
  const fb = await bad.observe({ id: 2, chat: 'c', text: 'x', cwd: '' }, { taken: { plugin: 'ask', why: 'default' } });
  const everything = [fs.readFileSync(file, 'utf8'), lines.join('\n'), JSON.stringify(ok), JSON.stringify(fb), router.status, bad.status].join('\n');
  assert.ok(!everything.includes(KEY), 'the key leaked');
  assert.ok(!everything.includes('SECRET'), 'part of the key leaked');
});

test('report math: route mix, confidence histogram, nearest-rank p50/p95, fallback rate and path changes', () => {
  const t = '2026-09-29T10:00:00.000Z';
  const row = (route, confidence, latencyMs, extra = {}) => ({ t, route, confidence, latencyMs, fallback: null, decision: confidence >= 0.85 ? 'run' : confidence >= 0.6 ? 'run-notice' : 'chat', wouldRoute: confidence >= 0.6 ? route : 'chat', taken: { plugin: 'ask', why: 'default' }, ...extra });
  const entries = [
    row('code', 0.97, 100),
    row('code', 0.9, 200),
    row('lore', 0.7, 300),
    row('chat', 0.5, 400),
    row('game', 0.96, 500),
    row('live', 0.88, 600),
    row('web', 0.62, 700),
    row('chat', null, 800, { fallback: 'timeout', decision: 'chat', wouldRoute: 'chat' }),
    row('chat', null, 50, { fallback: 'http-429', decision: 'chat', wouldRoute: 'chat' }),
    row('chat', 0.99, 900),
  ];
  const s = RT.summarize(entries);
  assert.equal(s.count, 10);
  assert.deepEqual(s.routes, { code: 2, lore: 1, chat: 4, game: 1, live: 1, web: 1 });
  assert.deepEqual(s.histogram.map(b => b.count), [1, 2, 2, 3]);
  assert.equal(s.p50, 500);
  assert.equal(s.p95, 900);
  assert.equal(s.fallbacks, 2);
  assert.equal(s.fallbackRate, 0.2);
  assert.deepEqual(s.reasons, { timeout: 1, 'http-429': 1 });
  assert.equal(s.changed, 3);
  const text = RT.formatReport(s);
  assert.match(text, /10 routed message/);
  assert.match(text, /p50 500 ms, p95 900 ms/);
  assert.match(text, /fallback 2 \(20%\): timeout 1, http-429 1/);
  assert.match(text, /would change the path taken: 3 \(30%\)/);
});

test('report: --since filters by time and an empty log says so', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const since = RT.parseSince('24h', now);
  assert.equal(since, now - 24 * 3600 * 1000);
  assert.equal(RT.parseSince('2d', now), now - 48 * 3600 * 1000);
  assert.equal(RT.parseSince('', now), 0);
  const s = RT.summarize([{ t: '2026-09-27T00:00:00Z', route: 'chat' }, { t: '2026-09-29T11:00:00Z', route: 'code', confidence: 0.9, latencyMs: 10 }], { since });
  assert.equal(s.count, 1);
  assert.match(RT.formatReport(RT.summarize([])), /no routed messages/);
});

test('percentile uses nearest rank', () => {
  assert.equal(RT.percentile([], 0.5), null);
  assert.equal(RT.percentile([5], 0.95), 5);
  assert.equal(RT.percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(RT.percentile([1, 2, 3, 4], 0.95), 4);
});

test('the report command reads router.jsonl from CLAUDE_WOW_HOME', () => {
  const dir = tmpDir('cli');
  const file = path.join(dir, 'router.jsonl');
  fs.writeFileSync(file, JSON.stringify({ t: new Date().toISOString(), route: 'code', confidence: 0.9, latencyMs: 120, fallback: null, decision: 'run', wouldRoute: 'code', taken: { plugin: 'claude-code' } }) + '\nnot json\n');
  const out = [];
  RT.main(['--file', file], l => out.push(l));
  assert.match(out[0], /1 routed message/);
  const json = [];
  RT.main(['--file', file, '--json', '--since', '24h'], l => json.push(l));
  assert.equal(JSON.parse(json[0]).count, 1);
});
