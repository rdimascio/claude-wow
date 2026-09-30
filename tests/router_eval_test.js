'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RT = require('../bridge/router');
const S = require('../evals/router/score');
const E = require('../evals/router/run');

const REGISTRY = E.loadRegistry();
const CASES = E.loadCases();

function mkCase(id, route, o = {}) {
  const expected = { route, project: o.project || 'none', needs_fresh: !!o.fresh, risky_edit: !!o.risky };
  if (route === 'lore') expected.lore_kind = o.kind || 'other';
  return { id, text: o.text || `text ${id}`, context: '', previous: { route: '', folder: '' }, expected, why: 'test', difficulty: o.difficulty || 'easy', also_ok_projects: o.ok };
}

function mkResult(route, confidence, o = {}) {
  const probabilities = {};
  for (const r of S.ROUTE_NAMES) probabilities[r] = 0;
  probabilities[route] = confidence;
  return {
    route,
    probabilities,
    confidence,
    project: o.project ? { name: o.project, path: '', probability: 0.9 } : { name: 'none', path: '', probability: 0.9 },
    loreKind: o.kind || null,
    needsFresh: o.fresh === undefined ? 0.1 : o.fresh,
    riskyEdit: o.risky === undefined ? 0.1 : o.risky,
    latencyMs: o.latency === undefined ? 100 : o.latency,
    fallback: o.fallback || '',
    model: 'jev-1.13.0',
  };
}

function fallback(reason, latency = 0) {
  return { route: 'chat', fallback: reason, latencyMs: latency, probabilities: null, confidence: null, project: null, loreKind: null, needsFresh: null, riskyEdit: null, model: '' };
}

function row(c, r, usage = []) {
  return { case: c, result: r, attempts: 1, usage };
}

test('the case set is valid, large enough and covers every route, lore kind and difficulty', () => {
  assert.deepEqual(E.validateCases(CASES, REGISTRY), []);
  assert.ok(CASES.length >= 150, `${CASES.length} cases`);
  for (const r of S.ROUTE_NAMES) assert.ok(CASES.some(c => c.expected.route === r), `route ${r}`);
  for (const k of S.LORE_KIND_NAMES) assert.ok(CASES.some(c => c.expected.lore_kind === k), `lore kind ${k}`);
  for (const d of S.DIFFICULTIES) assert.ok(CASES.some(c => c.difficulty === d), `difficulty ${d}`);
  for (const p of REGISTRY) assert.ok(CASES.some(c => c.expected.route === 'code' && c.expected.project === p.key) || p.key.startsWith('ellie-'), `project ${p.key}`);
  assert.ok(CASES.some(c => c.expected.route === 'code' && c.expected.project === 'none'));
});

test('the project fixture carries no paths or remotes', () => {
  const data = JSON.parse(fs.readFileSync(E.DEFAULT_PROJECTS, 'utf8'));
  for (const p of data.projects) {
    assert.deepEqual(Object.keys(p).sort(), ['aliases', 'lastCommit', 'name', 'readme']);
  }
  assert.doesNotMatch(JSON.stringify(data), /\/Users\/|github\.com|git@/);
});

test('validation rejects unknown routes, unknown projects and secret-looking text', () => {
  const bad = [
    mkCase('x1', 'teleport'),
    mkCase('x2', 'code', { project: 'not-a-repo' }),
    mkCase('x3', 'chat', { text: 'my token is ghp_abcdefghijklmnop1234' }),
    mkCase('x4', 'chat', { text: 'mail me at someone@example.com' }),
    mkCase('x4', 'lore'),
  ];
  delete bad[4].expected.lore_kind;
  const errors = E.validateCases(bad, REGISTRY).join('\n');
  assert.match(errors, /x1: unknown route teleport/);
  assert.match(errors, /x2: project not-a-repo is not in the registry/);
  assert.match(errors, /x3: looks like a secret/);
  assert.match(errors, /x4: looks like a secret/);
  assert.match(errors, /x4: duplicate id/);
  assert.match(errors, /x4: lore case needs a lore_kind/);
});

test('confusion matrix, precision and recall', () => {
  const rows = [
    row(mkCase('a', 'code', { project: 'wow-ai' }), mkResult('code', 0.9, { project: 'wow-ai' })),
    row(mkCase('b', 'code', { project: 'every' }), mkResult('code', 0.8, { project: 'wow-ai' })),
    row(mkCase('c', 'code', { project: 'every' }), mkResult('chat', 0.7)),
    row(mkCase('d', 'chat'), mkResult('code', 0.6)),
    row(mkCase('e', 'lore', { kind: 'npc' }), mkResult('lore', 0.95, { kind: 'npc' })),
    row(mkCase('f', 'lore', { kind: 'zone' }), mkResult('lore', 0.95, { kind: 'npc' })),
  ];
  const s = S.score(rows);
  assert.equal(s.route.matrix.code.code, 2);
  assert.equal(s.route.matrix.code.chat, 1);
  assert.equal(s.route.matrix.chat.code, 1);
  assert.deepEqual(s.route.perRoute.code, { support: 3, predicted: 3, tp: 2, precision: 0.6667, recall: 0.6667, f1: 0.6667 });
  assert.deepEqual(s.route.perRoute.chat, { support: 1, predicted: 1, tp: 0, precision: 0, recall: 0, f1: null });
  assert.equal(s.route.perRoute.web.precision, null);
  assert.equal(s.route.accuracy, 0.6667);
  assert.equal(s.project.codeCases, 3);
  assert.equal(s.project.accuracyStrict, 0.3333);
  assert.equal(s.loreKind.accuracy, 0.5);
  assert.deepEqual(s.wrongCases.map(w => [w.id, w.wrong.join(',')]), [['b', 'project'], ['c', 'route,project'], ['d', 'route'], ['f', 'lore_kind']]);
});

test('lenient project accuracy accepts listed clones', () => {
  const c = mkCase('a', 'code', { project: 'ellie', ok: ['ellie-final-main-artifact'] });
  const s = S.score([row(c, mkResult('code', 0.9, { project: 'ellie-final-main-artifact' }))]);
  assert.equal(s.project.accuracyStrict, 0);
  assert.equal(s.project.accuracyLenient, 1);
  assert.equal(s.wrongCases.length, 0);
});

test('AUROC counts ties as half and needs both classes', () => {
  assert.equal(S.auroc([{ p: 0.9, label: true }, { p: 0.6, label: true }, { p: 0.6, label: false }, { p: 0.1, label: false }]), 0.875);
  assert.equal(S.auroc([{ p: 0.1, label: true }, { p: 0.9, label: false }]), 0);
  assert.equal(S.auroc([{ p: 0.9, label: true }]), null);
});

test('noul metrics at 0.5 with Brier score and missing values', () => {
  const rows = [
    row(mkCase('a', 'code', { risky: true }), mkResult('code', 0.9, { risky: 0.8 })),
    row(mkCase('b', 'code', { risky: true }), mkResult('code', 0.9, { risky: 0.4 })),
    row(mkCase('c', 'code'), mkResult('code', 0.9, { risky: 0.6 })),
    row(mkCase('d', 'code'), mkResult('code', 0.9, { risky: 0.2 })),
    row(mkCase('e', 'code'), fallback('timeout', 800)),
  ];
  const m = S.noulMetrics(rows, 'risky_edit', 'riskyEdit');
  assert.equal(m.n, 4);
  assert.equal(m.missing, 1);
  assert.deepEqual(m.counts, { tp: 1, fp: 1, fn: 1, tn: 1 });
  assert.equal(m.accuracyAt05, 0.5);
  assert.equal(m.auroc, 0.75);
  assert.equal(m.brier, 0.2);
  const s = S.score(rows);
  assert.equal(s.riskyOnCode.missedAt05, 1);
  assert.deepEqual(s.riskyOnCode.missedIds, ['b']);
  assert.equal(s.currentPolicy.riskyCodeRunInAcceptEdits, 1);
});

test('route calibration buckets and ECE', () => {
  const rows = [
    row(mkCase('a', 'code'), mkResult('code', 0.97)),
    row(mkCase('b', 'code'), mkResult('code', 0.97)),
    row(mkCase('c', 'code'), mkResult('chat', 0.55)),
    row(mkCase('d', 'chat'), mkResult('chat', 0.55)),
  ];
  const s = S.score(rows);
  const top = s.calibration.buckets.find(b => b.bucket === '0.95-1.00');
  const mid = s.calibration.buckets.find(b => b.bucket === '0.50-0.60');
  assert.deepEqual([top.n, top.meanValue, top.observed], [2, 0.97, 1]);
  assert.deepEqual([mid.n, mid.meanValue, mid.observed], [2, 0.55, 0.5]);
  assert.equal(s.calibration.ece, 0.04);
});

test('latency percentiles skip non-timeout fallbacks, and fallbacks count as chat', () => {
  const rows = [];
  for (let i = 1; i <= 10; i++) rows.push(row(mkCase(`l${i}`, 'chat'), mkResult('chat', 0.9, { latency: i * 100 })));
  rows.push(row(mkCase('t', 'chat'), fallback('timeout', 800)));
  rows.push(row(mkCase('h', 'code'), fallback('http-500', 5)));
  const s = S.score(rows);
  assert.equal(s.latency.n, 11);
  assert.equal(s.latency.p50, 600);
  assert.equal(s.latency.p95, 1000);
  assert.equal(s.latency.p99, 1000);
  assert.deepEqual(s.fallback, { count: 2, rate: 0.1667, reasons: { timeout: 1, 'http-500': 1 } });
  assert.equal(s.route.accuracy, 0.9167);
  assert.equal(s.route.accuracyAnswered, 1);
});

test('applyTimeout turns slow answers into timeout fallbacks', () => {
  const rows = [row(mkCase('a', 'code'), mkResult('code', 0.9, { latency: 900 })), row(mkCase('b', 'code'), mkResult('code', 0.9, { latency: 700 }))];
  const capped = S.applyTimeout(rows, 800);
  assert.equal(capped[0].result.fallback, 'timeout');
  assert.equal(capped[0].result.route, 'chat');
  assert.equal(capped[1].result.fallback, '');
  assert.equal(S.score(capped).route.accuracy, 0.5);
});

test('the threshold recommender keeps wrong runs at or under 5% per route', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(row(mkCase(`ok${i}`, 'code'), mkResult('code', 0.9 + (i % 10) / 100)));
  rows.push(row(mkCase('w1', 'chat'), mkResult('code', 0.95)));
  for (let i = 0; i < 5; i++) rows.push(row(mkCase(`lo${i}`, 'lore'), mkResult('code', 0.7)));
  for (let i = 0; i < 3; i++) rows.push(row(mkCase(`g${i}`, 'game'), mkResult('game', 0.8)));
  rows.push(row(mkCase('g3', 'chat'), mkResult('game', 0.99)));
  rows.push(row(mkCase('c1', 'chat'), mkResult('chat', 0.5)));
  rows.push(row(mkCase('f1', 'live'), fallback('timeout', 800)));
  const th = S.recommendThresholds(rows);
  assert.equal(th.perRoute.code.threshold, 0.9);
  assert.equal(th.perRoute.code.executed, 41);
  assert.equal(th.perRoute.code.wrongExecuted, 1);
  assert.equal(th.perRoute.code.fallback, 5);
  assert.equal(th.perRoute.code.note, '');
  assert.ok(th.perRoute.code.wrongRateUpper95 > th.perRoute.code.wrongRate);
  assert.equal(th.perRoute.game.threshold, null);
  assert.equal(th.perRoute.game.fallback, 4);
  assert.equal(th.perRoute.lore.note, 'never predicted');
  assert.equal(th.perRoute.chat.threshold, 0);
  assert.deepEqual(th.overall, { total: 52, executedNonChat: 41, wrongExecuted: 1, wrongExecutedRate: 0.0244, fellBackToChat: 10, fellBackRate: 0.1923, fellBackWhereChatWasRight: 1 });
});

test('the recommender flags thresholds that rest on too few runs', () => {
  const rows = [row(mkCase('a', 'web'), mkResult('web', 0.9)), row(mkCase('b', 'web'), mkResult('web', 0.8))];
  const th = S.recommendThresholds(rows);
  assert.equal(th.perRoute.web.threshold, 0.8);
  assert.match(th.perRoute.web.note, /only 2 executed/);
});

test('cost uses the input-token price and falls back to token totals for an unknown model', () => {
  const priced = S.costOf([{ usage: [{ input_tokens: 600000, output_tokens: 50, model: 'jev-1.13.0' }] }, { usage: [{ input_tokens: 400000, output_tokens: 50, model: 'jev-1.13.0' }] }]);
  assert.equal(priced.usd, 0.042);
  assert.equal(priced.usdPerMessage, 0.021);
  assert.equal(priced.inputTokens, 1000000);
  const unknown = S.costOf([{ usage: [{ input_tokens: 10, output_tokens: 2, model: 'jev-9' }] }]);
  assert.equal(unknown.usd, null);
  assert.match(unknown.note, /no price known for jev-9/);
});

function answerBody(route = 'code') {
  const probs = {};
  for (const r of S.ROUTE_NAMES) probs[r] = r === route ? 0.95 : 0.01;
  return {
    model: 'jev-1.13.0',
    answers: {
      route: { type: 'choice', choice: route, probabilities: probs, confidence: 0.94 },
      'lore.kind': { type: 'choice', choice: 'other', probabilities: Object.fromEntries(S.LORE_KIND_NAMES.map(k => [k, k === 'other' ? 0.94 : 0.01])), confidence: 0.9 },
      needs_fresh: { type: 'noul', noul: 0.05 },
      risky_edit: { type: 'noul', noul: 0.8 },
      'code.project': { type: 'choice', choice: 'wow-ai', probabilities: Object.fromEntries([...REGISTRY.map(p => p.key), 'none'].map(k => [k, k === 'wow-ai' ? 0.96 : 0.01])), confidence: 0.95 },
    },
    usage: { input_tokens: 1200, output_tokens: 40 },
  };
}

function headers(map = {}) {
  return { get: k => (k in map ? map[k] : null) };
}

test('classifyWithRetry retries 429 and 529, honours retry-after and records usage', async () => {
  const replies = [
    { ok: false, status: 429, headers: headers({ 'retry-after': '2' }), json: async () => ({}) },
    { ok: false, status: 529, headers: headers(), json: async () => ({}) },
    { ok: true, status: 200, headers: headers(), json: async () => answerBody() },
  ];
  const calls = [];
  const sleeps = [];
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body)); return replies.shift(); };
  const input = E.inputFor(mkCase('a', 'code'), REGISTRY);
  const out = await E.classifyWithRetry(input, { key: 'k', fetchImpl, sleep: async ms => { sleeps.push(ms); } });
  assert.equal(out.attempts, 3);
  assert.deepEqual(sleeps, [2000, 1000]);
  assert.equal(out.result.route, 'code');
  assert.equal(out.result.project.name, 'wow-ai');
  assert.deepEqual(out.usage, [{ input_tokens: 1200, output_tokens: 40, model: 'jev-1.13.0' }]);
  assert.equal(calls.length, 3);
  assert.deepEqual(Object.keys(calls[0].questions).sort(), ['code.project', 'lore.kind', 'needs_fresh', 'risky_edit', 'route']);
});

test('classifyWithRetry does not retry other failures and stops at the attempt cap', async () => {
  let n = 0;
  const once = await E.classifyWithRetry(E.inputFor(mkCase('a', 'code'), REGISTRY), { key: 'k', fetchImpl: async () => { n++; return { ok: false, status: 401, headers: headers() }; }, sleep: async () => {} });
  assert.equal(once.attempts, 1);
  assert.equal(once.result.fallback, 'http-401');
  assert.equal(n, 1);
  const capped = await E.classifyWithRetry(E.inputFor(mkCase('a', 'code'), REGISTRY), { key: 'k', maxAttempts: 3, fetchImpl: async () => ({ ok: false, status: 429, headers: headers() }), sleep: async () => {} });
  assert.equal(capped.attempts, 3);
  assert.equal(capped.result.fallback, 'http-429');
});

test('runCases keeps at most the concurrency limit in flight and keeps case order', async () => {
  let live = 0;
  let peak = 0;
  const cases = Array.from({ length: 12 }, (_, i) => mkCase(`c${i}`, i % 2 ? 'code' : 'chat'));
  const rows = await E.runCases(cases, {
    registry: REGISTRY,
    concurrency: 4,
    classify: async (input, c) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise(r => setTimeout(r, 5 + (Number(c.id.slice(1)) % 3)));
      live--;
      return { result: mkResult(c.expected.route, 0.9), attempts: 1, usage: [] };
    },
  });
  assert.equal(peak, 4);
  assert.deepEqual(rows.map(r => r.case.id), cases.map(c => c.id));
  assert.equal(S.score(rows).route.accuracy, 1);
});

test('the harness scores the real case set end to end against a fake router', async () => {
  const fake = c => {
    const e = c.expected;
    const wrong = c.difficulty === 'adversarial';
    return mkResult(wrong ? 'chat' : e.route, wrong ? 0.55 : 0.92, { project: e.project, kind: e.lore_kind, fresh: e.needs_fresh ? 0.9 : 0.1, risky: e.risky_edit ? 0.9 : 0.1 });
  };
  const rows = await E.runCases(CASES, { registry: REGISTRY, classify: async (input, c) => ({ result: fake(c), attempts: 1, usage: [{ input_tokens: 1000, output_tokens: 0, model: 'jev-1.13.0' }] }) });
  const s = S.score(rows, { startedAt: 'test' });
  const adversarial = CASES.filter(c => c.difficulty === 'adversarial');
  const adversarialChat = adversarial.filter(c => c.expected.route === 'chat').length;
  assert.equal(s.count, CASES.length);
  assert.equal(s.route.byDifficulty.easy.routeAccuracy, 1);
  assert.equal(s.route.byDifficulty.adversarial.routeCorrect, adversarialChat);
  assert.equal(s.nouls.risky_edit.auroc, 1);
  assert.equal(s.nouls.needs_fresh.accuracyAt05, 1);
  assert.equal(s.cost.inputTokens, CASES.length * 1000);
  const md = S.toMarkdown(s);
  for (const h of ['## Per route', '## Confusion matrix', '## Nouls', '## Route calibration', '## Recommended execute thresholds', '## Wrong cases']) assert.ok(md.includes(h), h);
});

test('main exits with the no-key code and makes no call when no key is readable', async () => {
  const errs = [];
  let fetched = 0;
  const code = await E.main([], {
    out: () => {},
    err: m => errs.push(m),
    env: {},
    fetchImpl: async () => { fetched++; return { ok: false, status: 500 }; },
    readKey: async () => ({ key: '', source: 'keychain a/b', error: 'the Keychain item was not found' }),
  });
  assert.equal(code, E.EXIT_NO_KEY);
  assert.equal(fetched, 0);
  assert.match(errs.join('\n'), /no TypeSafe key, so no calls were made/);
});

test('main writes a JSON and a markdown report with a fake API', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-eval-'));
  try {
    const lines = [];
    const code = await E.main(['--limit', '5', '--out', dir, '--quiet'], {
      out: m => lines.push(m),
      err: m => lines.push(m),
      env: {},
      fetchImpl: async () => ({ ok: true, status: 200, headers: headers(), json: async () => answerBody('code') }),
      readKey: async () => ({ key: 'k', source: 'test' }),
    });
    assert.equal(code, 0);
    const files = fs.readdirSync(dir).sort();
    assert.equal(files.length, 2);
    assert.ok(files[0].endsWith('.json') && files[1].endsWith('.md'));
    const report = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    assert.equal(report.count, 5);
    assert.ok(Math.abs(report.cost.usd - S.PRICING['jev-1.13.0'].inputPerMtok * 5 * 1200 / 1e6) < 1e-9);
    assert.ok(report.production);
    assert.equal(report.rows.length, 5);
    assert.ok(!JSON.stringify(report).includes('"k"'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the harness sends the same request shape as the bridge', () => {
  const c = CASES.find(x => x.context && x.previous && x.previous.route);
  const req = RT.buildRequest(E.inputFor(c, REGISTRY));
  assert.equal(req.model, RT.MODEL);
  assert.equal(req.state.previous.route, c.previous.route);
  assert.deepEqual(req.state.projects.map(p => p.name), REGISTRY.map(p => p.key));
});
